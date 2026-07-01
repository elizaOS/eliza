# Issue #9947 embed client bootstrap evidence

## Scope

- Added a `/embed` launch bootstrap in `packages/app` that reads platform launch payloads before the normal app mount.
- Telegram launch uses `window.Telegram.WebApp.initData`; Discord launch uses the OAuth `code` query param. Both also accept an explicit `signedLaunchPayload` query param for local/proxy launch paths.
- The bootstrap posts `{ platform, signedLaunchPayload }` to `/api/embed/auth`, stores a returned session token through the existing UI client token path, removes sensitive query params, and fails closed when payloads, auth, or token minting are missing.

## Validation

- `bun run --cwd packages/app test src/embed-launch.test.ts`
  - Passed: 1 file, 6 tests.
- `bun run --cwd packages/app-core test src/api/embed-auth-routes.test.ts src/api/auth/embed-session-token.test.ts`
  - Passed: 2 files, 13 tests.
- `bun run --cwd packages/app lint`
  - Passed after rebase: 123 files checked.
- `git diff --check`
  - Passed.
- `bun run --cwd packages/app audit:app`
  - Passed after rebase: 349 tests.
  - Audit summary: broken=0, needs-work=0, needs-eyeball=212, good=136.

## Typecheck

- `bun run --cwd packages/app typecheck`
  - Blocked by existing workspace reference/type errors outside this change, including unresolved `@elizaos/plugin-streaming`, `@elizaos/vault`, `@elizaos/tui`, `@elizaos/skills`, `@elizaos/cloud-sdk`, and pre-existing plugin app-manager / elizacloud type errors.
  - No reported typecheck errors were in `packages/app/src/embed-launch.ts`, `packages/app/src/embed-launch.test.ts`, or `packages/app/src/main.tsx`.

## Evidence notes

- Real LLM trajectory: N/A. This is an app launch/auth bootstrap change and does not exercise an agent response path.
- Live Telegram/Discord walkthrough: pending real bot/activity credentials and deployed `ELIZA_EMBED_SESSION_SECRET`/token verifier configuration. The local slice validates the browser bootstrap and server auth contract with unit tests plus the full app audit.
- Server token acceptance is expected to land via the companion server-side embed session authentication work; this client stores the minted token through the existing `ElizaClient.setToken` path so subsequent API probes can send the bearer token once the server accepts embed session tokens.
