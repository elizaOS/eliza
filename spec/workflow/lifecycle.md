# Workflow removal, restoration and definition receipts

The owner removes and restores a workflow definition and edits its
metadata; [admission](./admission.md) owns the runs. This model follows one
definition and its retained lifecycle mutations.

## Story: Remove a workflow only when its runs are settled and restore it safely

> As the owner, I want to remove a workflow only once its runs have finished, to
> restore it inactive, and to get the same answer when I retry a request.

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
pure val initial: Lifecycle = { owner: "", version: 0, active: false, removed: false, cleaned: false, unfinished: false, receipts: List(), reply: NoLifecycleReply, replyVersion: 0, replyKey: "" }
pure def canSelectDefinition(l: Lifecycle, by: str): bool = l.owner == "" and by != ""
pure def selectDefinition(l: Lifecycle, by: str): Lifecycle = { ...l, owner: by, version: 1, active: true }
pure def canObserveRuns(l: Lifecycle): bool = l.owner != ""
pure def observeRuns(l: Lifecycle, unfinished: bool): Lifecycle = { ...l, unfinished: unfinished }
pure val noReceipt: LifecycleReceipt = { mutation: "", operation: RemoveDefinition, fromVersion: 0, toVersion: 0 }
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

## Story: Change the workflow I named in my own words

> As the owner, I want a chat request that names a workflow to create,
> rename or remove exactly the one I named, and to be asked first when my
> words name it only in part.

### A whole-message workflow command binds its operation and its names to the owner's words

The owner's own words in the request the host bound to the turn, or the
message's own text without its envelopes, are a whole-message command when
they are, apart from a greeting, please, a can or would you, a closing
please or for me and the closing punctuation, exactly one of: create, make,
add, set up or build a (new) workflow called, named or titled a name, or
start a new workflow called one; rename the workflow X to Y, or rename the X
workflow to Y; delete or remove the workflow X, or the X workflow; list,
show or what are my workflows, or what workflows do I have. A name is one
to six words of at most 80 characters, optionally quoted, without its own
full stop, inside or outside its closing quote. A name that opens with a quote mark loses that mark and one
closing mark of its kind, straight or curly, at its end, so "'Parents' Day'"
names Parents' Day; an apostrophe inside or at the end of an unquoted name
(Mom’s birthday, Parents') is part of it. A name with a clause word (that,
which, to, and, then, every, at, for, not and the like), a name that only
describes a workflow ("the new one", "this", "the latest") or a pronoun
clause ("the one I just made") is no name, and then the words are no
command. A change the planner proposes on a turn with a command runs only
as that command, with the command's names and the owner's words as its
instruction; the planner's workflow ID is kept only to choose among
same-named workflows. A different change, or a change on a list command, is
refused with nothing changed. A read is never bound.

Such a command routes the whole turn to WORKFLOW in the general and
automation contexts, in place of view navigation, whatever the first stage
judged of it, so a create is never lost to a clarification. A list command
that says show is view navigation where the host declares a view named
workflows; list, what are and what workflows do I have always route. A
route only chooses WORKFLOW: it creates, renames or removes nothing itself.

```quint
type WorkflowCommand = CreateCommand | RenameCommand | RemoveCommand | ListCommand | NoCommand
type ProposedWorkflowChange = ProposedCreate | ProposedRename | ProposedRemove | ProposedOtherChange | ProposedRead
type CommandBinding = RunAsProposed | RunAsCommand | RefuseConflict
pure def commandMatches(command: WorkflowCommand, proposed: ProposedWorkflowChange): bool =
  (command == CreateCommand and proposed == ProposedCreate) or (command == RenameCommand and proposed == ProposedRename)
    or (command == RemoveCommand and proposed == ProposedRemove)
pure def bindToCommand(command: WorkflowCommand, proposed: ProposedWorkflowChange): CommandBinding =
  if (proposed == ProposedRead or command == NoCommand) RunAsProposed
  else if (commandMatches(command, proposed)) RunAsCommand
  else RefuseConflict
pure def lawAReadIsNeverBound(command: WorkflowCommand): bool = bindToCommand(command, ProposedRead) == RunAsProposed
pure def lawAListCommandRefusesEveryChange(proposed: ProposedWorkflowChange): bool =
  proposed != ProposedRead implies bindToCommand(ListCommand, proposed) == RefuseConflict
pure def lawAnotherChangeIsRefused(command: WorkflowCommand, proposed: ProposedWorkflowChange): bool =
  (command != NoCommand and proposed != ProposedRead and not(commandMatches(command, proposed))) implies bindToCommand(command, proposed) == RefuseConflict
pure def commandRoutes(command: WorkflowCommand, saysShow: bool, workflowsView: bool): bool =
  command != NoCommand and not(command == ListCommand and saysShow and workflowsView)
pure def lawAChangeCommandAlwaysRoutes(saysShow: bool, workflowsView: bool): bool =
  commandRoutes(CreateCommand, saysShow, workflowsView) and commandRoutes(RenameCommand, saysShow, workflowsView) and commandRoutes(RemoveCommand, saysShow, workflowsView)
pure def lawShowStaysWithTheView(workflowsView: bool): bool = commandRoutes(ListCommand, true, workflowsView) iff not(workflowsView)
```

