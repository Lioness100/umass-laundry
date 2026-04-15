/* eslint-disable @typescript-eslint/naming-convention */
// eslint-disable-next-line import/no-unresolved
import { Database } from 'bun:sqlite';
import type { LaundryRoomAvailability } from './ota';

enum PollStatus {
	Error = 'error',
	Success = 'success'
}

export interface LoadTotals {
	availableDryers: number;
	availableWashers: number;
	dryersInUse: number;
	loadRatio: number;
	totalCapacity: number;
	totalDryers: number;
	totalInUse: number;
	totalWashers: number;
	washersInUse: number;
}

export interface CurrentRoomSnapshot extends LoadTotals {
	label: string;
}

export interface UsageHistoryPoint extends LoadTotals {
	polledAt: string;
}

export interface CurrentAvailabilitySnapshot {
	polledAt: string;
	rooms: CurrentRoomSnapshot[];
	totals: LoadTotals;
}

export interface HeatmapCell {
	avgLoadRatio: number;
	dayOfWeek: number;
	hourOfDay: number;
	sampleSize: number;
}

export interface BestTimeWindow extends HeatmapCell {
	dayLabel: string;
	hourLabel: string;
}

export interface FailedPoll {
	errorMessage: string;
	polledAt: string;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface DbCapacityRow {
	available_dryers: number;
	available_washers: number;
	total_dryers: number;
	total_washers: number;
}

function normalizeRoomLabel(rawLabel: string): string {
	return (rawLabel.split('-')[0] ?? '')
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
		.join(' ');
}

function buildLoadTotals(row: DbCapacityRow): LoadTotals {
	const washersInUse = row.total_washers - row.available_washers;
	const dryersInUse = row.total_dryers - row.available_dryers;
	const totalInUse = washersInUse + dryersInUse;
	const totalCapacity = row.total_washers + row.total_dryers;

	return {
		availableWashers: row.available_washers,
		totalWashers: row.total_washers,
		washersInUse,
		availableDryers: row.available_dryers,
		totalDryers: row.total_dryers,
		dryersInUse,
		totalInUse,
		totalCapacity,
		loadRatio: totalCapacity === 0 ? 0 : totalInUse / totalCapacity
	};
}

function asHourLabel(hour: number): string {
	const suffix = hour >= 12 ? 'PM' : 'AM';
	const normalizedHour = hour % 12 === 0 ? 12 : hour % 12;
	return `${normalizedHour}:00 ${suffix}`;
}

function aggregateTimeSlots(history: UsageHistoryPoint[]): HeatmapCell[] {
	const slots = new Map<string, { dayOfWeek: number; hourOfDay: number; sampleSize: number; sumLoadRatio: number }>();

	for (const point of history) {
		const polledAt = new Date(point.polledAt);
		const dayOfWeek = polledAt.getDay();
		const hourOfDay = polledAt.getHours();
		const key = `${dayOfWeek}-${hourOfDay}`;

		const existing = slots.get(key) ?? { dayOfWeek, hourOfDay, sampleSize: 0, sumLoadRatio: 0 };
		existing.sampleSize++;
		existing.sumLoadRatio += point.loadRatio;
		slots.set(key, existing);
	}

	return [...slots.values()].map((slot) => ({
		dayOfWeek: slot.dayOfWeek,
		hourOfDay: slot.hourOfDay,
		sampleSize: slot.sampleSize,
		avgLoadRatio: slot.sumLoadRatio / slot.sampleSize
	}));
}

export class LaundryRepository {
	private readonly db: Database;

	public constructor(databasePath: string) {
		this.db = new Database(databasePath);
		this.initializeSchema();
	}

