# Local Eliza Cloud development

Run the Eliza Cloud backend (Postgres 17 + Redis 7 + serverless-redis-http,
plus optional Steward auth) on a dev laptop and point the homepage at it via
`VITE_ELIZA_CLOUD_BASE=http://localhost:3000`.

## Prerequisites

- Docker Desktop (or another Docker daemon) running.
- `bun` installed.
- The `eliza` git submodule initialized:
  ```
  git submodule update --init --recursive eliza
  ```

## Steps

1. **Bring up the stack** (Postgres + Redis + serverless-redis-http):
   ```
   bun run dev:cloud:local
   ```
   The script auto-remaps host ports if the defaults are already in use
   (e.g. `5432` held by an unrelated container) and writes the chosen ports
   to `.eliza/cache/local-cloud-ports.json`. Banner output prints the
   `DATABASE_URL` you should export.

2. **Run cloud migrations** (first time only, or after schema bumps):
   ```
   cd eliza/cloud
   bun install
   DATABASE_URL=postgresql://eliza_dev:local_dev_password@localhost:5432/eliza_dev \
     bun run db:migrate
   cd ../..
   ```
   Replace `5432` with the port from the banner if remapping happened.

3. **Seed local data**:
   ```
   bun run seed:cloud:local
   ```
   - Phase 1 delegates to the cloud workspace's `db:local:seed` (org, user,
     credit packs, API keys).
   - Phase 2 inserts three deterministic `user_characters` (running, paused,
     provisioning) so the homepage character list has fixtures to render.

4. **Start the cloud API** in a separate terminal:
   ```
   cd eliza/cloud
   DATABASE_URL=postgresql://eliza_dev:local_dev_password@localhost:5432/eliza_dev \
     bun run dev
   ```
   The API serves on `http://localhost:3000`.

5. **Point the homepage at the local cloud**:
   ```
   VITE_ELIZA_CLOUD_BASE=http://localhost:3000 bun run dev:home:ui
   ```

## Port table

| Service              | Default | Auto-remap range | Container name              |
| -------------------- | ------- | ---------------- | --------------------------- |
| postgres             | 5432    | 5432-5441        | `eliza-local-db`            |
| redis                | 6379    | 6379-6391        | `eliza-local-redis`         |
| serverless-redis-http | 8079    | 8079-8091        | `eliza-local-redis-rest`    |
| steward (optional)   | 3200    | n/a (skipped)    | `eliza-steward`             |

If your `5432` is occupied by another container (a common case is
`hindsight-postgres-1`), `dev:cloud:local` will pick the next free port
and write a docker-compose override at
`.eliza/cache/local-cloud-overrides.yml`.

## Steward (optional)

The `steward` service builds from a sibling repo at `eliza/steward/`. It is
not a submodule - clone it manually if you need the auth flow:

```
git clone https://github.com/Steward-Fi/steward eliza/steward
```

When `eliza/steward/` is absent, `dev:cloud:local` skips the service. The
cloud API still boots fine without it for most local flows.

## Verify

Once the cloud API is up:

```
curl http://localhost:3000/api/health
```

You should get a JSON `200` response. If not, check:

- `docker logs eliza-local-db` for Postgres errors.
- The cloud API terminal for migration / env-var errors.

## Common gotchas

- **Port 5432 collision.** Auto-remap kicks in. The `DATABASE_URL` printed
  in the banner reflects the chosen port - use it everywhere downstream.
- **Steward absent.** Expected on most dev machines. The service is skipped
  cleanly; cloud auth flows that depend on Steward will be limited.
- **Seed before signing in.** The homepage's auth poll (`cloudLoginPoll`)
  expects a real organization/user row to exist. Always run
  `seed:cloud:local` before exercising auth in the homepage.
- **Migrations not applied.** The seed script will fail with "relation
  user_characters does not exist" if you skipped step 2. Run `db:migrate`
  inside `eliza/cloud` first.
- **Container restart loop.** If `eliza-local-db` keeps restarting, run
  `docker logs eliza-local-db`. A common cause is stale `postgres_data`
  volume from an older Postgres version. Wipe with `docker compose -f
  eliza/cloud/docker-compose.yml down -v` (this destroys local cloud data).

## Files written by the script

- `.eliza/cache/local-cloud-overrides.yml` - generated docker-compose
  override layer (host port remaps).
- `.eliza/cache/local-cloud-ports.json` - chosen ports + connection URLs,
  consumed by `seed:cloud:local` and useful for downstream tooling.
