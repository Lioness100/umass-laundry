import { config } from './config';
import { LaundryRepository } from './db';
import { LaundryPoller } from './poller';
import { createServer } from './server';

const repository = new LaundryRepository(config.databasePath);
const poller = new LaundryPoller(config, repository);

await poller.start();

const server = createServer(config, repository, poller);

console.log(`[server] Laundry predictor running on http://localhost:${server.port}`);
console.log(`[server] Poll interval: ${Math.round(config.pollIntervalMs / 1000)} seconds`);

async function shutdown(signal: string): Promise<void> {
	console.log(`[server] Received ${signal}. Shutting down…`);
	poller.stop();
	repository.close();
	await server.stop(true);
	process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
