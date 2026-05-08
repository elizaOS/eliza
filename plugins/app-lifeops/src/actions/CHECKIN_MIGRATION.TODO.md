# CHECKIN action removed — migrate to scheduled tasks

The `CHECKIN` action (formerly at `plugins/app-lifeops/src/actions/checkin.ts`) was
deleted as part of the action consolidation cleanup (Phase 1, base plan §4).

The morning and night briefings should be migrated to **scheduled tasks**, not
re-introduced as planner-visible actions. The user does not invoke the briefing
as a command; the agent should run it on a daily cadence and surface the result.

## Two scheduled tasks to create

Use the `scheduled-tasks` skill at `~/.milady/` (or the equivalent
`mcp__scheduled-tasks__create_scheduled_task` MCP tool).

1. **Morning brief — 8am daily**
   - Cron: `0 8 * * *`
   - Owner: the agent's owner user
   - Action: invoke `CheckinService.runMorningCheckin({ roomId })` with the
     owner's primary DM room.
   - Output: post the rendered briefing to that room.

2. **Night brief — 8pm daily**
   - Cron: `0 20 * * *`
   - Owner: same as above
   - Action: invoke `CheckinService.runNightCheckin({ roomId })`.
   - Output: post to the owner's DM room.

## Where the logic lives

The briefing-generation logic is already in `CheckinService` at
`plugins/app-lifeops/src/lifeops/checkin/checkin-service.ts`. No business logic
moved when CHECKIN was deleted — only the planner-visible action wrapper went
away. `runMorningCheckin` and `runNightCheckin` remain on the service.

## Provider hint

The provider description in `plugins/app-lifeops/src/providers/lifeops.ts`
still references `CHECKIN` in routing prose. Update that prose to point users
at the scheduled-task surface (or remove the routing line entirely) when the
scheduled tasks land.

## References to clean up after migration

- `packages/core/src/services/message.ts` (deterministic intent map and
  morning-brief examples reference `CHECKIN` as a route target).
- `packages/app-core/test/live-agent/action-invocation.live.e2e.test.ts`
  ("morning check-in request triggers CHECKIN" / "night check-in request
  triggers CHECKIN" specs — either rewrite to invoke the service directly or
  remove if the brief is no longer planner-visible).
- `packages/core/src/utils/context-catalog.ts` already has `CHECKIN`
  registered for `["tasks", "health", "automation"]`. Keep or remove based
  on whether anything else still uses that catalog entry after migration.
