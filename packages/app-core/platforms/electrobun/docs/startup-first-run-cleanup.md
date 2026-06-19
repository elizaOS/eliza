# Startup And Onboarding Cleanup

Startup and onboarding remain Electrobun core boot infrastructure. They are not Remote candidates because the host, renderer, AgentManager, boot RPC, auth gate, first-run gate, and first-party Remote seeding all depend on the shell being alive first.

## Current Paths

- `packages/app-core/platforms/electrobun/src/native/agent.ts` owns embedded runtime lifecycle, diagnostics files, health polling, retry, restart, and bug-report bundle inputs.
- `packages/app-core/platforms/electrobun/src/boot-progress.ts` composes typed `bootProgress` from AgentManager status and `/api/health`.
- `packages/app-core/platforms/electrobun/src/config-and-auth-rpc.ts` composes typed auth gate snapshots.
- `packages/app-core/platforms/electrobun/src/first-run-rpc.ts` composes typed first-run status and options snapshots.
- `packages/app-core/platforms/electrobun/src/first-party-remotes.ts` seeds first-party Remotes after the main Electrobun window is alive.
- `packages/ui/src/components/shell/StartupShell.tsx` remains the startup front door.
- `packages/ui/src/components/shell/FirstRunShell.tsx` owns owner, agent, and runtime selection.
- `packages/agent/src/api/first-run-routes.ts` remains the config-heavy first-run API owner.

## Non-Blocking Local Model Queue

`packages/ui/src/first-run/auto-download-recommended.ts` is explicitly fire-and-forget after local first-run completion. The launch snapshot records `localModel.blocking: false`; model download failures must stay diagnostic information, not a startup gate.
