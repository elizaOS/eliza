# Model selection

The owner chooses which models the agent uses for text and embeddings: a
local model it has downloaded, or a provider reached with a credential from
the vault. The local model assigned as active must be one of the installed
downloads; removing that download clears the assignment. A direct provider
is used only while the vault holds a credential for the active provider
profile; storing a credential for a profile replaces any earlier one, and
a direct provider in use for that profile goes on with the new one.
Downloads and their lifecycle are in [local inference
models](../../localInference/models.md); how providers are admitted at boot
is in [model providers](../plugins/modelProviders.md).

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
type Credential = { profile: str, key: int }
type HostModels = { local: LM::LocalModels, credentials: List[Credential], profile: str, activeKey: int, backend: Backend, clearedByRemoval: bool }
pure val initial: HostModels = { local: LM::initial, credentials: List(), profile: "", activeKey: 0, backend: NoBackend, clearedByRemoval: false }
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
pure def holdsCredential(m: HostModels, profile: str): bool = m.credentials.some(c => c.profile == profile)
pure def keyOf(m: HostModels, profile: str): int = m.credentials.foldl(0, (found, c) => if (c.profile == profile) c.key else found)
pure def canStoreCredential(m: HostModels, profile: str, key: int): bool = profile != "" and key > 0
pure def storeCredential(m: HostModels, profile: str, key: int): HostModels =
  { ...m, credentials: m.credentials.select(c => c.profile != profile).append({ profile: profile, key: key }),
    activeKey: if (m.backend == DirectBackend and m.profile == profile) key else m.activeKey }
pure def canUseDirectProvider(m: HostModels, profile: str): bool = holdsCredential(m, profile)
pure def useDirectProvider(m: HostModels, profile: str): HostModels = { ...m, profile: profile, activeKey: keyOf(m, profile), backend: DirectBackend }
pure def canRevokeCredential(m: HostModels, profile: str): bool = holdsCredential(m, profile)
pure def revokeCredential(m: HostModels, profile: str): HostModels =
  { ...m, credentials: m.credentials.select(c => c.profile != profile), backend: if (m.backend == DirectBackend and m.profile == profile) NoBackend else m.backend }
pure val keyValues = Set(1, 2)
pure def alwaysOneCredentialPerProfile(m: HostModels): bool =
  m.credentials.every(c => c.key > 0 and m.credentials.select(d => d.profile == c.profile).length() == 1)
pure def alwaysDirectProviderHasCredential(m: HostModels): bool =
  m.backend == DirectBackend implies m.credentials.includes({ profile: m.profile, key: m.activeKey })
pure def sometimesReplacedKeyInUse(m: HostModels): bool = m.backend == DirectBackend and m.activeKey == 2
pure def sometimesDirectProviderInUse(m: HostModels): bool = m.backend == DirectBackend
```
