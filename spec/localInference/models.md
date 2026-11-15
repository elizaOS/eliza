# Local models

The device keeps a curated catalog of models it may run. A model is
downloaded, verified and installed; assigned to the model slots the agent
uses (small and large text, embeddings, speech output and transcription);
and one installed model is active, loaded into the inference engine. The
agent host's model settings read this state; a client changes it only
through these events.

Each catalog model has a role: a chat model serves every slot, an
embedding model only the embedding slot. The model's manifest records
whether its evaluations passed; a model whose evaluations failed is a
candidate that may be installed and inspected but never activated.

## Story: Run a model of my choice on my device

> As an owner, I want to download a model, choose which model serves each
> kind of request, and switch the active model, without the agent ever
> pointing at a model that is not on the device.

### Only a model in the curated catalog is downloaded, and only when it is not already present

```quint
type ModelRole = ChatRole | EmbeddingRole
type InstallPhase = NotInstalled | Downloading | Installed
type LocalModel = { role: ModelRole, install: InstallPhase, evalsPassed: bool }
type ModelSlot = TextSmallSlot | TextLargeSlot | EmbeddingSlot | SpeechSlot | TranscriptionSlot
type ActiveStatus = ActiveIdle | ActiveLoading | ActiveReady | ActiveFailed
type LocalModels = { models: str -> LocalModel, active: str, activeStatus: ActiveStatus, assignments: ModelSlot -> str, assignmentsReadable: bool }
pure val catalog = Set("model1", "model2")
pure val absentModel: LocalModel = { role: ChatRole, install: NotInstalled, evalsPassed: false }
pure val allSlots = List(TextSmallSlot, TextLargeSlot, EmbeddingSlot, SpeechSlot, TranscriptionSlot)
pure val initial: LocalModels = {
  models: Map().put("model1", { role: ChatRole, install: NotInstalled, evalsPassed: false }).put("model2", { role: EmbeddingRole, install: NotInstalled, evalsPassed: false }),
  active: "", activeStatus: ActiveIdle, assignments: Map(), assignmentsReadable: true
}
pure def modelOf(s: LocalModels, modelId: str): LocalModel = s.models.getOr(modelId, absentModel)
pure def installed(s: LocalModels, modelId: str): bool = catalog.contains(modelId) and modelOf(s, modelId).install == Installed
pure def assignedTo(s: LocalModels, slot: ModelSlot): str = s.assignments.getOr(slot, "")
pure def withInstall(modelId: str, s: LocalModels, install: InstallPhase, evalsPassed: bool): LocalModels =
  { ...s, models: s.models.put(modelId, { ...modelOf(s, modelId), install: install, evalsPassed: evalsPassed }) }
pure val modelIdValues = Set("model1", "model2", "model3")
pure def canStartDownload(s: LocalModels, modelId: str): bool = catalog.contains(modelId) and modelOf(s, modelId).install == NotInstalled
pure def startDownload(s: LocalModels, modelId: str): LocalModels = withInstall(modelId, s, Downloading, false)
```

### A download is installed only when every file matches its published digest

A download whose bytes do not match is discarded, and so is a cancelled
download: the model stays absent. An installed model records whether its
manifest's evaluations passed.

```quint
pure def canCancelDownload(s: LocalModels, modelId: str): bool = modelOf(s, modelId).install == Downloading
pure def cancelDownload(s: LocalModels, modelId: str): LocalModels = withInstall(modelId, s, NotInstalled, false)
pure def canFinishDownload(s: LocalModels, modelId: str): bool = modelOf(s, modelId).install == Downloading
pure def finishDownload(s: LocalModels, modelId: str, digestMatches: bool, evalsPassed: bool): LocalModels =
  if (digestMatches) withInstall(modelId, s, Installed, evalsPassed) else withInstall(modelId, s, NotInstalled, false)
```

### A slot is assigned only to an installed model whose role serves it, one slot per change

An embedding model serves only the embedding slot. Assigning or clearing
one slot reads, changes and writes the assignments under one lock, so two
changes never lose one another and no other slot changes.

```quint
pure def servesSlot(role: ModelRole, slot: ModelSlot): bool = role == ChatRole or slot == EmbeddingSlot
pure def canAssignModel(s: LocalModels, slot: ModelSlot, modelId: str): bool =
  s.assignmentsReadable and installed(s, modelId) and servesSlot(modelOf(s, modelId).role, slot)
pure def assignModel(s: LocalModels, slot: ModelSlot, modelId: str): LocalModels = { ...s, assignments: s.assignments.put(slot, modelId) }
pure def canClearAssignment(s: LocalModels, slot: ModelSlot): bool = s.assignmentsReadable
pure def clearAssignment(s: LocalModels, slot: ModelSlot): LocalModels = { ...s, assignments: s.assignments.put(slot, "") }
pure def slotsChanged(before: LocalModels, after: LocalModels): int =
  allSlots.foldl(0, (n, slot) => if (assignedTo(before, slot) != assignedTo(after, slot)) n + 1 else n)
pure def stepOneAssignmentPerChange(before: LocalModels, via: str, after: LocalModels): bool =
  (via == "assignModel" or via == "clearAssignment") implies slotsChanged(before, after) <= 1
pure def alwaysSlotsMatchTheirModelsRole(s: LocalModels): bool =
  allSlots.foldl(true, (ok, slot) => ok and (assignedTo(s, slot) == "" or servesSlot(modelOf(s, assignedTo(s, slot)).role, slot)))
```

