// eslint-disable-next-line import/no-unresolved
import { Database } from 'bun:sqlite';
import type { LaundryRoomAvailability } from './ota';

type PollStatus = 'success' | 'error';

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

export interface CurrentAvailabilitySnapshot {
	polledAt: string;
	rooms: CurrentRoomSnapshot[];
	totals: LoadTotals;
}

export interface UsageHistoryPoint {
	dryersCapacity: number;
	dryersInUse: number;
	loadRatio: number;
	polledAt: string;
	totalCapacity: number;
	totalInUse: number;
	washersCapacity: number;
	washersInUse: number;
}

export interface BestTimeWindow {
	avgLoadRatio: number;
	dayLabel: string;
	dayOfWeek: number;
	hourLabel: string;
	hourOfDay: number;
	sampleSize: number;
}

export interface HeatmapCell {
	avgLoadRatio: number;
	dayOfWeek: number;
	hourOfDay: number;
	sampleSize: number;
}

export interface FailedPoll {
	errorMessage: string;
	polledAt: string;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ROOM_FILTER_SQL = 'AND rs.room_label = ?';

function buildLoadTotals(availability: {
	availableDryersCount: number;
	availableWashersCount: number;
	totalDryersCount: number;
	totalWashersCount: number;
}): LoadTotals {
	const washersInUse = Math.max(availability.totalWashersCount - availability.availableWashersCount, 0);
	const dryersInUse = Math.max(availability.totalDryersCount - availability.availableDryersCount, 0);
	const totalInUse = washersInUse + dryersInUse;
	const totalCapacity = availability.totalWashersCount + availability.totalDryersCount;

	return {
		availableWashers: availability.availableWashersCount,
		totalWashers: availability.totalWashersCount,
		washersInUse,
		availableDryers: availability.availableDryersCount,
		totalDryers: availability.totalDryersCount,
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
			this.db
				.query('INSERT INTO poll_runs (polled_at, polled_at_epoch, status, error_message) VALUES (?, ?, ?, ?);')
				.run(polledAtIso, polledAtEpoch, 'success' satisfies PollStatus, null);

			const idRow = this.db.query('SELECT last_insert_rowid() AS id;').get() as { id: number } | null;
			if (!idRow) {
				throw new Error('Could not read inserted run id.');
			}

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

			for (const room of rooms) {
				insertSnapshotStatement.run(
					idRow.id,
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
			.run(polledAtIso, polledAtEpoch, 'error' satisfies PollStatus, errorMessage);
	}

	public getLatestSuccessfulPollAt(): string | null {
		const row = this.db
			.query("SELECT polled_at FROM poll_runs WHERE status = 'success' ORDER BY polled_at_epoch DESC LIMIT 1;")
			.get() as { polled_at: string } | null;
		return row?.polled_at ?? null;
	}

	public getDistinctRooms(): string[] {
		const rows = this.db.query('SELECT DISTINCT room_label FROM room_snapshots ORDER BY room_label ASC;').all() as {
			room_label: string;
		}[];
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
			.all(latestRun.id) as {
			available_dryers: number;
			available_washers: number;
			room_label: string;
			total_dryers: number;
			total_washers: number;
		}[];

		const rooms = rows.map((row) => {
			const loadTotals = buildLoadTotals({
				availableWashersCount: row.available_washers,
				totalWashersCount: row.total_washers,
				availableDryersCount: row.available_dryers,
				totalDryersCount: row.total_dryers
			});

			return {
				label: row.room_label,
				...loadTotals
			};
		});

		const totals = rooms.reduce<LoadTotals>(
			(acc, room) => ({
				availableWashers: acc.availableWashers + room.availableWashers,
				totalWashers: acc.totalWashers + room.totalWashers,
				washersInUse: acc.washersInUse + room.washersInUse,
				availableDryers: acc.availableDryers + room.availableDryers,
				totalDryers: acc.totalDryers + room.totalDryers,
				dryersInUse: acc.dryersInUse + room.dryersInUse,
				totalInUse: acc.totalInUse + room.totalInUse,
				totalCapacity: acc.totalCapacity + room.totalCapacity,
				loadRatio: 0
			}),
			{
				availableWashers: 0,
				totalWashers: 0,
				washersInUse: 0,
				availableDryers: 0,
				totalDryers: 0,
				dryersInUse: 0,
				totalInUse: 0,
				totalCapacity: 0,
				loadRatio: 0
			}
		);

		totals.loadRatio = totals.totalCapacity === 0 ? 0 : totals.totalInUse / totals.totalCapacity;

		return {
			polledAt: latestRun.polled_at,
			rooms,
			totals
		};
	}

	public getUsageHistory(hours: number, roomLabel?: string): UsageHistoryPoint[] {
		const secondsBack = Math.floor(hours * 3600);
		const roomFilterSql = roomLabel ? ROOM_FILTER_SQL : '';
		const query = `
			SELECT
				pr.polled_at,
				SUM(rs.total_washers - rs.available_washers) AS washers_in_use,
				SUM(rs.total_washers) AS washers_capacity,
				SUM(rs.total_dryers - rs.available_dryers) AS dryers_in_use,
				SUM(rs.total_dryers) AS dryers_capacity
			FROM poll_runs pr
			INNER JOIN room_snapshots rs ON rs.run_id = pr.id
			WHERE pr.status = 'success'
			AND pr.polled_at_epoch >= strftime('%s', 'now') - ?
			${roomFilterSql}
			GROUP BY pr.id, pr.polled_at, pr.polled_at_epoch
			ORDER BY pr.polled_at_epoch ASC;
		`;

		const rows = roomLabel
			? (this.db.query(query).all(secondsBack, roomLabel) as {
					dryers_capacity: number;
					dryers_in_use: number;
					polled_at: string;
					washers_capacity: number;
					washers_in_use: number;
				}[])
			: (this.db.query(query).all(secondsBack) as {
					dryers_capacity: number;
					dryers_in_use: number;
					polled_at: string;
					washers_capacity: number;
					washers_in_use: number;
				}[]);

		return rows.map((row) => {
			const washersInUse = Number(row.washers_in_use) || 0;
			const washersCapacity = Number(row.washers_capacity) || 0;
			const dryersInUse = Number(row.dryers_in_use) || 0;
			const dryersCapacity = Number(row.dryers_capacity) || 0;
			const totalInUse = washersInUse + dryersInUse;
			const totalCapacity = washersCapacity + dryersCapacity;

			return {
				polledAt: row.polled_at,
				washersInUse,
				washersCapacity,
				dryersInUse,
				dryersCapacity,
				totalInUse,
				totalCapacity,
				loadRatio: totalCapacity === 0 ? 0 : totalInUse / totalCapacity
			};
		});
	}

	public getBestTimeWindows(days: number, limit: number, roomLabel?: string): BestTimeWindow[] {
		const secondsBack = Math.floor(days * 24 * 3600);
		const roomFilterSql = roomLabel ? ROOM_FILTER_SQL : '';
		const query = `
			WITH run_loads AS (
				SELECT
					pr.id AS run_id,
					pr.polled_at_epoch AS polled_at_epoch,
					SUM(rs.total_washers - rs.available_washers + rs.total_dryers - rs.available_dryers) AS total_in_use,
					SUM(rs.total_washers + rs.total_dryers) AS total_capacity
				FROM poll_runs pr
				INNER JOIN room_snapshots rs ON rs.run_id = pr.id
				WHERE pr.status = 'success'
				AND pr.polled_at_epoch >= strftime('%s', 'now') - ?
				${roomFilterSql}
				GROUP BY pr.id, pr.polled_at_epoch
				HAVING total_capacity > 0
			)
			SELECT
				CAST(strftime('%w', polled_at_epoch, 'unixepoch') AS INTEGER) AS day_of_week,
				CAST(strftime('%H', polled_at_epoch, 'unixepoch') AS INTEGER) AS hour_of_day,
				AVG(CAST(total_in_use AS REAL) / total_capacity) AS avg_load_ratio,
				COUNT(*) AS sample_size
			FROM run_loads
			GROUP BY day_of_week, hour_of_day
			HAVING COUNT(*) >= 2
			ORDER BY avg_load_ratio ASC, sample_size DESC
			LIMIT ?;
		`;

		const rows = roomLabel
			? (this.db.query(query).all(secondsBack, roomLabel, limit) as {
					avg_load_ratio: number;
					day_of_week: number;
					hour_of_day: number;
					sample_size: number;
				}[])
			: (this.db.query(query).all(secondsBack, limit) as {
					avg_load_ratio: number;
					day_of_week: number;
					hour_of_day: number;
					sample_size: number;
				}[]);

		return rows.map((row) => {
			const dayOfWeek = Number(row.day_of_week);
			const hourOfDay = Number(row.hour_of_day);

			return {
				dayOfWeek,
				dayLabel: DAY_LABELS[dayOfWeek] ?? String(dayOfWeek),
				hourOfDay,
				hourLabel: asHourLabel(hourOfDay),
				avgLoadRatio: Number(row.avg_load_ratio) || 0,
				sampleSize: Number(row.sample_size) || 0
			};
		});
	}

	public getLoadHeatmap(days: number, roomLabel?: string): HeatmapCell[] {
		const secondsBack = Math.floor(days * 24 * 3600);
		const roomFilterSql = roomLabel ? ROOM_FILTER_SQL : '';
		const query = `
			WITH run_loads AS (
				SELECT
					pr.id AS run_id,
					pr.polled_at_epoch AS polled_at_epoch,
					SUM(rs.total_washers - rs.available_washers + rs.total_dryers - rs.available_dryers) AS total_in_use,
					SUM(rs.total_washers + rs.total_dryers) AS total_capacity
				FROM poll_runs pr
				INNER JOIN room_snapshots rs ON rs.run_id = pr.id
				WHERE pr.status = 'success'
				AND pr.polled_at_epoch >= strftime('%s', 'now') - ?
				${roomFilterSql}
				GROUP BY pr.id, pr.polled_at_epoch
				HAVING total_capacity > 0
			)
			SELECT
				CAST(strftime('%w', polled_at_epoch, 'unixepoch') AS INTEGER) AS day_of_week,
				CAST(strftime('%H', polled_at_epoch, 'unixepoch') AS INTEGER) AS hour_of_day,
				AVG(CAST(total_in_use AS REAL) / total_capacity) AS avg_load_ratio,
				COUNT(*) AS sample_size
			FROM run_loads
			GROUP BY day_of_week, hour_of_day
			ORDER BY day_of_week ASC, hour_of_day ASC;
		`;

		const rows = roomLabel
			? (this.db.query(query).all(secondsBack, roomLabel) as {
					avg_load_ratio: number;
					day_of_week: number;
					hour_of_day: number;
					sample_size: number;
				}[])
			: (this.db.query(query).all(secondsBack) as {
					avg_load_ratio: number;
					day_of_week: number;
					hour_of_day: number;
					sample_size: number;
				}[]);

		return rows.map((row) => ({
			dayOfWeek: Number(row.day_of_week),
			hourOfDay: Number(row.hour_of_day),
			avgLoadRatio: Number(row.avg_load_ratio) || 0,
			sampleSize: Number(row.sample_size) || 0
		}));
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
			.map((row) => ({
				polledAt: row.polled_at,
				errorMessage: row.error_message!
			}));
	}

	public close(): void {
		this.db.close();
	}
}
