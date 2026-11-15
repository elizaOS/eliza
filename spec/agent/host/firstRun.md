# First run

The first time the host starts for an owner, it walks them through choosing
a name and a provider for inference, either a cloud key or a local model.
First-run status only moves forward: once completed it stays completed,
and setup never runs again over the owner's choices. A cloud key provided
during or after setup is written to the live configuration and takes effect
without a restart. The research baseline is
`packages/agent/src/api/{onboarding-routes,first-run}.ts` and
`runtime/first-run-names.ts`. The name and character chosen here are kept
as described in [character](./character.md); model choice is in
[model selection](./models.md).

## Story: Complete first run with a cloud or local provider

> As a new owner, I set up my agent once, with a cloud key or a local
> model, and it is ready to talk without restarting.

### First-run status only moves forward

```quint
type FirstRunStatus = NotStarted | InProgress | Completed
type Provider = NoProvider | CloudProvider | LocalProvider
type FirstRun = { status: FirstRunStatus, provider: Provider, cloudKeyStored: bool, cloudKeyLive: bool, restarts: int }
pure val initial: FirstRun = { status: NotStarted, provider: NoProvider, cloudKeyStored: false, cloudKeyLive: false, restarts: 0 }
pure def rank(status: FirstRunStatus): int = if (status == NotStarted) 0 else if (status == InProgress) 1 else 2
pure def canBeginFirstRun(f: FirstRun): bool = f.status == NotStarted
pure def beginFirstRun(f: FirstRun): FirstRun = { ...f, status: InProgress }
pure def stepFirstRunNeverGoesBack(before: FirstRun, after: FirstRun): bool = rank(after.status) >= rank(before.status)
```

### Setup completes only once a provider is chosen

```quint
pure val providerValues = Set(CloudProvider, LocalProvider)
pure def canChooseProvider(f: FirstRun, provider: Provider): bool = f.status == InProgress and provider != NoProvider and (provider != CloudProvider or f.cloudKeyStored)
pure def chooseProvider(f: FirstRun, provider: Provider): FirstRun = { ...f, provider: provider }
pure def canCompleteFirstRun(f: FirstRun): bool = f.status == InProgress and f.provider != NoProvider
pure def completeFirstRun(f: FirstRun): FirstRun = { ...f, status: Completed }
pure def alwaysCompletedHasProvider(f: FirstRun): bool =
  (f.status == Completed implies f.provider != NoProvider) and (f.provider == CloudProvider implies f.cloudKeyStored)
pure def sometimesCompletedWithLocalModel(f: FirstRun): bool = f.status == Completed and f.provider == LocalProvider
```

### A cloud key is applied to the live configuration without a restart

```quint
pure def canProvideCloudKey(f: FirstRun): bool = f.status != NotStarted
pure def provideCloudKey(f: FirstRun): FirstRun = { ...f, cloudKeyStored: true, cloudKeyLive: true }
pure def canRestartHost(f: FirstRun): bool = f.status == Completed
pure def restartHost(f: FirstRun): FirstRun = { ...f, restarts: f.restarts + 1 }
pure def alwaysStoredKeyIsLive(f: FirstRun): bool = f.cloudKeyStored iff f.cloudKeyLive
pure def stepCloudKeyNeedsNoRestart(before: FirstRun, via: str, after: FirstRun): bool =
  via == "provideCloudKey" implies after.cloudKeyLive and after.restarts == before.restarts
pure def sometimesCompletedWithCloudKey(f: FirstRun): bool = f.status == Completed and f.provider == CloudProvider and f.restarts == 0
```
