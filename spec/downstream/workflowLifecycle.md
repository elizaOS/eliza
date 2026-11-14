# Workflow removal, restoration and definition receipts

AlphaPhone's workflow UI uses `WorkflowClient` metadata and lifecycle
methods. `EmbeddedWorkflowService.changeLifecycle` and `changeMetadata`
are the pinned producer. `WorkflowLifecycleChange.qnt` and
`WorkflowScheduleTasks.qnt` supply tests for removal, cleanup, restore,
and race conditions. This model uses one definition and an unbounded retained lifecycle
mutation index. Workflow versions in the model are ordinals for
fresh UUIDs.

## Story: Remove a workflow only when its runs are settled and restore it safely

### A retained mutation has the same receipt after later definition changes

Removal requires an exact current version, all executions terminal, and
an owner authorized for that definition. It atomically archives the
workflow, disables it and marks cleanup pending. Cleanup happens outside
that transaction. Restore requires completed cleanup, a current version,
and no unfinished runs. Restore returns inactive. The transaction stores
the mutation key, expected version and operation together with the exact
resulting version and timestamp. The client can recover that receipt
under the same owner. A replay checks the prior key before checking the
current version. A key cannot change action or expected version.

```quint
type LifecycleAction = RemoveDefinition | RestoreDefinition
type LifecycleReply = NoLifecycleReply | SavedLifecycle | ReplayedLifecycle | RefusedLifecycle | AmbiguousLifecycle
type LifecycleReceipt = { mutation: str, operation: LifecycleAction, fromVersion: int, toVersion: int }
type Lifecycle = { owner: str, version: int, active: bool, removed: bool, cleaned: bool, unfinished: bool, receipts: List[LifecycleReceipt], reply: LifecycleReply, replyVersion: int, replyKey: str }
pure val removeDefinition: LifecycleAction = RemoveDefinition
pure val initial: Lifecycle = { owner: "", version: 0, active: false, removed: false, cleaned: false, unfinished: false, receipts: List(), reply: NoLifecycleReply, replyVersion: 0, replyKey: "" }
pure def canSelectDefinition(l: Lifecycle, by: str): bool = l.owner == "" and by != ""
pure def selectDefinition(l: Lifecycle, by: str): Lifecycle = { ...l, owner: by, version: 1, active: true }
pure def canObserveRuns(l: Lifecycle): bool = l.owner != ""
pure def observeRuns(l: Lifecycle, unfinished: bool): Lifecycle = { ...l, unfinished: unfinished }
pure val noReceipt: LifecycleReceipt = { mutation: "", operation: removeDefinition, fromVersion: 0, toVersion: 0 }
pure def lifecycleReceipt(l: Lifecycle, mutation: str): LifecycleReceipt = l.receipts.select(row => row.mutation == mutation).nthOr(0, noReceipt)
pure def lifecycleReply(result: LifecycleReply, version: int, key: str, l: Lifecycle): Lifecycle = { ...l, reply: result, replyVersion: version, replyKey: key }
pure def changeLifecycle(l: Lifecycle, by: str, mutation: str, operation: LifecycleAction, expected: int): Lifecycle = {
  val retained = lifecycleReceipt(l, mutation)
  if (l.owner == "" or by != l.owner or mutation == "") lifecycleReply(RefusedLifecycle, 0, "", l)
  else if (retained.mutation != "") {
    if (operation == retained.operation and expected == retained.fromVersion) lifecycleReply(ReplayedLifecycle, retained.toVersion, mutation, l)
    else lifecycleReply(RefusedLifecycle, 0, "", l)
  } else if (expected != l.version or l.unfinished or (operation == RemoveDefinition and l.removed) or (operation == RestoreDefinition and (not(l.removed) or not(l.cleaned)))) lifecycleReply(RefusedLifecycle, 0, "", l)
  else { ...lifecycleReply(SavedLifecycle, l.version + 1, mutation, l), version: l.version + 1, active: false, removed: operation == RemoveDefinition, cleaned: false, receipts: l.receipts.append({ mutation: mutation, operation: operation, fromVersion: expected, toVersion: l.version + 1 }) }
}
pure def canMarkCleanup(l: Lifecycle): bool = l.removed and not(l.cleaned)
pure def markCleanup(l: Lifecycle, confirmedEmpty: bool): Lifecycle = { ...l, cleaned: confirmedEmpty }
pure def canLoseLifecycleReply(l: Lifecycle): bool = l.reply == SavedLifecycle or l.reply == ReplayedLifecycle
pure def loseLifecycleReply(l: Lifecycle): Lifecycle = lifecycleReply(AmbiguousLifecycle, 0, "", l)
pure val byValues = Set("owner", "foreign")
pure val mutationValues = Set("", "mutation-a", "mutation-b")
pure val expectedValues = Set(1, 2, 3)
pure def alwaysDefinitionIsOwned(l: Lifecycle): bool = (l.owner == "" implies l.version == 0 and not(l.active) and not(l.removed) and l.receipts.length() == 0) and (l.owner != "" implies l.version > 0)
pure def alwaysRemovedInactive(l: Lifecycle): bool = (l.removed implies not(l.active)) and (l.cleaned implies l.removed)
pure def alwaysReceiptVersionsMatch(l: Lifecycle): bool = l.receipts.every(row => row.mutation != "" and row.fromVersion > 0 and row.toVersion == row.fromVersion + 1 and row.toVersion <= l.version)
pure def alwaysPublishedReceiptIsExact(l: Lifecycle): bool = if (l.reply == SavedLifecycle or l.reply == ReplayedLifecycle) l.replyKey != "" and l.replyVersion > 0 and l.replyVersion <= l.version and l.receipts.some(row => row.mutation == l.replyKey and row.toVersion == l.replyVersion) else l.replyVersion == 0 and l.replyKey == ""
pure def alwaysMutationsHaveUniqueKeys(l: Lifecycle): bool = l.receipts.every(row => l.receipts.select(other => other.mutation == row.mutation).length() == 1)
pure def stepRemovalDoesNotCancelRuns(before: Lifecycle, via: str, after: Lifecycle): bool = via == "changeLifecycle" implies before.unfinished == after.unfinished
pure def sometimesReplayedRemoval(l: Lifecycle): bool = l.removed and l.reply == ReplayedLifecycle
pure def sometimesRestoredInactive(l: Lifecycle): bool = not(l.removed) and not(l.active) and l.receipts.some(row => row.operation == RestoreDefinition)
```

Metadata mutations have a separate index. For an untyped definition,
their exact replay binds expected version, name and description and
preserves active state. Typed workflows use full-spec save.
