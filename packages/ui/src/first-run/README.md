# First-Run Setup

| File | What it does |
|------|--------------|
| `FirstRunRuntimeChooser.tsx` | Floating runtime/provider chooser rendered over the live chat shell during first-run. |
| `use-first-run-conductor.ts` | Headless in-chat conductor that seeds first-run chat turns and routes `__first_run__:` choices. |
| `first-run-finish.ts` | Single headless finish use case: runtime startup, cloud/remote binding, and exactly-once `/api/first-run` persistence. |
| `first-run.ts` | Deterministic first-run state helpers and submit payload builder. |
| `setup-steps.ts` | Internal setup cursor for state-side completion callbacks. |
| `reload-into-first-run-runtime.ts` | Runtime-switch URL and storage reset helper used by Settings. |
| `deep-link-handler.ts` | Mobile deep-link adapter for selecting first-run runtime targets. |
| `runtime-target.ts` | Persisted runtime identity (local / remote / elizacloud / elizacloud-hybrid) used across the shell and mobile runtime. |
| `mobile-runtime-mode.ts` | Mobile-specific runtime mode persistence tied to the server target. |
