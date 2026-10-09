# Redis REST adapter

Upstash-compatible HTTP transport for the environment's authoritative Redis.
Configure `SRH_MODE=env`, `SRH_TOKEN`, `SRH_CONNECTION_STRING` using the Railway
Redis public URL, and `PORT=80`. Point Worker `KV_REST_API_URL` and
`KV_REST_API_TOKEN` at this service. Preserve authentication; this is not a
second database.

Build from this directory:

```bash
docker build -t eliza-redis-rest .
```

There is no local test suite. After deployment, verify an authenticated Redis
PING and the Cloud authentication nonce route against that environment.
