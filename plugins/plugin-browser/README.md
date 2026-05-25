# @elizaos/plugin-browser

Agent Browser Bridge plugin: schema, contracts, HTTP routes, and packaging
utilities for Chrome/Safari browser companions.

## Scope

This plugin owns the generic browser-companion surface:

- Four Drizzle tables: `browser_bridge_companions`, `browser_bridge_settings`,
  `browser_bridge_tabs`, `browser_bridge_page_contexts`.
- `/api/browser-bridge/*` HTTP routes for pairing, settings, companion sync,
  tab + page-context ingest, packaging artifacts, and workflow-linked session
  progress endpoints.
- Companion package build + download helpers, including release-manifest
  synthesis for GitHub Releases.
- Contract types under the `BrowserBridge*` prefix.

The workflow-bound `life_browser_sessions` table intentionally stays in
`@elizaos/plugin-lifeops` because it carries `workflowId` plus LifeOps-only
scoping columns (`domain`, `subjectType`, `subjectId`, `visibilityScope`,
`contextPolicy`). Session endpoints here therefore call into
`@elizaos/plugin-lifeops/lifeops/service` to operate on that table.

## Destructive migration

This plugin renames the four previously `life_browser_*` tables to
`browser_bridge_*`. Because the generated Drizzle migrations will issue a
plain `CREATE TABLE` for the new names (with no `RENAME` bridge), the first
boot after this package lands must be run through plugin-sql's explicitly
approved destructive-migration path. Use that path only for throwaway or
approved migration runs.

## Integration

Eliza loads `browserBridgePlugin` as a core runtime plugin so the Browser
Workspace UI, agent actions, and companion extension use the same API surface.

```ts
import { browserBridgePlugin } from "@elizaos/plugin-browser";
```

## Browser target routing

The `BROWSER` action routes through `BrowserService`, which keeps a runtime
registry of browser targets:

- `workspace`: the app-owned browser workspace. On mobile/native app builds
  this remains the preferred target.
- `bridge`: a paired Chrome/Safari companion profile, when one is connected.
- `stagehand`: an optional Stagehand/Playwright fallback. It is skipped on
  mobile unless `ELIZA_BROWSER_ALLOW_STAGEHAND_ON_MOBILE=true`.
- Other plugins can register targets through `BrowserService.registerTarget`.

Automatic routing scores all available targets and falls back to the next one
if an unpinned target fails. Passing `target` to the `BROWSER` action pins a
specific backend.

Stagehand setup is opportunistic. If `plugins/plugin-browser/stagehand-server`
exists with source, the service attempts `bun install --ignore-scripts` and a
TypeScript build unless `ELIZA_BROWSER_STAGEHAND_AUTO_SETUP=false`. To activate
the fallback target, configure either `ELIZA_BROWSER_STAGEHAND_COMMAND_URL` or
`STAGEHAND_SERVER_URL`; the latter defaults commands to `/api/browser-command`.

## Authentication

Companion-scoped endpoints (`/api/browser-bridge/companions/sync`,
`/api/browser-bridge/companions/sessions/:id/*`) require two headers:

- `X-Browser-Bridge-Companion-Id: <companion uuid>`
- `Authorization: Bearer <pairing token>`

The legacy `X-LifeOps-Browser-Companion-Id` and
`x-eliza-browser-companion-id` headers were removed — no alias fallback is
accepted.

## Connector Browser Auth

Browser-backed connector auth must use session handles rather than extracted
browser secrets. The workspace helper
`acquireBrowserWorkspaceConnectorSession({ provider, accountId, ... })` binds a
named connector account to either:

- an internal browser partition named
  `persist:connector-{provider}-{accountId}-{hash}`; or
- a Browser Bridge companion profile handle when a companion/profile reference
  is supplied.

Connector partitions reject raw `cookies`, `storage`, and `state` export/load
operations. Store the returned partition/profile/session references only. Auth
states are explicit: `auth_pending`, `needs_reauth`, and `manual_handoff`
represent login, MFA, CAPTCHA, or other user-required steps.

## Companion Token Gaps

The companion bearer token is stored server-side only as a SHA-256 hash and
manual re-pairing rotates the active hash via a bounded pending-token list.
Full TTL/revocation is not complete in the generic Browser Bridge surface yet.
Missing pieces:

- schema columns for active-token expiry, pending-token expiry, and revoked
  timestamp/reason;
- repository methods and HTTP routes for explicit revoke;
- companion-side handling that clears local config on revoke/expiry responses;
- a migration path for existing `browser_bridge_companions` rows.
