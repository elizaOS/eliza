# Onboarding (app-core)

Small module that supports the pre-chat runtime gate. The full 3-step
wizard (`deployment → providers → features`) was removed in favour of
the minimal `RuntimeGate` at
`components/shell/RuntimeGate.tsx` — the only pre-chat decision is
where the agent runs (local / cloud / remote). Provider, subscription,
and connector setup happens inside chat or Settings.

| File | What it does |
|------|--------------|
| `flow.ts` | Step-order helpers kept for legacy callers in `useOnboardingCallbacks.ts`. These handlers are effectively no-ops now that the wizard is gone; scheduled for removal in a follow-up once external callers are migrated. |
| `server-target.ts` | Persisted "kind" identity (local / remote / elizacloud / elizacloud-hybrid) used across the shell and mobile runtime. |
| `mobile-runtime-mode.ts` | Mobile-specific runtime mode persistence tied to the server target. |

See `components/shell/RuntimeGate.tsx` for the current UI.
