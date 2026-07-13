# First-Run Setup

| File | What it does |
|------|--------------|
| `first-run-flow.ts` | Typed onboarding phases plus the single phase/action routing table. |
| `use-first-run-conductor.ts` | Headless in-chat conductor that seeds first-run chat turns and routes `__first_run__:` choices. |
| `first-run-action-channel.ts` | The seam the chat send funnel consults to reserve and route `__first_run__:` choices without sending their sentinel values to the agent. |
| `first-run-finish.ts` | Single headless finish use case: local runtime startup, Cloud binding, and guarded `/api/first-run` persistence where the target owns that route. |
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

The composer is **locked** while onboarding is active. The user advances with
the seeded CHOICE/OAuth widgets; free text, attachments, microphone input,
slash commands, and other chat sends remain unavailable until setup completes.
This keeps first-run on one input path instead of maintaining a second local
echo conversation before an agent is ready. The full contract is documented in
[`IN_CHAT_ONBOARDING_DESIGN.md`](./IN_CHAT_ONBOARDING_DESIGN.md) and covered by
`../components/shell/ContinuousChatOverlay.firstrun.test.tsx`.