### A workflow reference resolves to the one workflow the owner named, and a remove or rename never acts on part of a name

A name is compared after NFKC folding, lowercasing, dropping quotes and
collapsing spaces. It names a workflow in full when it is that workflow's
name, or the same once the, my, workflow(s) and automation(s) are set aside
on both sides; it names it in part when it is whole words of the name,
with a plural only after a word of four or more letters. The first of the
two full tiers with a match wins. One full match is the workflow; several
are ambiguous unless the planner's ID is one of them. A planner ID read
beside a planner's name must agree with it, or nothing changes; beside the
owner's own words, a name that names no workflow in full falls back to the
ID only when the ID's workflow answers the name. One partial match is the
workflow, except that a remove or rename asks the owner first and does
nothing in the turn. Several partial matches are ambiguous, and no match
lists the workflows. A restore looks a name up among removed workflows
only, and every other operation among current ones; an ID reads its
workflow in either list, and an ID that names no workflow is read as a
name. The workflow found is then answered by its state: a restore of a
current workflow says it is not removed, a remove of a removed one says it
is already removed, and any other change or a run of a removed one says it
was removed and must be restored first, each with nothing changed; a read
answers either. Same-named workflows are told
apart by their on state and creation time in the owner's zone: the turn's
observed zone, else the zone the phone's interface reported, else the
agent's TIMEZONE setting, else the host's, else UTC.

```quint
type WorkflowResolution = RefResolved | RefAmbiguous | RefConfirmFirst | RefNotFound | RefMismatch | RefMissing
pure def resolveWorkflow(idFound: bool, nameGiven: bool, referenced: bool, ownerWords: bool, idAgrees: bool,
  fullMatches: int, idAmongFull: bool, partialMatches: int, strict: bool): WorkflowResolution =
  if (idFound and not(nameGiven)) RefResolved
  else if (idFound and not(ownerWords)) (if (idAgrees) RefResolved else RefMismatch)
  else if (not(referenced)) RefMissing
  else if (fullMatches == 1) RefResolved
  else if (fullMatches > 1) (if (idFound and idAmongFull) RefResolved else RefAmbiguous)
  else if (idFound and not(idAgrees)) RefMismatch
  else if (idFound and not(strict)) RefResolved
  else if (partialMatches == 1) (if (strict) RefConfirmFirst else RefResolved)
  else if (partialMatches > 1) RefAmbiguous
  else RefNotFound
pure val fullMatchesValues = Set(0, 1, 2)
pure val partialMatchesValues = Set(0, 1, 2)
pure def lawAPartNeverRemovesOrRenames(ownerWords: bool, idAgrees: bool, idAmongFull: bool): bool =
  resolveWorkflow(false, true, true, ownerWords, idAgrees, 0, idAmongFull, 1, true) == RefConfirmFirst
pure def lawSameNamedWorkflowsNeedAChoice(ownerWords: bool, idAgrees: bool, partialMatches: int, strict: bool): bool =
  resolveWorkflow(false, true, true, ownerWords, idAgrees, 2, false, partialMatches, strict) == RefAmbiguous
pure def lawAMispairedPlannerIdChangesNothing(fullMatches: int, idAmongFull: bool, partialMatches: int, strict: bool): bool =
  resolveWorkflow(true, true, true, false, false, fullMatches, idAmongFull, partialMatches, strict) == RefMismatch
type ReferenceOp = RestoreReference | RemoveReference | ReadReference | ChangeReference
type ReferenceAnswer = ActOnWorkflow | NotRemovedAnswer | AlreadyRemovedAnswer | RestoreFirstAnswer
pure def referenceAnswer(op: ReferenceOp, removed: bool): ReferenceAnswer =
  if (op == RestoreReference) (if (removed) ActOnWorkflow else NotRemovedAnswer)
  else if (op == ReadReference or not(removed)) ActOnWorkflow
  else if (op == RemoveReference) AlreadyRemovedAnswer
  else RestoreFirstAnswer
pure def lawARemovedWorkflowIsOnlyReadOrRestored(op: ReferenceOp): bool =
  referenceAnswer(op, true) == ActOnWorkflow implies (op == RestoreReference or op == ReadReference)
pure def lawOnlyARemovedWorkflowIsRestored(removed: bool): bool = referenceAnswer(RestoreReference, removed) == ActOnWorkflow iff removed
```

