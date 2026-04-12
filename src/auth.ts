import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AppConfig } from './config';

interface CognitoAuthenticationResult {
	AccessToken?: string;
	ExpiresIn?: number;
	IdToken?: string;
	RefreshToken?: string;
	TokenType?: string;
}

interface CognitoGetTokensResponse {
	__type?: string;
	AuthenticationResult?: CognitoAuthenticationResult;
	message?: string;
}

interface CognitoTokenSet {
	accessToken: string;
	expiresAtMs: number;
	idToken: string | null;
	refreshToken: string;
	tokenType: string;
}

const COGNITO_TOKEN_LEEWAY_MS = 60_000;
const COGNITO_API_URL = 'https://cognito-idp.us-east-1.amazonaws.com';

let cachedCognitoTokenSet: CognitoTokenSet | null = null;
let inFlightCognitoRefresh: Promise<CognitoTokenSet> | null = null;
let persistedRefreshTokenPromise: Promise<string | null> | null = null;
let rotatedRefreshToken: string | null = null;

async function loadRefreshTokenFromStatePath(config: AppConfig): Promise<string | null> {
	if (!config.otaRefreshTokenStatePath) {
		return null;
	}

	const stateFile = Bun.file(config.otaRefreshTokenStatePath);
	if (!(await stateFile.exists())) {
		return null;
	}

	const persistedToken = (await stateFile.text()).trim();
	return persistedToken.length > 0 ? persistedToken : null;
}

function getPersistedRefreshToken(config: AppConfig): Promise<string | null> {
	if (persistedRefreshTokenPromise === null) {
		persistedRefreshTokenPromise = loadRefreshTokenFromStatePath(config);
	}

	return persistedRefreshTokenPromise;
}

async function persistRefreshTokenToStatePath(config: AppConfig, refreshToken: string): Promise<void> {
	if (!config.otaRefreshTokenStatePath) {
		return;
	}

	await mkdir(dirname(config.otaRefreshTokenStatePath), { recursive: true });
	await Bun.write(config.otaRefreshTokenStatePath, `${refreshToken}\n`);
}

async function getEffectiveRefreshToken(config: AppConfig): Promise<string | null> {
	if (rotatedRefreshToken !== null) {
		return rotatedRefreshToken;
	}

	const persistedToken = await getPersistedRefreshToken(config);
	if (persistedToken !== null) {
		return persistedToken;
	}

	return config.otaRefreshToken;
}

function getCachedAuthorizationHeader(): string | null {
	if (!cachedCognitoTokenSet) {
		return null;
	}

	if (Date.now() + COGNITO_TOKEN_LEEWAY_MS >= cachedCognitoTokenSet.expiresAtMs) {
		return null;
	}

	const selectedToken = cachedCognitoTokenSet.idToken ?? cachedCognitoTokenSet.accessToken;
	return `${cachedCognitoTokenSet.tokenType} ${selectedToken}`;
}

async function requestTokensFromRefreshToken(config: AppConfig): Promise<CognitoTokenSet> {
	if (!config.otaClientId) {
		throw new Error('Missing OTA_CLIENT_ID for Cognito refresh flow.');
	}

	const effectiveRefreshToken = await getEffectiveRefreshToken(config);
	if (!effectiveRefreshToken) {
		throw new Error('Missing OTA_REFRESH_TOKEN for Cognito refresh flow.');
	}

	const requestBody = { ClientId: config.otaClientId, RefreshToken: effectiveRefreshToken };
	const response = await fetch(COGNITO_API_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-amz-json-1.1',
			'X-Amz-Target': 'AWSCognitoIdentityProviderService.GetTokensFromRefreshToken'
		},
		body: JSON.stringify(requestBody),
		signal: AbortSignal.timeout(config.requestTimeoutMs)
	});

	if (!response.ok) {
		const bodyText = await response.text();
		throw new Error(`Cognito token refresh failed: ${response.status} ${response.statusText} - ${bodyText}`);
	}

	const parsedBody = (await response.json()) as CognitoGetTokensResponse;
	const authResult = parsedBody.AuthenticationResult;
	if (!authResult || typeof authResult.AccessToken !== 'string') {
		const awsError = parsedBody.message ?? parsedBody.__type ?? 'Unknown Cognito response';
		throw new Error(`Cognito token refresh returned no access token (${awsError}).`);
	}

	const expiresInSeconds =
		typeof authResult.ExpiresIn === 'number' && Number.isFinite(authResult.ExpiresIn) ? authResult.ExpiresIn : 3600;
	const refreshedToken =
		typeof authResult.RefreshToken === 'string' ? authResult.RefreshToken : effectiveRefreshToken;
	const expiresInMs = expiresInSeconds * 1000;

	rotatedRefreshToken = refreshedToken;
	persistedRefreshTokenPromise = Promise.resolve(refreshedToken);
	if (refreshedToken !== effectiveRefreshToken) {
		try {
			await persistRefreshTokenToStatePath(config, refreshedToken);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`[auth] Failed to persist rotated refresh token: ${message}`);
		}
	}

	return {
		accessToken: authResult.AccessToken,
		expiresAtMs: Date.now() + expiresInMs,
		idToken: typeof authResult.IdToken === 'string' ? authResult.IdToken : null,
		refreshToken: refreshedToken,
		tokenType: authResult.TokenType ?? 'Bearer'
	};
}

export function hasOtaAuthConfigured(config: AppConfig): boolean {
	const hasRefreshSource = config.otaRefreshToken !== null || config.otaRefreshTokenStatePath !== null;
	return config.otaClientId !== null && hasRefreshSource;
}

export async function getOtaAuthorizationHeader(config: AppConfig): Promise<string> {
	const cachedAuthorizationHeader = getCachedAuthorizationHeader();
	if (cachedAuthorizationHeader) {
		return cachedAuthorizationHeader;
	}

	if (inFlightCognitoRefresh === null) {
		const refreshPromise = requestTokensFromRefreshToken(config);
		inFlightCognitoRefresh = refreshPromise;
		void refreshPromise.finally(() => {
			if (inFlightCognitoRefresh === refreshPromise) {
				inFlightCognitoRefresh = null;
			}
		});
	}

	if (inFlightCognitoRefresh === null) {
		throw new Error('Cognito refresh flow could not be started.');
	}

	const refreshedTokenSet = await inFlightCognitoRefresh;
	cachedCognitoTokenSet = refreshedTokenSet;

	const selectedToken = refreshedTokenSet.idToken ?? refreshedTokenSet.accessToken;
	return `${refreshedTokenSet.tokenType} ${selectedToken}`;
}
