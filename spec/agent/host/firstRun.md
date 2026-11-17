# First run

The first time the host starts for an owner, it walks them through choosing
a name and a [model backend](./models.md) for inference: a cloud key or a
local model. First-run status only moves forward: once completed it stays
completed, and setup never runs again over the owner's choices. A cloud
key provided during or after setup is stored in the vault, replacing any
earlier one, and used at once, without a restart. The name and character chosen here are kept as
described in [character](./character.md).

## Story: Complete first run with a cloud or local provider

> As a new owner, I set up my agent once, with a cloud key or a local
> model, and it is ready to talk without restarting.

### First-run status only moves forward

```quint
import models as HM from "./models"
import models as LM from "../../localInference/models"
type FirstRunStatus = NotStarted | InProgress | Completed
type FirstRun = { status: FirstRunStatus, models: HM::HostModels, restarts: int }
pure val initial: FirstRun = { status: NotStarted, models: HM::initial, restarts: 0 }
pure def rank(status: FirstRunStatus): int = if (status == NotStarted) 0 else if (status == InProgress) 1 else 2
pure def canBeginFirstRun(f: FirstRun): bool = f.status == NotStarted
pure def beginFirstRun(f: FirstRun): FirstRun = { ...f, status: InProgress }
pure def stepFirstRunNeverGoesBack(before: FirstRun, after: FirstRun): bool = rank(after.status) >= rank(before.status)
```

### Setup completes only once a model backend is usable

The owner chooses a local model by downloading and activating it, as in
[model selection](./models.md), or chooses the cloud backend once a cloud
key is stored. A completed setup has a backend, and the backend obeys the
model selection rules: a local backend runs an installed model, and a
direct backend has its credential in the vault.

```quint
pure val modelIdValues = Set("model1", "model2")
pure def canDownloadModel(f: FirstRun, modelId: str): bool = f.status == InProgress and HM::canDownloadModel(f.models, modelId)
pure def downloadModel(f: FirstRun, modelId: str): FirstRun = { ...f, models: HM::downloadModel(f.models, modelId) }
pure def canFinishDownload(f: FirstRun, modelId: str): bool = HM::canFinishDownload(f.models, modelId)
pure def finishDownload(f: FirstRun, modelId: str, digestMatches: bool, evalsPassed: bool): FirstRun =
  { ...f, models: HM::finishDownload(f.models, modelId, digestMatches, evalsPassed) }
pure def canUseLocalModel(f: FirstRun, modelId: str): bool = f.status == InProgress and HM::canUseLocalModel(f.models, modelId)
pure def useLocalModel(f: FirstRun, modelId: str): FirstRun = { ...f, models: HM::useLocalModel(f.models, modelId) }
pure val cloudProfile = "cloud"
pure def canUseCloudKey(f: FirstRun): bool = f.status == InProgress and HM::canUseDirectProvider(f.models, cloudProfile)
pure def useCloudKey(f: FirstRun): FirstRun = { ...f, models: HM::useDirectProvider(f.models, cloudProfile) }
pure def canCompleteFirstRun(f: FirstRun): bool = f.status == InProgress and f.models.backend != HM::NoBackend
pure def completeFirstRun(f: FirstRun): FirstRun = { ...f, status: Completed }
pure def alwaysCompletedHasBackend(f: FirstRun): bool =
  (f.status == Completed implies f.models.backend != HM::NoBackend)
    and HM::alwaysDirectProviderHasCredential(f.models) and HM::alwaysOneCredentialPerProfile(f.models) and HM::alwaysActiveLocalIsInstalled(f.models)
pure def sometimesCompletedWithLocalModel(f: FirstRun): bool = f.status == Completed and f.models.backend == HM::LocalBackend
```

### A cloud key is used at once, without a restart

Providing a key stores it in the vault, replacing any earlier one, and
changes no backend the owner chose: a cloud backend in use goes on with the
new key, and a local one stays local.

```quint
pure def canProvideCloudKey(f: FirstRun, key: int): bool = f.status != NotStarted and HM::canStoreCredential(f.models, cloudProfile, key)
pure def provideCloudKey(f: FirstRun, key: int): FirstRun = { ...f, models: HM::storeCredential(f.models, cloudProfile, key) }
pure val keyValues = Set(1, 2)
pure def canRestartHost(f: FirstRun): bool = f.status == Completed
pure def restartHost(f: FirstRun): FirstRun = { ...f, restarts: f.restarts + 1 }
pure def stepCloudKeyNeedsNoRestart(before: FirstRun, via: str, after: FirstRun): bool =
  via == "provideCloudKey" implies
    HM::holdsCredential(after.models, cloudProfile) and after.models.backend == before.models.backend and after.restarts == before.restarts and
    (after.models.backend == HM::DirectBackend and after.models.profile == cloudProfile implies after.models.activeKey == HM::keyOf(after.models, cloudProfile))
pure def sometimesCompletedWithCloudKey(f: FirstRun): bool = f.status == Completed and f.models.backend == HM::DirectBackend and f.restarts == 0
```
