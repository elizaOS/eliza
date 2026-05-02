# Infrastructure & Docs Review

Reviewed: 2026-04-11
Reviewer: Sol (subagent, code review)

---

## Critical (must fix)

- **[.github/workflows/pr.yml:28-31] PR workflow tests `packages/api` and `packages/vault` without a database.** CI provides `DATABASE_URL: "postgresql://localhost:5432/steward_test"` but no Postgres service container is defined in the job. These tests will fail on every PR with connection refused errors. Either add a `services: postgres:` block (like the CI workflow should have) or remove these test lines and keep them in a separate integration workflow.

- **[deploy/Dockerfile:7] Build errors silently swallowed.** `RUN bun run build || true` means any TypeScript compilation error is ignored and the image ships broken code. Remove `|| true` and fix any build issues properly. A broken build should fail the image creation.

- **[deploy/Dockerfile:1,12] Bun version pinned to 1.2 while root Dockerfile uses 1.3.** The root `Dockerfile` uses `oven/bun:1.3-alpine` and `package.json` declares `"packageManager": "bun@1.3.9"`. The deploy Dockerfile uses `oven/bun:1.2` / `oven/bun:1.2-slim`, which may cause lockfile incompatibilities or behavioral differences between the two build paths.

- **[deploy/docker-compose.yml:44] Hardcoded default Postgres credentials.** `POSTGRES_USER: steward` and `POSTGRES_PASSWORD: steward` with no env var override. Anyone using `deploy/docker-compose.yml` without reading docs gets a database with default credentials. At minimum, use `${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}` like the root compose does for `STEWARD_MASTER_PASSWORD`.

- **[Env var naming inconsistency across codebase] `STEWARD_JWT_SECRET` vs `STEWARD_SESSION_SECRET`.** The root `.env.example` and root `docker-compose.yml` use `STEWARD_SESSION_SECRET`. The deploy `docker-compose.yml` and `deploy/DEPLOYMENT.md` use `STEWARD_JWT_SECRET`. The actual code (`packages/api/src/services/context.ts`) reads `STEWARD_JWT_SECRET`. This means anyone following the root `.env.example` guidance sets `STEWARD_SESSION_SECRET` but the API never reads it, silently falling back to master password. One name needs to win and all references need updating.

- **[deploy/DEPLOYMENT.md + scripts/deploy.sh] Service name mismatch.** `deploy/steward.service` and `deploy/steward-proxy.service` use service names `steward` (API) and `steward-proxy`. But `deploy/DEPLOYMENT.md`'s "Update all nodes" section restarts only `steward` (not `steward-proxy`). `scripts/deploy.sh` restarts `steward steward-proxy` which is correct, but the inline DEPLOYMENT.md instructions don't. Meanwhile, `deploy/DEPLOYMENT.md` Step 4 creates `steward-api.service` (not `steward.service`), contradicting the actual service file.

## High (should fix)

- **[Dockerfile:35] `BUN_FROZEN_LOCKFILE=0` disables lockfile integrity.** This means Docker builds can install different versions than what's committed. Should be `bun install --frozen-lockfile` (and fix any lockfile drift as a separate step). The `0` is explicitly opting out of reproducibility.

- **[docker-compose.yml:26] Default Postgres password is `changeme`.** While it's behind env var substitution `${POSTGRES_PASSWORD:-changeme}`, the fallback is weak. Unlike `STEWARD_MASTER_PASSWORD` which uses `:?` (required), Postgres silently accepts the default. Add a comment in `.env.example` warning this must be changed, or use `:?` syntax.

- **[deploy/docker-compose.yml:12] Network `milady-isolated` is `external: true`.** This means `docker compose up` will fail if the network doesn't already exist. No error guidance is provided. Add a pre-step or use `third-party: false` with a created network.

- **[packages/redis, packages/webhooks, packages/shared] Accidentally publishable.** These packages have `private: null` (no `"private": true`) which means `npm publish` will succeed. They're not in the release script's `PACKAGES` list, but someone running `npm publish` in those directories would push internal packages. Either add `"private": true` to redis/webhooks (which are internal), or add them to the release pipeline if intended to be public.

