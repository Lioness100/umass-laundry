# laundry-predictor

Laundry polling + analytics dashboard for finding the quietest windows to run washer/dryer loads.

## What This App Does

- Polls One Tap Away room availability on a configurable interval.
- Stores every poll in SQLite (successes and failures).
- Computes analytics like average load, best time windows, and weekly heatmaps.
- Serves a responsive web dashboard for monitoring and decision-making.

## Quick Start

Install dependencies:

```bash
bun install
```

Create an environment file (see `.env.example`):

```bash
cp .env.example .env
```

Then start:

```bash
bun start
```

For local development with auto-reload:

```bash
bun run dev
```

Open the dashboard at `http://localhost:3000`.

## Required Environment Variables

Polling uses Cognito refresh-token flow and requires:

- `OTA_CLIENT_ID`
- `OTA_REFRESH_TOKEN`

The app calls `AWSCognitoIdentityProviderService.GetTokensFromRefreshToken` to obtain fresh tokens, then sends the returned `IdToken` (falls back to `AccessToken` if `IdToken` is missing) to the OTA API.

If your user pool client has refresh-token rotation enabled, set `OTA_REFRESH_TOKEN_STATE_PATH` so newly rotated refresh tokens are persisted and reused after restarts.

## Optional Environment Variables

- `PORT` (default: `3000`)
- `DATABASE_PATH` (default: `laundry.db`)
- `POLL_INTERVAL_MINUTES` (default: `5`)
- `REQUEST_TIMEOUT_MS` (default: `15000`)
- `OTA_API_URL` (default: One Tap Away endpoint)
- `OTA_AS400_ID` (default: `1903627`)
- `OTA_CLIENT_SECRET` (optional Cognito app client secret)
- `OTA_COGNITO_REGION` (default: `us-east-1`)
- `OTA_COGNITO_ENDPOINT` (default: derived from region, e.g. `https://cognito-idp.us-east-1.amazonaws.com`)
- `OTA_CONNECTED_TECHNOLOGY` (default: `PR`)
- `OTA_DEVICE_KEY` (optional, for pools with device remembering)
- `OTA_REFRESH_TOKEN_STATE_PATH` (optional file path to persist rotated refresh tokens)
- `OTA_SERVICE_ID` (default: `489`)

## API Endpoints

- `GET /api/health`
- `POST /api/poll-now`
- `GET /api/current`
- `GET /api/dashboard?days=21&hours=72&room=`

## Data Model (SQLite)

- `poll_runs`: one row per poll attempt
- `room_snapshots`: room-level washer/dryer availability per successful poll
