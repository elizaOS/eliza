# First-Run Setup

| File | What it does |
|------|--------------|
| `use-first-run-conductor.ts` | Headless in-chat conductor that seeds first-run chat turns, routes `__first_run__:` choices, and answers typed free text with a local echo persona. |
| `first-run-action-channel.ts` | The seam the chat send funnel consults: `__first_run__:` picks and (during onboarding) free text route to the conductor, never the server. |
| `first-run-finish.ts` | Single headless finish use case: runtime startup, cloud/remote binding, and exactly-once `/api/first-run` persistence. |
| `first-run.ts` | Deterministic first-run state helpers and submit payload builder. |
| `reload-into-first-run-runtime.ts` | Runtime-switch URL and storage reset helper used by Settings. |
| `deep-link-handler.ts` | Mobile deep-link adapter for selecting first-run runtime targets. |
| `runtime-target.ts` | Persisted runtime identity (local / remote / elizacloud / elizacloud-hybrid) used across the shell and mobile runtime. |
| `mobile-runtime-mode.ts` | Mobile-specific runtime mode persistence tied to the server target. |

## The onboarding surface (#12178)

While first-run is pending the floating chat is the shared half-height
conversation surface: pinned HALF with no opaque app backdrop, every collapse
path a no-op, and the same sheet remains open when setup completes until the
user intentionally folds it to the pill. A completed relaunch begins at that
pill; opening it restores the shared half-height composer.

Before setup completes, the composer is sign-in-first and locked; the seeded
CHOICE/OAuth widgets in the normal transcript are the primary input. Attach and
mic stay disabled because no agent is available yet. The full contract (and
which seam enforces each guarantee) is documented in
[`IN_CHAT_ONBOARDING_DESIGN.md`](./IN_CHAT_ONBOARDING_DESIGN.md) and covered by
`../components/shell/ChatOverlay.firstrun.test.tsx`.
