# `elizaos deploy` — Design Doc

Status: **implemented trigger path**. The CLI queues cloud deployments, can
attach a custom domain, and polls public deployment status. Local build/upload,
first-run credential prompting, deploy logs, and watch mode remain follow-up
boundaries.

## Goal

Ship a single command that takes a generated elizaOS project (`template.json`
present in cwd) and deploys its linked Eliza Cloud app, optionally bound to a
custom domain.

## Command surface

```
elizaos deploy [--app-id <id>] [--domain <host>] [--dry-run] [--verbose]
```

- `--app-id <id>` — Eliza Cloud app UUID. If omitted, resolved from `.elizaos/template.json` (`values.appId` / `values.cloudAppId`) or, failing that, by name match against `GET /api/v1/apps`.
- `--domain <host>` — Custom external domain to attach after the deploy goes `READY`. Must match the same regex enforced by `POST /api/v1/apps/[id]/domains`: `^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$`. Subdomain rule is enforced server-side.
- `--dry-run` — Print the planned sequence and exit 0. No network calls.
- `--verbose` — Echo local deploy settings to stderr.

## Auth flow

The CLI reads `ELIZAOS_CLOUD_API_KEY`, `ELIZA_CLOUD_API_KEY`,
`ELIZACLOUD_API_KEY`, or `~/.elizaos/credentials.json`. Requests are sent with
`Authorization: Bearer <key>`. The API base defaults to
`https://api.elizacloud.ai/api/v1`; override with `ELIZA_CLOUD_API_BASE_URL`,
`ELIZAOS_CLOUD_API_BASE_URL`, `ELIZACLOUD_API_BASE_URL`, or
`ELIZA_CLOUD_BASE_URL`.

## Deploy sequence

1. **auth check** — load credentials and send Bearer auth with cloud requests.
2. **app lookup** — resolve `--app-id`, `.elizaos/template.json`, or a single owned-app name match.
3. **trigger deploy** — `POST /api/v1/apps/[id]/deploy` with an empty body, letting the cloud service use the app's linked repository and stored env config.
4. **attach domain** (only when `--domain` set) — `POST /api/v1/apps/[id]/domains` with `{ domain }`. Server returns the verification TXT record + DNS instructions when needed; the CLI prints them.
5. **poll status** — `GET /api/v1/apps/[id]/deploy/status` every 5s up to 10min. Terminal states: `READY`, `ERROR`.
6. **print URL** — final line includes the returned `vercelUrl` when present and the custom domain when requested.

## Vercel as the implementation target

The CLI never talks to Vercel directly. It hits Eliza Cloud, which owns `VERCEL_TOKEN` and `VERCEL_TEAM_ID` (see `cloud/packages/lib/services/vercel-deployments.ts`). One Vercel project per app, subdomain on `apps.elizacloud.ai`, custom-domain attachment routed through Cloudflare. Keeping the CLI thin means no token leakage and no parallel auth surface.

## Dry-run semantics

`--dry-run` prints the sequence above with the resolved inputs (app-id, domain,
cwd) substituted in. No network, no fs writes, no shelling out. Exit code 0.

## Current Error Modes

- **Auth missing** — exit 1 with an env/credentials hint.
- **App not found** — exit 1 and ask for `--app-id` or `.elizaos/template.json` app metadata.
- **Domain already attached to another app** — server returns 409; CLI prints the conflicting app and exits.
- **Deploy timeout (>10min)** — exit 1 with the latest status.
- **`ERROR` terminal state** — exit 1 with the deployment error string.

## Deferred to follow-up PR

- Local `bun run build` and artifact upload before queueing deploy.
- First-run credential prompt + credentials persistence.
- `GET /api/v1/apps/[id]/deploy/logs` endpoint + failed-deploy log tailing.
- `--watch` mode that re-deploys on file change.
- Multi-environment (`--env preview|production`) support.

## Open questions

- For projects with no `github_repo`, do we (a) create one on first deploy, or (b) require the user to run a separate `elizaos link` command first? (a) is more friendly, (b) is more predictable.
- Should `--domain` accept a comma-separated list? `apps.app_domains` is 1:N — the schema supports it, but the UX gets noisy fast.