	private initializeSchema(): void {
		this.db.run('PRAGMA journal_mode = WAL;');
		this.db.run('PRAGMA foreign_keys = ON;');

		this.db.run(`
			CREATE TABLE IF NOT EXISTS poll_runs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				polled_at TEXT NOT NULL,
				polled_at_epoch INTEGER NOT NULL,
				status TEXT NOT NULL,
				error_message TEXT
			);

			CREATE TABLE IF NOT EXISTS room_snapshots (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id INTEGER NOT NULL,
				room_label TEXT NOT NULL,
				available_washers INTEGER NOT NULL,
				total_washers INTEGER NOT NULL,
				available_dryers INTEGER NOT NULL,
				total_dryers INTEGER NOT NULL,
				FOREIGN KEY (run_id) REFERENCES poll_runs(id) ON DELETE CASCADE
			);

			CREATE INDEX IF NOT EXISTS idx_poll_runs_polled_at_epoch
			ON poll_runs(polled_at_epoch DESC);

			CREATE INDEX IF NOT EXISTS idx_room_snapshots_run_id
			ON room_snapshots(run_id);

			CREATE INDEX IF NOT EXISTS idx_room_snapshots_room_label
			ON room_snapshots(room_label);
		`);
	}

	public recordPollSuccess(polledAt: Date, rooms: LaundryRoomAvailability[]): void {
		const polledAtIso = polledAt.toISOString();
		const polledAtEpoch = Math.floor(polledAt.getTime() / 1000);

		this.db.run('BEGIN;');
		try {
			const { lastInsertRowid } = this.db
				.query('INSERT INTO poll_runs (polled_at, polled_at_epoch, status, error_message) VALUES (?, ?, ?, ?);')
				.run(polledAtIso, polledAtEpoch, PollStatus.Success, null);

			const insertSnapshotStatement = this.db.query(
				`INSERT INTO room_snapshots (
					run_id,
					room_label,
					available_washers,
					total_washers,
					available_dryers,
					total_dryers
				) VALUES (?, ?, ?, ?, ?, ?);`
			);

			const mergedByRoom = new Map<string, LaundryRoomAvailability>();

			for (const room of rooms) {
				const normalizedLabel = normalizeRoomLabel(room.label);
				if (!normalizedLabel || !room.totalWashersCount) {
					continue;
				}

				const existing = mergedByRoom.get(normalizedLabel);
				if (existing) {
					existing.availableWashersCount += room.availableWashersCount;
					existing.totalWashersCount += room.totalWashersCount;
					existing.availableDryersCount += room.availableDryersCount;
					existing.totalDryersCount += room.totalDryersCount;
				} else {
					mergedByRoom.set(normalizedLabel, { ...room, label: normalizedLabel });
				}
			}

			for (const room of mergedByRoom.values()) {
				insertSnapshotStatement.run(
					lastInsertRowid,
					room.label,
					room.availableWashersCount,
					room.totalWashersCount,
					room.availableDryersCount,
					room.totalDryersCount
				);
			}

			this.db.run('COMMIT;');
		} catch (error) {
			this.db.run('ROLLBACK;');
			throw error;
		}
	}

	public recordPollError(polledAt: Date, errorMessage: string): void {
		const polledAtIso = polledAt.toISOString();
		const polledAtEpoch = Math.floor(polledAt.getTime() / 1000);
		this.db
			.query('INSERT INTO poll_runs (polled_at, polled_at_epoch, status, error_message) VALUES (?, ?, ?, ?);')
			.run(polledAtIso, polledAtEpoch, PollStatus.Error, errorMessage);
	}

	public getLatestSuccessfulPollAt(): string | null {
		const row = this.db
			.query("SELECT polled_at FROM poll_runs WHERE status = 'success' ORDER BY polled_at_epoch DESC LIMIT 1;")
			.get() as { polled_at: string } | null;
		return row?.polled_at ?? null;
	}

	public getDistinctRooms(): string[] {
		const rows = this.db
			.query(
				'SELECT DISTINCT room_label FROM room_snapshots WHERE total_washers + total_dryers > 0 ORDER BY room_label ASC;'
			)
			.all() as { room_label: string }[];

		return rows.map((row) => row.room_label);
	}

