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

While first-run is pending the floating chat is a full-screen onboarding
surface: pinned FULL with an **opaque `bg-bg` backdrop** that hides the
launcher/home behind it, every collapse path a no-op, and a one-shot
auto-collapse — with the backdrop fading to the normal scrim — on completion.

The composer is **unlocked** (#12178, a deliberate reversal of the #9952
onboarding lock): the user can type freely with the placeholder "Ask me anything
— or pick an option". Typed text is answered by the conductor's local echo
persona (a friendly not-ready line that varies by flow position) and **never
reaches the server pre-completion** — the AppContext send funnel enforces that
via `classifyActionMessage` → `"conductor"` → `tryHandleFirstRunText`. Attach and
mic stay disabled (no agent to serve media yet); the seeded CHOICE/OAuth widgets
remain the primary input. The full contract (and which seam enforces each
guarantee) is documented in
[`IN_CHAT_ONBOARDING_DESIGN.md`](./IN_CHAT_ONBOARDING_DESIGN.md) and covered by
`../components/shell/ContinuousChatOverlay.firstrun.test.tsx`.
