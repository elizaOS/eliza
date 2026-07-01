# #10836 — first-run local + Eliza Cloud login recovery

## Scope

Issue #10836 identified a silent onboarding dead-end:

1. choose `On this device`,
2. choose `Eliza Cloud inference`,
3. cancel or fail cloud login,
4. `needs-cloud-login` tried to `replaceTurn("first-run:cloud-oauth", ...)`,
   but that turn had never been seeded on this hybrid path, so the transcript
   did not change.

This patch makes the recovery turn an upsert so the cloud OAuth widget is
appended when absent and replaced when already present.

## Evidence

Focused regression:

```bash
bunx vitest run \
  packages/ui/src/first-run/use-first-run-conductor.test.tsx \
  packages/ui/src/first-run/first-run.test.ts \
  packages/ui/src/first-run/setup-steps.test.ts
```

Result: 3 files passed, 31 tests passed.

The new test mounts `FirstRunConductorMount`, drives the real first-run action
channel through `runtime:local` then `provider:elizacloud`, stubs the finish use
case to return `needs-cloud-login`, and asserts a `first-run:cloud-oauth`
assistant turn is present with `secretRequest.status: "failed"`.

Static/package checks:

```bash
bunx @biomejs/biome check \
  packages/ui/src/first-run/use-first-run-conductor.ts \
  packages/ui/src/first-run/use-first-run-conductor.test.tsx

bun run --cwd packages/ui typecheck
```

Result: both passed.

Shared-UI visual gate:

```bash
PATH=/Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
ELIZA_NODE_PATH=/Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  bun run --cwd packages/app audit:app
```

Final result: 349 Playwright audit cases passed in 29.9m. Summary:
`broken=0`, `needs-work=0`, `minimalism-budget-failures=0`,
`needs-eyeball=212`, `good=136`.

Root verification:

```bash
PATH=/Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
ELIZA_NODE_PATH=/Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  bun run verify
```

Result: blocked by an unrelated current-`develop` formatter failure in
`packages/cloud/shared/src/lib/services/app-credits.ts`. The failing check is
reproducible directly with:

```bash
bunx @biomejs/biome check packages/cloud/shared/src/lib/services/app-credits.ts
```

That direct check reports the formatter wants the existing
`reversalError instanceof Error ? ... : ...` field collapsed onto one line.
This patch does not touch `packages/cloud/shared`.

## N/A

- Real-LLM trajectory: N/A — this is client-side first-run transcript routing,
  not prompt/model behavior.
- Backend logs: N/A — the fixed path is before any successful server-side
  provisioning call; the regression is covered at the in-chat conductor seam.
- Metal/GGUF artifacts: N/A — #10836 surfaced during the local-inference issue
  sweep, but it is an onboarding control-flow bug, not native inference.