	public getCurrentAvailability(): CurrentAvailabilitySnapshot | null {
		const latestRun = this.db
			.query(
				"SELECT id, polled_at FROM poll_runs WHERE status = 'success' ORDER BY polled_at_epoch DESC LIMIT 1;"
			)
			.get() as { id: number; polled_at: string } | null;

		if (!latestRun) {
			return null;
		}

		const rows = this.db
			.query(
				`SELECT
					room_label,
					available_washers,
					total_washers,
					available_dryers,
					total_dryers
				FROM room_snapshots
				WHERE run_id = ?
				ORDER BY room_label ASC;`
			)
			.all(latestRun.id) as (DbCapacityRow & { room_label: string })[];

		const rooms: CurrentRoomSnapshot[] = [];
		const totalCounts: DbCapacityRow = {
			available_washers: 0,
			total_washers: 0,
			available_dryers: 0,
			total_dryers: 0
		};

		for (const row of rows) {
			rooms.push({ label: row.room_label, ...buildLoadTotals(row) });
			totalCounts.available_washers += row.available_washers;
			totalCounts.total_washers += row.total_washers;
			totalCounts.available_dryers += row.available_dryers;
			totalCounts.total_dryers += row.total_dryers;
		}

		return { polledAt: latestRun.polled_at, rooms, totals: buildLoadTotals(totalCounts) };
	}

	public getUsageHistory(hours: number, roomLabel?: string): UsageHistoryPoint[] {
		const secondsBack = Math.floor(hours * 3600);
		const normalizedRoomLabel = roomLabel ? normalizeRoomLabel(roomLabel) : null;

		let query = `
			SELECT
				pr.polled_at,
				SUM(rs.available_washers) AS available_washers,
				SUM(rs.total_washers) AS total_washers,
				SUM(rs.available_dryers) AS available_dryers,
				SUM(rs.total_dryers) AS total_dryers
			FROM poll_runs pr
			INNER JOIN room_snapshots rs ON rs.run_id = pr.id
			WHERE pr.status = 'success'
			AND pr.polled_at_epoch >= strftime('%s', 'now') - ?
		`;

		const params: (number | string)[] = [secondsBack];

		if (normalizedRoomLabel) {
			query += ` AND rs.room_label = ?\n`;
			params.push(normalizedRoomLabel);
		}

		query += ` GROUP BY pr.id ORDER BY pr.polled_at_epoch ASC, pr.id ASC;`;

		const rows = this.db.query(query).all(...params) as (DbCapacityRow & { polled_at: string })[];

		return rows.map((row) => ({ polledAt: row.polled_at, ...buildLoadTotals(row) }));
	}

	public getBestTimeWindows(days: number, limit: number, roomLabel?: string): BestTimeWindow[] {
		return aggregateTimeSlots(this.getUsageHistory(days * 24, roomLabel))
			.filter((slot) => slot.sampleSize >= 2)
			.sort(
				(left, right) =>
					left.avgLoadRatio - right.avgLoadRatio ||
					right.sampleSize - left.sampleSize ||
					left.dayOfWeek - right.dayOfWeek ||
					left.hourOfDay - right.hourOfDay
			)
			.slice(0, limit)
			.map((slot) => ({
				...slot,
				dayLabel: DAY_LABELS[slot.dayOfWeek] ?? String(slot.dayOfWeek),
				hourLabel: asHourLabel(slot.hourOfDay)
			}));
	}

	public getLoadHeatmap(days: number, roomLabel?: string): HeatmapCell[] {
		return aggregateTimeSlots(this.getUsageHistory(days * 24, roomLabel)).sort(
			(left, right) => left.dayOfWeek - right.dayOfWeek || left.hourOfDay - right.hourOfDay
		);
	}

	public getRecentFailures(limit = 10): FailedPoll[] {
		const rows = this.db
			.query(
				`SELECT polled_at, error_message
				FROM poll_runs
				WHERE status = 'error'
				ORDER BY polled_at_epoch DESC
				LIMIT ?;`
			)
			.all(limit) as { error_message: string | null; polled_at: string }[];

		return rows
			.filter((row) => typeof row.error_message === 'string' && row.error_message.length > 0)
			.map((row) => ({ polledAt: row.polled_at, errorMessage: row.error_message! }));
	}

	public close(): void {
		this.db.close();
	}
}
