# Issue #8913 evidence — ACTIVE_WORKFLOWS search context

Date: 2026-06-30

## Change summary

- `ACTIVE_WORKFLOWS` now runs in the same chat-facing context family as the
  `WORKFLOW` action: `general`, `automation`, `tasks`, and `connectors`.
- Workflow-related user messages call `WorkflowService.searchWorkflows(query,
  userId)` and return only matching workflows to the prompt context.
- Free-text workflow search now tokenizes sentence queries and ignores generic
  workflow/search boilerplate, so a prompt like "find the workflow that posts to
  Slack" matches Slack workflows instead of treating the whole sentence as one
  substring.
- Non-workflow chat text still uses the full `listWorkflows(userId)` context.
- Provider cache scope is `turn` so one searched result cannot be reused for a
  later unrelated message.

## Validation

```bash
bun run install:light
bun run --cwd packages/core build
bun test __tests__/integration/providers/providers.test.ts
bun test __tests__/unit/workflow-search.test.ts __tests__/unit/routes/workflows.test.ts
bun run --cwd plugins/plugin-workflow typecheck
bun run --cwd plugins/plugin-workflow lint:check
bun run --cwd plugins/plugin-workflow test
bun run verify
```

Results:

- Focused provider + search suites:
  `bun test __tests__/unit/workflow-search.test.ts __tests__/integration/providers/providers.test.ts`
  — 29 pass, 0 fail.
- Provider regression now drives `ACTIVE_WORKFLOWS` with sentence text through
  the real `WorkflowService.searchWorkflows` / `rankWorkflowsByQuery` path, not
  a mocked `searchWorkflows` result.
- Plugin typecheck: pass.
- Plugin lint: pass.
- Full `@elizaos/plugin-workflow` suite: 362 pass, 0 fail.
- Root `bun run verify`: fails before workspace typecheck/lint in
  `audit:type-safety-ratchet` on existing unrelated baseline drift. Current
  2026-06-30 rebase result:
  - `?? []` is 590 current vs 588 baseline.
  - `?? {}` is 379 current vs 377 baseline.
  - `?? 0` is 381 current vs 380 baseline.
  The reported files are outside `plugins/plugin-workflow`.

## Manual evidence notes

- Screenshots/video: N/A. This change is in the workflow context provider and
  does not alter `packages/app/`, visual UI, or a mobile/native surface.
- Live LLM trajectory: N/A. This update addresses deterministic provider/search
  behavior: query selection, real service ranking, context gate, cache scope,
  and serialized provider output.
