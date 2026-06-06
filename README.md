# LiveKit Meeting API

API is the runtime service for clients. It validates invite codes, generates LiveKit tokens, manages rooms, and exposes compatibility routes for existing clients.

## Required environment variables

- `DATABASE_URL`
- `LIVEKIT_HOST`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `API_SECRET`

## Optional environment variables

- `PORT`
- `HEALTH_CHECK_INTERVAL`
- `LIVEKIT_CLOUD_HOST`
- `LIVEKIT_CLOUD_API_KEY`
- `LIVEKIT_CLOUD_API_SECRET`
- `ADMIN_CONSOLE_USERNAME`
- `ADMIN_CONSOLE_PASSWORD`
- `ADMIN_CONSOLE_JWT_SECRET`
- `ADMIN_CONSOLE_JWT_EXPIRES_IN`

## Commands

```bash
npm ci
npm run build
npm start
```

## Main routes

- `POST /room/join`
- `POST /room/join-direct`
- `GET /code/:code`
- `GET /room/:code/:room`
- `GET /api/connection-details`
- `POST /api/leave`
- `POST /api/heartbeat`
- `POST /codes/create`
- `GET /codes`
- `GET /codes/stats`
- `GET /rooms`
- `POST /cleanup`
