# First-Run Setup

| File | What it does |
|------|--------------|
| `use-first-run-conductor.ts` | Headless in-chat conductor that seeds first-run chat turns and routes `__first_run__:` choices through the provisioning flow. |
| `first-run-action-channel.ts` | The seam the chat send funnel consults so reserved `__first_run__:` picks route to the conductor, never the server. |
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

The composer, attachments, and microphone stay **locked** until first-run
completion, so the seeded CHOICE/OAuth widgets are the only live inputs. Cloud
is the production default: with the runtime chooser disabled, onboarding is one
sign-in CTA and successful agent reuse/provisioning immediately closes the gate
and lands on `/chat`; the tutorial remains available from its home tile. The
optional runtime chooser retains the longer guided flow for development and
specialized builds. The full contract (and which seam enforces each guarantee)
is documented in
[`IN_CHAT_ONBOARDING_DESIGN.md`](./IN_CHAT_ONBOARDING_DESIGN.md) and covered by
`../components/shell/ContinuousChatOverlay.firstrun.test.tsx`.
