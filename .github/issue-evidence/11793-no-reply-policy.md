# 11793 no-reply policy evidence

Date: 2026-07-03

## What changed

- Completion timeouts now resolve a structural no-reply policy/state from
  `ScheduledTask.metadata.noReplyPolicy` and `metadata.noReplyState`.
- Defaults cover reminder, check-in, non-sensitive approval, and sensitive
  approval silence semantics.
- Sensitive approval silence expires with `terminalOutcome: "denied"` and does
  not auto-execute an external output.
- No-reply approval expiry is not a user skip, so `pipeline.onSkip` does not
  fire for no-reply expiry.

## Verification

Passed:

```bash
bun run --cwd plugins/plugin-personal-assistant test -- src/lifeops/scheduled-task/scheduler.no-reply-policy.test.ts
bun run --cwd plugins/plugin-personal-assistant test -- src/lifeops/scheduled-task/scheduler.fire-budget.test.ts src/lifeops/scheduled-task/scheduler.integration.test.ts
bunx vitest run --config plugins/plugin-personal-assistant/vitest.src-integration.config.ts plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.integration.test.ts
bunx biome check plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.ts plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.no-reply-policy.test.ts plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.integration.test.ts plugins/plugin-personal-assistant/README.md
git diff --check
```

Typecheck limitation:

```bash
bun run --cwd plugins/plugin-personal-assistant typecheck
```

This did not reach the no-reply change. It fails broadly in this worktree on
workspace/package resolution and pre-existing package export/type errors, e.g.
`Cannot find module '@elizaos/core'`, sibling plugin exports, and unrelated
implicit-any/unknown errors across PA actions/routes.

## N/A

- UI screenshots/video: N/A - scheduler behavior only, no UI surface changed.
- Real LLM trajectories: N/A - no prompt/model/action behavior changed; the
  covered path is deterministic scheduler state transition logic.
- Native/device capture: N/A - no native/mobile/desktop UI code changed.
