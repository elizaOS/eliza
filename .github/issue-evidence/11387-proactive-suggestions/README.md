# #11387 — proactive interaction suggestion bubble

Adds the accept ("Do it") / dismiss suggestion-bubble affordance to the shipped
shell chat surface (`ContinuousChatOverlay`) for assistant turns whose
`ShellMessage.source === "proactive-interaction"`, plus admit/suppress logging
in the proactive-interaction decider and a live Playwright e2e for the full
pipeline.

## Files

- `packages/ui/src/components/shell/ContinuousChatOverlay.tsx` — Suggestion chip
  + "Do it" + dismiss + `data-proactive-suggestion`, keyed on `message.source`.
- `packages/ui/src/components/shell/shell-state.ts` — `ShellMessage.source`.
- `packages/ui/src/components/shell/useShellController.ts` — forwards `source`.
- `plugins/plugin-personal-assistant/src/services/proactive-interaction-decider.ts`
  — structured admit/suppress logs.
- `packages/app/test/ui-smoke/proactive-suggestions-live.spec.ts` — LIVE e2e.
- `packages/ui/src/components/shell/__tests__/ContinuousChatOverlay.suggestion.test.tsx`
  — 5 component tests.
- `packages/ui/src/components/shell/__tests__/ContinuousChatOverlay.suggestion.evidence.test.tsx`
  — regenerates `rendered-dom.html` below.

## Evidence

- `rendered-dom.html` — the ACTUAL rendered DOM of (1) a proactive-suggestion
  turn showing the `Suggestion` label + `Do it` / dismiss controls +
  `data-proactive-suggestion="true"`, and (2) a normal assistant reply carrying
  none of them. Captured from the real `ThreadLine` render path (jsdom).

### Component tests (run)

```
bun run --cwd packages/ui test src/components/shell/__tests__/ContinuousChatOverlay.suggestion.test.tsx
# Test Files  1 passed (1) — Tests  5 passed (5)
```

### Live e2e — N/A (not reachable in this worktree)

`proactive-suggestions-live.spec.ts` is `LIVE_ONLY`: it requires the real app +
runtime + a live LLM judge (`ELIZA_UI_SMOKE_LIVE_STACK=1`, a running agent, and a
provider key). No live stack / model is reachable in this isolated CI worktree,
so the full 5-phase live run (view-switch → decider → judge → governance gate →
WS proactive-message → rendered bubble; dismiss; rate-limit suppression; "Do it"
accept turn; Settings-Off kill-switch) was **not** executed here. It must be run
on a host with a live stack before merge to close that evidence row. The
rendered-DOM capture above proves the client affordance renders correctly; the
live spec proves the end-to-end pipeline.
