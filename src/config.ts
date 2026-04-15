interface NumberEnvOptions {
	defaultValue: number;
	max?: number;
	min?: number;
}

function parseNumberEnv(name: string, options: NumberEnvOptions): number {
	const rawValue = Bun.env[name];
	if (!rawValue) {
		return options.defaultValue;
	}

	const parsed = Number(rawValue);
	if (!Number.isFinite(parsed)) {
		throw new TypeError(`${name} must be a number.`);
	}
	if (options.min !== undefined && parsed < options.min) {
		throw new Error(`${name} must be >= ${options.min}.`);
	}
	if (options.max !== undefined && parsed > options.max) {
		throw new Error(`${name} must be <= ${options.max}.`);
	}

	return parsed;
}

export interface AppConfig {
	databasePath: string;
	otaClientId: string;
	otaRefreshToken: string | null;
	otaRefreshTokenStatePath: string | null;
	pollIntervalMs: number;
	port: number;
	requestTimeoutMs: number;
}

const pollIntervalMinutes = parseNumberEnv('POLL_INTERVAL_MINUTES', {
	defaultValue: 5,
	min: 1,
	max: 60
});

const requestTimeoutMs = parseNumberEnv('REQUEST_TIMEOUT_MS', {
	defaultValue: 15_000,
	min: 1000,
	max: 120_000
});

const port = parseNumberEnv('PORT', {
	defaultValue: 3000,
	min: 1,
	max: 65_535
});

export const config: AppConfig = {
	port,
	databasePath: Bun.env.DATABASE_PATH ?? 'laundry.db',
	pollIntervalMs: pollIntervalMinutes * 60 * 1000,
	requestTimeoutMs,
	otaClientId: Bun.env.OTA_CLIENT_ID!,
	otaRefreshToken: Bun.env.OTA_REFRESH_TOKEN ?? null,
	otaRefreshTokenStatePath: Bun.env.OTA_REFRESH_TOKEN_STATE_PATH ?? null
};