### An unreadable assignment record is reported, never rewritten from empty

When the stored assignments cannot be read, nothing that writes them is
allowed until they are readable again, so the owner's choices are never
replaced by an empty default.

```quint
pure def canAssignmentsUnreadable(s: LocalModels): bool = s.assignmentsReadable
pure def assignmentsUnreadable(s: LocalModels): LocalModels = { ...s, assignmentsReadable: false }
pure def canAssignmentsRepaired(s: LocalModels): bool = not(s.assignmentsReadable)
pure def assignmentsRepaired(s: LocalModels): LocalModels = { ...s, assignmentsReadable: true }
pure def stepUnreadableAssignmentsAreKept(before: LocalModels, after: LocalModels): bool =
  not(before.assignmentsReadable) implies slotsChanged(before, after) == 0
```

### Only an installed model whose evaluations passed is activated

Activation assigns the model to every slot its role serves and starts
loading it. Loading ends ready or failed. No model is loading or loaded
exactly when none is active.

```quint
pure def canActivateModel(s: LocalModels, modelId: str): bool =
  installed(s, modelId) and modelOf(s, modelId).evalsPassed and s.assignmentsReadable and s.activeStatus != ActiveLoading
pure def activateModel(s: LocalModels, modelId: str): LocalModels = {
  val role = modelOf(s, modelId).role
  { ...s, active: modelId, activeStatus: ActiveLoading,
    assignments: allSlots.foldl(s.assignments, (m, slot) => if (servesSlot(role, slot)) m.put(slot, modelId) else m) }
}
pure def canFinishLoading(s: LocalModels, loaded: bool): bool = s.activeStatus == ActiveLoading
pure def finishLoading(s: LocalModels, loaded: bool): LocalModels = { ...s, activeStatus: if (loaded) ActiveReady else ActiveFailed }
pure def canDeactivateModel(s: LocalModels): bool = s.active != ""
pure def deactivateModel(s: LocalModels): LocalModels = { ...s, active: "", activeStatus: ActiveIdle }
pure def alwaysActiveModelPassedItsChecks(s: LocalModels): bool =
  (s.active == "") == (s.activeStatus == ActiveIdle) and (s.active != "" implies (installed(s, s.active) and modelOf(s, s.active).evalsPassed))
```

### Removing a model first unloads it and clears every slot that named it

The registry entry and files are removed only together with the slots
that named the model, so no slot and no active model ever names a model
that is not on the device.

```quint
pure def canUninstallModel(s: LocalModels, modelId: str): bool = installed(s, modelId) and s.assignmentsReadable
pure def uninstallModel(s: LocalModels, modelId: str): LocalModels = {
  val unloaded = if (s.active == modelId) { ...s, active: "", activeStatus: ActiveIdle } else s
  { ...withInstall(modelId, unloaded, NotInstalled, false),
    assignments: allSlots.foldl(s.assignments, (m, slot) => if (m.getOr(slot, "") == modelId) m.put(slot, "") else m) }
}
pure def alwaysAssignedModelsAreInstalled(s: LocalModels): bool =
  allSlots.foldl(true, (ok, slot) => ok and (assignedTo(s, slot) == "" or installed(s, assignedTo(s, slot))))
```

### Loading a model settles

```quint
pure val fair_finishLoading = "weak"
pure def leadsToLoadingSettles(s: LocalModels, later: LocalModels): bool =
  s.activeStatus == ActiveLoading implies later.activeStatus != ActiveLoading
```

### A model can be downloaded, assigned, activated, and kept assigned while its record is unreadable

```quint
pure def sometimesActiveModelReady(s: LocalModels): bool = s.activeStatus == ActiveReady
pure def sometimesLoadFailed(s: LocalModels): bool = s.activeStatus == ActiveFailed
pure def sometimesEmbeddingModelAssigned(s: LocalModels): bool = assignedTo(s, EmbeddingSlot) == "model2"
pure def sometimesUnreadableAssignmentsKept(s: LocalModels): bool = not(s.assignmentsReadable) and assignedTo(s, TextLargeSlot) != ""
pure def sometimesCandidateInstalled(s: LocalModels): bool = installed(s, "model1") and not(modelOf(s, "model1").evalsPassed)
```