- **[@stwd/shared version 0.2.0 while everything else is 0.3.0+.** The release script only bumps sdk/react/eliza-plugin. If shared is meant to be public, it should be included in the release script. If it's internal, mark it private.

- **[scripts/deploy.sh:91] Migrations run ALL SQL files every time.** The migration script finds all `[0-9][0-9][0-9][0-9]_*.sql` files and runs them sequentially. There's no migration tracking table, so re-running migrations on an already-migrated database will fail or duplicate data unless every migration is idempotent (uses `IF NOT EXISTS`, etc). This is fine if Drizzle migrations are idempotent, but it's fragile. Consider using `drizzle-kit migrate` or adding a `_migrations` tracking table.

- **[scripts/deploy-all.sh] Hardcoded node IPs and names.** Seven production node IPs are hardcoded in the script. When nodes change, this script must be manually updated. Consider moving to a `nodes.txt` or `inventory.yml` file.

- **[deploy/nginx.conf] Rate limiting zones commented out.** `limit_req zone=steward_api` and `limit_req zone=steward_proxy` are commented out. The zones themselves are only shown as reference comments. Without these, there's no nginx-level rate limiting. The file says "enable after adding zone above" but the actual zone definitions need to go in `/etc/nginx/nginx.conf`, which is easy to miss.

- **[deploy/nginx.conf] `$connection_upgrade` map not defined in file.** The nginx config uses `proxy_set_header Connection $connection_upgrade` but the `map` directive that defines this variable is shown as a comment at the bottom of the file, to be pasted into the main `nginx.conf`. If missed, nginx will pass an empty Connection header or fail to start.

## Medium (improve)

- **[package.json:14-18] Root-level runtime deps should be devDeps.** `ioredis`, `jose`, and `siwe` are in root `dependencies` instead of `devDependencies`. In a monorepo, these should live in the packages that use them (and they likely already do). Root deps should only have workspace tooling.

- **[Dockerfile:runtime] Copies entire package directories from build stage.** `COPY --from=build /app/packages/sdk packages/sdk` copies source + dist. A cleaner approach would copy only `dist/` and `package.json` for each package, reducing the runtime image size.

- **[docker-compose.yml] Ports bound to 127.0.0.1 for API/proxy.** This is correct for production (behind nginx), but the `deploy/docker-compose.yml` binds to `0.0.0.0` (no host restriction on ports). Document this difference explicitly.

- **[docker-compose.dev.yml] Both API and proxy share PGLite volume.** PGLite is a single-process embedded DB. Running two services (API + proxy) against the same PGLite data directory could cause corruption. The proxy might need its own DB connection or the compose should warn about this.

- **[.github/workflows/ci.yml] CI only runs on `develop` and `main` push, not on PRs.** PR checks are in `pr.yml`, but CI and PR run nearly identical steps. Consider merging them or having CI reference the same job definition to avoid drift (they've already drifted: CI skips api/vault tests, PR includes them).

- **[.github/workflows/release.yml] `continue-on-error: true` on npm publish.** This is intentional (to not block on already-published versions), but it also swallows real publish failures (auth issues, name conflicts). Consider checking the error message or exit code more carefully.

- **[.env.example] Missing `STEWARD_PROXY_PORT`.** The docker-compose.yml uses `STEWARD_PROXY_PORT` but `.env.example` doesn't list it. Also missing: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` (used by compose).

- **[.env.example] `RPC_URL` defaults to Sepolia testnet but docker-compose.yml defaults to mainnet.** `.env.example` has `RPC_URL=https://sepolia.base.org` and `CHAIN_ID=84532`. `docker-compose.yml` has `RPC_URL: "${RPC_URL:-https://mainnet.base.org}"` and `CHAIN_ID: "${CHAIN_ID:-8453}"`. Users copying `.env.example` get testnet; users relying on compose defaults get mainnet. This mismatch could cause confusing failures.

- **[deploy/DEPLOYMENT.md:45] Version string `API_VERSION=0.2.0` is stale.** Packages are at 0.3.0+. This hardcoded version in the example `.env` block will show wrong version in health checks.

- **[CONTRIBUTING.md:15] Package table lists `agent-trader` and `seed` but is missing `erc8004`.** The erc8004 package exists in the workspace but isn't documented anywhere.

- **[scripts/deploy.sh] Runs as root via SSH.** `ssh root@${NODE_IP}` and `bun install` as root. The deploy service files define `User=steward` but the deploy script installs deps as root, potentially creating files owned by root that the steward user can't read. The systemd service file uses `/home/steward/.bun/bin/bun` but deploy.sh uses `/root/.bun/bin/bun`.

- **[Dockerfile] No `.dockerignore` for `bun.lock`.** The `.dockerignore` excludes `.env.*` but not `bun.lock` (which is fine, it's needed). However, it excludes `packages/sdk/dist` specifically but not other `dist/` directories at the package level, potentially including stale build artifacts.

- **[deploy/steward.service + steward-proxy.service] Uses `User=steward` but deploy scripts use `root`.** The systemd units run as a `steward` user (`/home/steward/.bun/bin/bun`) but deploy/provision scripts SSH as root and install to `/opt/steward`. The user `steward` may not own `/opt/steward/node_modules`, causing permission errors.

## Stale / Outdated

- **[deploy/DEPLOYMENT.md]** References `API_VERSION=0.2.0` in the example `.env` block. Current versions are 0.3.0+.

- **[deploy/DEPLOYMENT.md]** References `STEWARD_JWT_SECRET` which has been renamed to `STEWARD_SESSION_SECRET` in root config files (or vice versa, depending on which is canonical).

- **[deploy/DEPLOYMENT.md]** "Update all nodes" section only restarts `steward` service, not `steward-proxy`. Should be `systemctl restart steward steward-proxy` (or `steward-api steward-proxy` if using the Step 4 naming).

- **[deploy/DEPLOYMENT.md]** Step 4 creates `steward-api.service` but the actual file in `deploy/` is named `steward.service`. Inconsistent naming.

- **[deploy/DEPLOYMENT.md]** Health check example expects `{"status":"ok","version":"0.2.0","uptime":...}`, stale version string.

- **[deploy/Dockerfile]** References `packages/agent-trader`, `packages/react`, `packages/eliza-plugin`, `packages/seed` via `sed` removal but these packages have changed since the Dockerfile was written. The `sed` command removes `"web"` and `"packages/examples"` but doesn't account for `erc8004`.

- **[docs/quickstart.md + docs/quickstart.mdx]** Two quickstart files exist (`.md` and `.mdx`). The `mint.json` navigation references `"quickstart"` which Mintlify resolves to `.mdx`. The `.md` version may be stale.

- **[docs/] Multiple legacy/stale doc files.** `docs/architecture.md`, `docs/auth.md`, `docs/deployment.md`, `docs/policies.md`, `docs/quickstart.md`, `docs/react.md`, `docs/sdk.md` appear to be pre-Mintlify versions superseded by the `.mdx` files under `docs/concepts/`, `docs/auth/`, `docs/sdk/`, `docs/guides/`. They're not referenced in `mint.json` navigation.

- **[CONTRIBUTING.md]** Says "Run all tests from the root: `bun test`" but `turbo.json` has a `test` task and the root `package.json` has `"test": "turbo test"`. These aren't the same thing and may produce different results.

## Missing

- **No Postgres service in PR workflow.** `pr.yml` tests `packages/api` and `packages/vault` with a `DATABASE_URL` pointing to localhost, but no `services:` block provisions a Postgres instance. These tests will always fail.

- **No database backup strategy documented.** Production uses a shared Neon Postgres. No backup schedule, retention policy, or restore procedure is documented anywhere.

- **No monitoring/alerting setup.** No health check monitoring, uptime alerting, or error tracking (Sentry, etc.) is configured or documented. For a production deployment managing wallet keys, this is a significant gap.

- **No secret rotation documentation.** `STEWARD_MASTER_PASSWORD` rotation requires re-encrypting all vault entries. This procedure isn't documented. Losing or needing to rotate this key is a critical scenario.

- **No log rotation for systemd deployments.** The `journald` output from steward services will grow unbounded. Docker compose has `max-size: 50m`, but bare metal systemd has no equivalent configured.

- **No `.nvmrc` or `bun.version` file.** `package.json` specifies `"packageManager": "bun@1.3.9"` but there's no `.nvmrc` for the Node version used in CI (hardcoded to `22` in `release.yml`). Consider adding explicit version pinning.

- **No integration test in CI.** The E2E scripts (`e2e-auth-test.ts`, `e2e-integration-test.ts`) exist but aren't run in any GitHub Actions workflow. They require a running instance, which could be provided via `docker compose up` in CI.

- **No CHANGELOG.md.** Releases use auto-generated GitHub release notes, but there's no tracked changelog file for SDK consumers who don't use GitHub.

- **No resource limits in docker-compose.yml.** Neither compose file sets `deploy.resources.limits` for memory/CPU. A runaway process could consume all host resources.

- **No volume backup for Postgres data.** The `postgres-data` and `redis-data` Docker volumes have no backup mechanism. If the Docker host dies, all data is lost.

- **deploy/.env.example is much sparser than root .env.example.** Missing: `STEWARD_SESSION_SECRET`, `STEWARD_PLATFORM_KEYS` (uses `STEWARD_PLATFORM_KEY` singular instead), `AGENT_TOKEN_EXPIRY`, all auth vars (RESEND, PASSKEY, OAuth), all dashboard vars.

- **No smoke test for Docker build in CI.** The docker workflow builds and pushes to GHCR but never runs the image to verify it starts successfully. A `docker run --rm steward:latest bun -e "console.log('ok')"` or health check would catch build-but-broken-at-runtime issues.
