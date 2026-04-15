import type { AppConfig } from './config';
import { getOtaAuthorizationHeader } from './auth';

interface AvailabilityResponse {
	rooms: LaundryRoomAvailability[];
}

export interface LaundryRoomAvailability {
	availableDryersCount: number;
	availableWashersCount: number;
	label: string;
	totalDryersCount: number;
	totalWashersCount: number;
}

export async function getAvailability(config: AppConfig) {
	const authorizationHeader = await getOtaAuthorizationHeader(config);

	const body = {
		action: 'roomsAvailability',
		as400Id: '1903627',
		connectedTechnology: 'PR',
		serviceId: 489
	};

	const response = await fetch('https://api.portal.onetapaway.com/resident/api/order-flow', {
		method: 'POST',
		headers: {
			Authorization: authorizationHeader,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(config.requestTimeoutMs)
	});

	if (!response.ok) {
		const responseBody = await response.text();
		throw new Error(`OTA API request failed: ${response.status} ${response.statusText} - ${responseBody}`);
	}

	const data: AvailabilityResponse = await response.json();
	return data.rooms;
}
