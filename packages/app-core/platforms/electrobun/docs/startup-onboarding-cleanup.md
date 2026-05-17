# Startup And Onboarding Cleanup

Startup and onboarding remain Electrobun core boot infrastructure. They are not Satellite candidates because the host, renderer, AgentManager, boot RPC, auth gate, onboarding gate, and first-party Satellite seeding all depend on the shell being alive first.

## Current Paths

- `packages/app-core/platforms/electrobun/src/native/agent.ts` owns embedded runtime lifecycle, diagnostics files, health polling, retry, restart, and bug-report bundle inputs.
- `packages/app-core/platforms/electrobun/src/boot-progress.ts` composes typed `bootProgress` from AgentManager status and `/api/health`.
- `packages/app-core/platforms/electrobun/src/config-and-auth-rpc.ts` composes typed auth gate snapshots.
- `packages/app-core/platforms/electrobun/src/onboarding-rpc.ts` composes typed onboarding status and options snapshots.
- `packages/app-core/platforms/electrobun/src/first-party-satellites.ts` seeds first-party Satellites after the main Electrobun window is alive.
- `packages/ui/src/components/shell/StartupShell.tsx` remains the startup front door.
- `packages/ui/src/components/shell/RuntimeGate.tsx` remains the minimal Cloud, Local, or Remote runtime chooser.
- `packages/agent/src/api/onboarding-routes.ts` remains the config-heavy onboarding API owner.

## Non-Blocking Local Model Queue

`packages/ui/src/onboarding/auto-download-recommended.ts` is explicitly fire-and-forget from `RuntimeGate`. The launch snapshot records `localModel.blocking: false`; model download failures must stay diagnostic information, not a startup gate.

## Legacy Review Candidates

| Path | Reason | Safe Now | Owner Decision |
| --- | --- | --- | --- |
| `packages/ui/src/onboarding/flow.ts` if still present | Old wizard step-order helper after the RuntimeGate reduction. | No | Yes |
| `packages/ui/src/onboarding/REIMAGINED-DEFERRED.md` | Historical onboarding plan that may contradict the current minimal gate. | No | Yes |
| Generated `.d.ts` siblings under `packages/ui/src/onboarding` | Generated artifacts may be stale depending on package build policy. | No | Yes |

Deletion should wait until callers are verified and maintainers confirm whether generated declaration files are source-controlled intentionally.
