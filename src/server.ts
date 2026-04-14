import type { AppConfig } from './config';
import type {
	BestTimeWindow,
	CurrentAvailabilitySnapshot,
	FailedPoll,
	HeatmapCell,
	LaundryRepository,
	UsageHistoryPoint
} from './db';
import type { LaundryPoller, PollerStatus } from './poller';

interface DashboardSummary {
	averageLoadRatio: number;
	latestLoadRatio: number | null;
	maxLoadRatio: number;
	minLoadRatio: number;
	recentTrendDelta: number | null;
	samples: number;
}

interface DashboardResponse {
	bestTimes: BestTimeWindow[];
	current: CurrentAvailabilitySnapshot | null;
	generatedAt: string;
	heatmap: HeatmapCell[];
	history: UsageHistoryPoint[];
	pollerStatus: PollerStatus;
	query: {
		days: number;
		hours: number;
		room: string | null;
	};
	recentFailures: FailedPoll[];
	rooms: string[];
	summary: DashboardSummary;
}

function asJsonResponse(payload: unknown, status = 200) {
	return Response.json(payload, {
		status,
		headers: { 'Cache-Control': 'no-store' }
	});
}

function parseClampedInt(value: string | null, fallback: number, min: number, max: number): number {
	if (!value) {
		return fallback;
	}

	const parsed = Number.parseInt(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}

	if (parsed < min) {
		return min;
	}

	if (parsed > max) {
		return max;
	}

	return parsed;
}

function computeSummary(history: UsageHistoryPoint[]): DashboardSummary {
	if (history.length === 0) {
		return {
			samples: 0,
			averageLoadRatio: 0,
			minLoadRatio: 0,
			maxLoadRatio: 0,
			latestLoadRatio: null,
			recentTrendDelta: null
		};
	}

	let sum = 0;
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;

	for (const point of history) {
		sum += point.loadRatio;
		min = Math.min(min, point.loadRatio);
		max = Math.max(max, point.loadRatio);
	}

	const latest = history.at(-1)?.loadRatio ?? null;
	const sampleWindowSize = Math.min(12, history.length);
	const recentWindow = history.slice(-sampleWindowSize);
	const previousWindow = history.slice(-sampleWindowSize * 2, -sampleWindowSize);

	const recentAverage =
		recentWindow.reduce((acc, point) => acc + point.loadRatio, 0) / Math.max(recentWindow.length, 1);
	const previousAverage =
		previousWindow.length === 0
			? null
			: previousWindow.reduce((acc, point) => acc + point.loadRatio, 0) / previousWindow.length;

	return {
		samples: history.length,
		averageLoadRatio: sum / history.length,
		minLoadRatio: min,
		maxLoadRatio: max,
		latestLoadRatio: latest,
		recentTrendDelta: previousAverage === null ? null : recentAverage - previousAverage
	};
}

async function serveStatic(pathname: string): Promise<Response | null> {
	const normalizedPath = pathname === '/' ? '/index.html' : pathname;
	if (!normalizedPath.startsWith('/') || normalizedPath.includes('..')) {
		return null;
	}

	const file = Bun.file(`public${normalizedPath}`);
	if (!(await file.exists())) {
		return null;
	}

	return new Response(file);
}

export function createServer(config: AppConfig, repository: LaundryRepository, poller: LaundryPoller): Bun.Server {
	return Bun.serve({
		port: config.port,
		async fetch(request: Request): Promise<Response> {
			const url = new URL(request.url);
			const { pathname } = url;
			const { searchParams } = url;

			if (pathname === '/api/health' && request.method === 'GET') {
				return asJsonResponse({
					ok: true,
					generatedAt: new Date().toISOString(),
					lastSuccessfulPollAt: repository.getLatestSuccessfulPollAt(),
					pollerStatus: poller.getStatus()
				});
			}

			if (pathname === '/api/poll-now' && request.method === 'POST') {
				await poller.pollNow();
				return asJsonResponse({
					ok: true,
					message: 'Poll triggered.',
					pollerStatus: poller.getStatus()
				});
			}

			if (pathname === '/api/current' && request.method === 'GET') {
				return asJsonResponse({
					current: repository.getCurrentAvailability(),
					rooms: repository.getDistinctRooms()
				});
			}

			if (pathname === '/api/dashboard' && request.method === 'GET') {
				const days = parseClampedInt(searchParams.get('days'), 21, 1, 90);
				const hours = parseClampedInt(searchParams.get('hours'), 72, 1, 24 * 30);

				const rooms = repository.getDistinctRooms();
				const requestedRoom = searchParams.get('room')?.trim() ?? null;
				const selectedRoom = requestedRoom && rooms.includes(requestedRoom) ? requestedRoom : null;

				const history = repository.getUsageHistory(hours, selectedRoom ?? undefined);
				const bestTimes = repository.getBestTimeWindows(days, 3, selectedRoom ?? undefined);
				const heatmap = repository.getLoadHeatmap(days, selectedRoom ?? undefined);
				const current = repository.getCurrentAvailability();
				const summary = computeSummary(history);
				const recentFailures = repository.getRecentFailures(8);

				const payload: DashboardResponse = {
					generatedAt: new Date().toISOString(),
					query: {
						days,
						hours,
						room: selectedRoom
					},
					pollerStatus: poller.getStatus(),
					current,
					history,
					bestTimes,
					heatmap,
					summary,
					rooms,
					recentFailures
				};

				return asJsonResponse(payload);
			}

			const staticResponse = await serveStatic(pathname);
			if (staticResponse) {
				return staticResponse;
			}

			return asJsonResponse({ ok: false, error: `Route not found: ${pathname}` }, 404);
		}
	});
}
