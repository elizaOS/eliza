# #12275 calendar route service-load evidence

## Scope

- Chunk for issue #12275.
- Calendar routes no longer treat a rejected `getServiceLoadPromise("calendar")` as an absent service.
- Actual service-load failures now call `runtime.reportError("CalendarRoutes.serviceLoad", ...)` and throw `ElizaError` code `CALENDAR_SERVICE_LOAD_FAILED`.
- A genuinely absent calendar service still returns the designed route-level `503` JSON response.

## Verification

```bash
bun run --cwd plugins/plugin-calendar test -- src/routes/plugin-routes.test.ts
```

Result: passed, 1 file / 2 tests.

```bash
bunx @biomejs/biome check plugins/plugin-calendar/src/routes/plugin-routes.ts plugins/plugin-calendar/src/routes/plugin-routes.test.ts
```

Result: passed.

```bash
bun run --cwd plugins/plugin-calendar build
```

Result: passed.

```bash
bun run audit:error-policy-ratchet
```

Result: passed on the committed diff. The audit reported one changed production source file and no new fallback slop in `plugins/plugin-calendar/src/routes/plugin-routes.ts`.

```bash
bun run --cwd plugins/plugin-calendar typecheck
```

Result: failed on unrelated workspace/package issues:

```text
../../packages/agent/src/runtime/optional-plugin-imports.generated.ts(13,14): Cannot find module '@elizaos/plugin-task-coordinator'
src/meetings/auto-join.ts(37,8): Cannot find module '@elizaos/plugin-scheduling'
src/meetings/meeting-join-dispatch.ts(20,37): Cannot find module '@elizaos/plugin-scheduling'
../plugin-local-inference/src/services/downloader.ts(963,6): Argument of type '{ error: unknown; }' is not assignable to parameter of type 'string'.
../plugin-local-inference/src/services/downloader.ts(1052,6): Argument of type '{ error: unknown; }' is not assignable to parameter of type 'string'.
```

```bash
bun run verify
```

Result: failed in unrelated `@elizaos/cloud-shared#lint` formatting after 141 successful Turbo tasks:

```text
packages/cloud/shared/src/lib/types/cloud-api.ts:451
Formatter would print:
return value === "super_admin" || value === "moderator" || value === "viewer";
```

## Route Failure Evidence

The focused route test drives the real `calendarRouteHandler()` with fake HTTP
request/response objects:

- absent service: returns `503` with `{ "error": "Calendar service is not available." }`
- rejected service-load promise: calls `runtime.reportError(...)`, throws `CALENDAR_SERVICE_LOAD_FAILED`, and does not send the absent-service response

## Evidence Matrix

- Backend logs: route test asserts the runtime error-reporting call for the service-load failure path.
- Frontend screenshots/video: N/A - no UI rendering changed.
- Real-LLM trajectories: N/A - no model, prompt, provider, action, or evaluator behavior changed.
- Domain artifacts: N/A - no calendar events, external accounts, database rows, scheduled tasks, generated files, or connector artifacts changed.
