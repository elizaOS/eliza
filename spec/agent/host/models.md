# Model selection

The owner chooses which models the agent uses for text and embeddings:
a local model it has downloaded, or a provider reached with a credential
from the vault. The local model assigned as active must be one of the
installed downloads; removing that download clears the assignment. A
direct provider is used only while the vault holds a credential for the
active provider profile. Downloads and their lifecycle are in
[local inference models](../../localInference/models.md); how providers are
admitted at boot is in [model providers](../plugins/modelProviders.md).
The research baseline is `packages/agent/src/api/{models-routes,local-inference-routes}.ts`
and `runtime/model-assignments.ts`.

## Story: Choose text and embedding models

> As the owner, I pick which model my agent thinks with, and it never
> points at a model I deleted or a provider it has no key for.

### The local backend runs only the active model, which is installed

Downloading, activating and removing a model are the
[local models](../../localInference/models.md) events; the host uses its
local backend only while one of them is active, and removing the active
model leaves the host with no backend until the owner chooses again.

```quint
import models as LM from "../../localInference/models"
type Backend = NoBackend | LocalBackend | DirectBackend
type HostModels = { local: LM::LocalModels, credentials: Set[str], profile: str, backend: Backend, clearedByRemoval: bool }
pure val initial: HostModels = { local: LM::initial, credentials: Set(), profile: "", backend: NoBackend, clearedByRemoval: false }
pure def canDownloadModel(m: HostModels, modelId: str): bool = LM::canStartDownload(m.local, modelId)
pure def downloadModel(m: HostModels, modelId: str): HostModels = { ...m, local: LM::startDownload(m.local, modelId) }
pure def canFinishDownload(m: HostModels, modelId: str): bool = LM::canFinishDownload(m.local, modelId)
pure def finishDownload(m: HostModels, modelId: str, digestMatches: bool, evalsPassed: bool): HostModels =
  { ...m, local: LM::finishDownload(m.local, modelId, digestMatches, evalsPassed) }
pure def canUseLocalModel(m: HostModels, modelId: str): bool = LM::canActivateModel(m.local, modelId)
pure def useLocalModel(m: HostModels, modelId: str): HostModels =
  { ...m, local: LM::activateModel(m.local, modelId), backend: LocalBackend, clearedByRemoval: false }
pure def canRemoveModel(m: HostModels, modelId: str): bool = LM::canUninstallModel(m.local, modelId)
pure def removeModel(m: HostModels, modelId: str): HostModels = {
  val remaining = LM::uninstallModel(m.local, modelId)
  val cleared = m.backend == LocalBackend and remaining.active == ""
  { ...m, local: remaining, backend: if (cleared) NoBackend else m.backend, clearedByRemoval: cleared }
}
pure def alwaysActiveLocalIsInstalled(m: HostModels): bool =
  (m.local.active == "" or LM::installed(m.local, m.local.active)) and (m.backend == LocalBackend implies m.local.active != "")
pure def sometimesAssignmentClearedByRemoval(m: HostModels): bool = m.clearedByRemoval and m.backend == NoBackend
```

### A direct provider is used only while the vault holds a credential for the active profile

```quint
pure def canStoreCredential(m: HostModels, profile: str): bool = profile != "" and not(m.credentials.contains(profile))
pure def storeCredential(m: HostModels, profile: str): HostModels = { ...m, credentials: m.credentials.union(Set(profile)) }
pure def canUseDirectProvider(m: HostModels, profile: str): bool = m.credentials.contains(profile)
pure def useDirectProvider(m: HostModels, profile: str): HostModels = { ...m, profile: profile, backend: DirectBackend }
pure def canRevokeCredential(m: HostModels, profile: str): bool = m.credentials.contains(profile)
pure def revokeCredential(m: HostModels, profile: str): HostModels =
  { ...m, credentials: m.credentials.exclude(Set(profile)), backend: if (m.backend == DirectBackend and m.profile == profile) NoBackend else m.backend }
pure def alwaysDirectProviderHasCredential(m: HostModels): bool = m.backend == DirectBackend implies m.credentials.contains(m.profile)
pure def sometimesDirectProviderInUse(m: HostModels): bool = m.backend == DirectBackend
```
