import { join } from 'node:path';
import { Database } from 'bun:sqlite';

const DB_PATH = join(process.cwd(), 'laundry.db');

function normalizeRoomLabel(rawLabel: string): string {
	return (rawLabel.split('-')[0] ?? '')
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
		.join(' ');
}

export function migrate() {
	console.log(`Starting migration for database: ${DB_PATH}`);
	const db = new Database(DB_PATH);

	// Use WAL mode for performance during the large transaction
	db.run('PRAGMA journal_mode = WAL;');

	db.run('BEGIN;');
	try {
		console.log('Creating new aggregated room_snapshots table…');

		db.run(`
            CREATE TABLE room_snapshots_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER NOT NULL,
                room_label TEXT NOT NULL,
                available_washers INTEGER NOT NULL,
                total_washers INTEGER NOT NULL,
                available_dryers INTEGER NOT NULL,
                total_dryers INTEGER NOT NULL,
                FOREIGN KEY (run_id) REFERENCES poll_runs(id) ON DELETE CASCADE
            );
        `);

		console.log('Loading and grouping existing rows by normalized name…');
		const rows = db.query('SELECT * FROM room_snapshots;').all() as any[];
		const grouped = new Map<string, any>();

		for (const row of rows) {
			const norm = normalizeRoomLabel(row.room_label);
			if (!norm) {
				continue;
			}

			const key = `${row.run_id}-${norm}`;
			const existing = grouped.get(key);

			if (existing) {
				existing.available_washers += row.available_washers;
				existing.total_washers += row.total_washers;
				existing.available_dryers += row.available_dryers;
				existing.total_dryers += row.total_dryers;
			} else {
				grouped.set(key, {
					run_id: row.run_id,
					room_label: norm,
					available_washers: row.available_washers,
					total_washers: row.total_washers,
					available_dryers: row.available_dryers,
					total_dryers: row.total_dryers
				});
			}
		}

		console.log('Inserting aggregated rows into new table…');
		const insertStmt = db.query(`
			INSERT INTO room_snapshots_new (
				run_id, room_label, available_washers, total_washers, available_dryers, total_dryers
			) VALUES (?, ?, ?, ?, ?, ?)
		`);

		for (const value of grouped.values()) {
			insertStmt.run(
				value.run_id,
				value.room_label,
				value.available_washers,
				value.total_washers,
				value.available_dryers,
				value.total_dryers
			);
		}

		console.log('Dropping old room_snapshots table…');
		db.run('DROP TABLE room_snapshots;');

		console.log('Renaming new table to room_snapshots…');
		db.run('ALTER TABLE room_snapshots_new RENAME TO room_snapshots;');

		console.log('Recreating indexes…');
		db.run(`
            CREATE INDEX IF NOT EXISTS idx_room_snapshots_run_id
            ON room_snapshots(run_id);
        `);

		db.run(`
            CREATE INDEX IF NOT EXISTS idx_room_snapshots_room_label
            ON room_snapshots(room_label);
        `);

		db.run('COMMIT;');
		console.log('Migration completed successfully.');
	} catch (error) {
		db.run('ROLLBACK;');
		console.error('Migration failed. Rolled back changes.', error);
		process.exit(1);
	} finally {
		db.close();
	}
}

migrate();
