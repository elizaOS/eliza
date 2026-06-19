# First-Run Setup

| File | What it does |
|------|--------------|
| `FirstRunScreen.tsx` | Controller boundary for the pure first-run shell view. |
| `use-first-run-controller.ts` | First-run behavior owner: persistence, API submission, runtime startup, speech prompt playback, and mic transcript capture. |
| `first-run.ts` | Deterministic first-run state helpers, voice transcript application, and submit payload builder. |
| `setup-steps.ts` | Internal setup cursor for state-side completion callbacks. |
| `reload-into-first-run-runtime.ts` | Runtime-switch URL and storage reset helper used by Settings. |
| `deep-link-handler.ts` | Mobile deep-link adapter for selecting first-run runtime targets. |
| `runtime-target.ts` | Persisted runtime identity (local / remote / elizacloud / elizacloud-hybrid) used across the shell and mobile runtime. |
| `mobile-runtime-mode.ts` | Mobile-specific runtime mode persistence tied to the server target. |
