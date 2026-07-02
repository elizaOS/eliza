# Issue 10999 - LifeOps Route Actor Auth

## Summary

LifeOps raw-route authorization no longer trusts client-supplied
`x-eliza-entity-id` or `x-eliza-actor-entity-id` headers, and missing actor
headers no longer default remote callers to the owner. Private LifeOps routes
now first pass through app-core route authorization, then require a
server-derived owner route role from trusted loopback access, configured owner
token access, or an authenticated owner session resolved from the auth store.

The existing `adminEntityId` route-context field remains a server-side owner
identifier for handlers/UI projections; it is no longer used as an ambient
request actor.

## Verification

- `bunx biome check plugins/plugin-personal-assistant/src/routes/plugin.ts plugins/plugin-personal-assistant/src/routes/plugin.test.ts`
  - Passed.
- `bun run --cwd plugins/plugin-personal-assistant test src/routes/plugin.test.ts`
  - Passed: 1 file, 6 tests.

## Blocked / N/A

- `bun test plugins/plugin-personal-assistant/src/routes/plugin.test.ts`
  - N/A as a validation command for this package: direct Bun test does not load
    the plugin Vitest/workspace resolver and failed before tests on
    `@elizaos/plugin-scheduling`.
- `bun run --cwd plugins/plugin-personal-assistant typecheck`
  - Blocked on current `develop` package/export drift outside this change,
    including unresolved workspace subpaths such as
    `@elizaos/plugin-calendar/routes/calendar-routes`,
    `@elizaos/plugin-finances/finances-service`, and
    `@elizaos/plugin-scheduling`.
- Screenshots/video are N/A because this is a server-side route authorization
  fix with no UI surface change.
