# redis-rest

This service exposes an Upstash-compatible HTTP interface to each environment's
authoritative Railway Redis. Cloudflare Worker direct consumers use it because
raw Railway TCP is not reliable from Workerd. It is a transport adapter, not a
second Redis database.

The image is digest-pinned in `Dockerfile`. Configure every Railway environment
with:

- `SRH_MODE=env`
- `SRH_TOKEN=<rotated random bearer token>`
- `SRH_CONNECTION_STRING=${{Redis.REDIS_PUBLIC_URL}}`
- `PORT=80`

The public Railway domain is required so Cloudflare can reach the adapter. The
adapter still fail-closes without `SRH_TOKEN`; never log or commit that token.
Set the Worker secrets `KV_REST_API_URL` and `KV_REST_API_TOKEN` to the domain
and token, and keep `DIRECT_REDIS_BACKEND=redis-rest` in `wrangler.toml`.

Use `REDIS_PUBLIC_URL`, not `REDIS_URL`: the Railway private hostname was not
reachable from the adapter service during the production recovery on
2026-08-23. The Redis credential remains encrypted inside the Railway service
reference and is not exposed to the Worker.

## Deploy

From this directory:

```bash
railway up . --path-as-root --service redis-rest
```

After deployment, make an authenticated `PING` through the public adapter and
verify `GET https://api.eliza.app/api/auth/siwe/nonce` returns HTTP 200 before
accepting Twilio voice ingress.
