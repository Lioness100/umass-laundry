import type { AppConfig } from './config';
import { hasOtaAuthConfigured } from './auth';
import type { LaundryRepository } from './db';
import { getAvailability } from './ota';

export interface PollerStatus {
	failedPolls: number;
	isPolling: boolean;
	isRunning: boolean;
	lastError: string | null;
	lastPollCompletedAt: string | null;
	lastPollStartedAt: string | null;
	lastSuccessAt: string | null;
	pollIntervalMs: number;
	successfulPolls: number;
	totalPolls: number;
}

export class LaundryPoller {
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly status: PollerStatus;

	public constructor(
		private readonly config: AppConfig,
		private readonly repository: LaundryRepository
	) {
		this.status = {
			isRunning: false,
			isPolling: false,
			pollIntervalMs: config.pollIntervalMs,
			lastPollStartedAt: null,
			lastPollCompletedAt: null,
			lastSuccessAt: repository.getLatestSuccessfulPollAt(),
			lastError: null,
			totalPolls: 0,
			successfulPolls: 0,
			failedPolls: 0
		};
	}

	public async start() {
		if (this.timer) {
			return;
		}

		if (!hasOtaAuthConfigured(this.config)) {
			this.status.lastError = 'Polling is disabled until OTA_CLIENT_ID and OTA_REFRESH_TOKEN are configured.';
			console.warn(`[poller] ${this.status.lastError}`);
			return;
		}

		this.status.isRunning = true;
		await this.pollNow();

		this.timer = setInterval(() => void this.pollNow(), this.config.pollIntervalMs);
	}

	public stop() {
		if (this.timer) {
			clearInterval(this.timer);
		}
		this.timer = null;
		this.status.isRunning = false;
	}

	public async pollNow() {
		if (this.status.isPolling) {
			return;
		}

		const pollTimestamp = new Date();
		this.status.isPolling = true;
		this.status.lastPollStartedAt = pollTimestamp.toISOString();
		this.status.totalPolls += 1;

		try {
			const rooms = await getAvailability(this.config);
			this.repository.recordPollSuccess(pollTimestamp, rooms);
			this.status.successfulPolls += 1;
			this.status.lastSuccessAt = pollTimestamp.toISOString();
			this.status.lastError = null;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.repository.recordPollError(pollTimestamp, message);
			this.status.failedPolls += 1;
			this.status.lastError = message;
			console.error(`[poller] Poll failed: ${message}`);
		} finally {
			this.status.isPolling = false;
			this.status.lastPollCompletedAt = new Date().toISOString();
		}
	}

	public getStatus() {
		return { ...this.status };
	}
}
