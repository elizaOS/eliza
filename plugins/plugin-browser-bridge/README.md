# @elizaos/plugin-browser-bridge

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
`@elizaos/app-lifeops` because it carries `workflowId` plus LifeOps-only
scoping columns (`domain`, `subjectType`, `subjectId`, `visibilityScope`,
`contextPolicy`). Session endpoints here therefore call into
`@elizaos/app-lifeops/lifeops/service` to operate on that table.

## Destructive migration

This plugin renames the four previously `life_browser_*` tables to
`browser_bridge_*`. Because the generated Drizzle migrations will issue a
plain `CREATE TABLE` for the new names (with no `RENAME` bridge), the first
boot after this package lands must run with:

```
ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true
```

set in the environment. That flag is the existing escape valve wired into
`@elizaos/plugin-sql`'s migrator (see `repository.ts:1389` in plugin-sql).
This surface is not launched yet, so there is no production data to
preserve — the rename is destructive by design.

## Integration

Phase 4 will register `browserBridgePlugin` in the main plugin list next to
`@elizaos/app-lifeops`. Until then the plugin is scaffolded but not yet
mounted at runtime.

```ts
import { browserBridgePlugin } from "@elizaos/plugin-browser-bridge/plugin";
```

## Authentication

Companion-scoped endpoints (`/api/browser-bridge/companions/sync`,
`/api/browser-bridge/companions/sessions/:id/*`) require two headers:

- `X-Browser-Bridge-Companion-Id: <companion uuid>`
- `Authorization: Bearer <pairing token>`

The legacy `X-LifeOps-Browser-Companion-Id` and
`x-eliza-browser-companion-id` headers were removed — no alias fallback is
accepted.
