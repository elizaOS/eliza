# `elizaos deploy` — Design Doc

Status: **keel only** (this PR). Real deploy logic lands in a follow-up.

## Goal

Ship a single command that takes a generated elizaOS project (`template.json` present in cwd) and deploys it to Eliza Cloud, optionally bound to a custom domain. Surface enough flag plumbing now that the implementation PR has nothing to design — only fill in.

## Command surface

```
elizaos deploy [--app-id <id>] [--domain <host>] [--dry-run] [--verbose]
```

- `--app-id <id>` — Eliza Cloud app UUID. If omitted, resolved from `.elizaos/template.json` (`values.appId`) or, failing that, by name match against `GET /api/v1/apps?owned=true`.
- `--domain <host>` — Custom external domain to attach after the deploy goes `READY`. Must match the same regex enforced by `POST /api/v1/apps/[id]/domains`: `^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$`. Subdomain rule is enforced server-side.
- `--dry-run` — Print the planned sequence and exit 0. No network calls. **Default for the keel PR.**
- `--verbose` — Echo every backend request URL + status to stderr.

## Auth flow

Reuse whatever `create`/`upgrade` already established: `process.env.ELIZACLOUD_API_KEY` first, then `~/.elizaos/credentials.json` (same file the dashboard CLI writes). On first run with neither present, prompt with `@clack/prompts` for the API key and persist it. **The keel performs no auth read** — it only prints `auth check` as the first planned step.

## Deploy sequence

Each step is its own function in the implementation PR so the dry-run banner stays one source of truth.

1. **auth check** — load credentials, ping `GET /api/v1/me`, abort on 401.
2. **app lookup** — resolve `--app-id` (see above). If still missing, prompt to register a new app via `POST /api/v1/apps`.
3. **build** — run `bun run build` in cwd (for `project` template). For `plugin` template, abort with a clear error: plugins ship to npm, not Vercel.
4. **upload** — push the built artifact to the app's linked GitHub repo (`apps.github_repo` column). The Vercel project is wired to that repo, so push-to-deploy is the contract. If `github_repo` is null, call the existing app-builder route that provisions it.
5. **register app deploy** — `POST /api/v1/apps/[id]/deploy` (route exists; see `cloud/apps/api/v1/apps/[id]/deploy/route.ts` if present, otherwise this is a follow-up endpoint). This sets `app_deployment_status` to `building`.
6. **attach domain** (only when `--domain` set) — `POST /api/v1/apps/[id]/domains` with `{ domain }`. Server returns the verification TXT record + DNS instructions. CLI prints them and waits.
7. **poll status** — `GET /api/v1/apps/[id]/deploy/status` every 5s with exponential backoff up to 10min. Terminal states: `deployed`, `failed`. On `deployed` print the final URL: `https://<subdomain>.apps.elizacloud.ai` plus the custom domain if attached + verified.
8. **print URL** — final line, machine-readable: `URL: https://...`.

## Vercel as the implementation target

The CLI never talks to Vercel directly. It hits Eliza Cloud, which owns `VERCEL_TOKEN` and `VERCEL_TEAM_ID` (see `cloud/packages/lib/services/vercel-deployments.ts`). One Vercel project per app, subdomain on `apps.elizacloud.ai`, custom-domain attachment routed through Cloudflare. Keeping the CLI thin means no token leakage and no parallel auth surface.

## Dry-run semantics

`--dry-run` prints the eight steps above with the resolved inputs (app-id, domain, cwd) substituted in. No network, no fs writes, no shelling out. Exit code 0. Same output shape every time so it can be snapshot-tested.

## Error modes the implementation must handle

- **No `template.json` in cwd** — abort with `not an elizaOS project` (same wording as `upgrade`).
- **`plugin` template** — refuse: "plugins deploy to npm, not Eliza Cloud. Run `bun publish`."
- **Auth missing** — prompt; on cancel, exit 1 with a hint.
- **App not found** — list owned apps and prompt to pick.
- **Domain already attached to another app** — server returns 409; CLI prints the conflicting app and exits.
- **Build failure** — surface the underlying `bun run build` exit code.
- **Deploy timeout (>10min)** — exit 2 with the dashboard URL so the user can watch it finish.
- **`failed` terminal state** — fetch `GET /api/v1/apps/[id]/deploy/logs` and tail the last 50 lines before exiting.

## Deferred to follow-up PR

- Steps 1, 3, 4, 5, 6, 7 — all the real network/fs work.
- Credentials file shape + first-run prompt.
- The `deploy` / `deploy/status` / `deploy/logs` endpoints if they don't exist yet.
- Snapshot tests for the dry-run output.
- `--watch` mode that re-deploys on file change.
- Multi-environment (`--env preview|production`) support.

## Open questions

- Does `POST /api/v1/apps/[id]/deploy` exist today, or does the keel implicitly spec it? Recon turned up domain routes and the vercel-deployments service but no deploy-trigger route under `apps/[id]/`. Confirm before the implementation PR.
- For projects with no `github_repo`, do we (a) create one on first deploy, or (b) require the user to run a separate `elizaos link` command first? (a) is more friendly, (b) is more predictable.
- Should `--domain` accept a comma-separated list? `apps.app_domains` is 1:N — the schema supports it, but the UX gets noisy fast.