### A workflow the owner names never shares its name

A create that carries the owner's own name for it is refused with nothing
created when a current workflow already has that name; a name the drafting
model chose takes the next free number instead. A rename to a name another
current workflow has is refused with nothing changed.

```quint
type CreatedName = OwnerChosenName | DraftedName
type NamingOutcome = KeepsName | TakesNumber | NameRefused
pure def createdName(source: CreatedName, taken: bool): NamingOutcome =
  if (not(taken)) KeepsName else if (source == OwnerChosenName) NameRefused else TakesNumber
pure def lawAnOwnerNameIsNeverNumbered(taken: bool): bool = createdName(OwnerChosenName, taken) != TakesNumber
pure def lawAFreeNameIsKept(source: CreatedName): bool = createdName(source, false) == KeepsName
```

## Story: Hear from chat what my workflows are and what happened to them

> As the owner, I want chat to find a workflow by what it does, to show a
> run's steps as it goes, and to tell me plainly when a change may have
> gone through or my workflows could not be read.

A list or search names each workflow with its on state and says when it
shows only the first of them. A run started from chat answers with the
workflow's run card: its run, title and steps, each pending. A created
workflow carries its workflow card.

### A search ranks workflows by how many of its words their name or description holds

A search splits its words on spaces and scores each current workflow by how
many of them its name or description contains, ignoring case. A workflow
that holds none is left out, and the rest are listed highest score first,
ties by ID. The workflows context the agent reads on a turn that mentions
workflows is that search over the owner's own words.

```quint
pure def searchScore(hits: List[bool]): int = hits.foldl(0, (score, hit) => if (hit) score + 1 else score)
pure def searchKeeps(hits: List[bool]): bool = searchScore(hits) > 0
pure def lawEachWordCountsOnce(hits: List[bool]): bool = searchScore(hits) >= 0 and searchScore(hits) <= hits.length()
pure def lawAWorkflowWithNoWordIsLeftOut(hits: List[bool]): bool = searchKeeps(hits) iff hits.some(hit => hit)
```

### Only a change refused before it wrote says nothing changed, and an unread list is never an empty one

A change the service refused before it wrote anything (a malformed
request, a missing workflow, a rejected draft or code check, or a
refusal it names as not applied) says nothing was changed and may be
retried. Any other failure of a change, such as a failed readback after a
save, may have committed: it asks the owner to check before trying again,
and is not retried. A failed read says the read failed. The workflows
context the agent reads reports a failed read as a failure, never as the
owner having no workflows, and a search that matches nothing says so.

```quint
type FailureReport = ReadFailed | NothingChanged | ReconcileFirst
pure def failureReport(read: bool, beforeWrite: bool): FailureReport =
  if (read) ReadFailed else if (beforeWrite) NothingChanged else ReconcileFirst
type WorkflowListing = ListingFailed | NoWorkflows | NoMatches | Listed
pure def workflowListing(readOk: bool, searched: bool, shown: int): WorkflowListing =
  if (not(readOk)) ListingFailed else if (shown > 0) Listed else if (searched) NoMatches else NoWorkflows
pure val shownValues = Set(0, 1, 2)
pure def lawOnlyAnUnwrittenChangeSaysNothingChanged(read: bool, beforeWrite: bool): bool =
  failureReport(read, beforeWrite) == NothingChanged iff (not(read) and beforeWrite)
pure def lawAFailedReadIsNeverEmpty(searched: bool, shown: int): bool = workflowListing(false, searched, shown) == ListingFailed
```
