# Reviewed workflow admission

A consumer reaches a stored workflow through `WorkflowClient` in
`packages/contracts/src/workflow-client.ts`. The producer is the workflow
package's routes and its embedded workflow service. This spec owns run
admission by exact reviewed version, recovery of an ambiguous run reply, and
activation by reviewed version. Legacy requests that omit both reviewed-run
fields use the legacy run path. [Lifecycle](./lifecycle.md) owns removal and
restoration; [schedule](./schedule.md) owns occurrences; the
[request archive](./intents.md) owns the local intent.

## Story: Run the version I reviewed and recover an ambiguous response

> As the owner, I want a run I start to use exactly the version I reviewed, and a
> retry after a lost reply to find that run instead of starting another.

### One owner, workflow, submission, version and input survive a retry

A machine represents a stored definition in an authenticated tenant.
Submission keys are scoped to the tenant and definition. For the ordinary
reviewed run path, an existing key owned by a different caller gives 404,
and a key with different version or input gives a conflict. A matching
prior request returns its existing run even after a same-owner edit.
New submission and queued execution commit atomically before worker
startup. Querying for an unknown or foreign key returns null. Transport
loss changes the local result only. Typed errors name the exact attempted
workflow, version, and submission when the corresponding server refusal
is established. The hosted dossier variant uses an owner-scoped key
across definitions and is a separate admission obligation.

The input identity denotes exact validated JSON equality after cloning.
Opaque IDs are represented by positive allocation ordinals or strings.
The decoder and the tenant-selected database connection are boundary
refinements. The `by` parameter is supplied by the authenticated shell.

```quint
type Submission = { owner: str, version: int, inputKey: str, runId: int }
type RequestForm = ExactRequest | LegacyRequest | InvalidRequest
type RunReply = NoRunReply | QueuedRun | ExistingRun | MissingRun | VersionRefused | KeyConflict | InvalidRun | UnknownRun
type Workflow = { owner: str, version: int, serial: int, submissionIds: Set[str], submissions: str -> Submission, reply: RunReply, replyRun: int, active: bool, typed: bool, timed: bool, scheduleMatches: bool }
pure val emptySubmission: Submission = { owner: "", version: 0, inputKey: "", runId: 0 }
pure val initial: Workflow = { owner: "", version: 0, serial: 0, submissionIds: Set(), submissions: Map(), reply: NoRunReply, replyRun: 0, active: false, typed: false, timed: false, scheduleMatches: false }
pure def entry(w: Workflow, submission: str): Submission = w.submissions.getOr(submission, emptySubmission)
pure def canDefineWorkflow(w: Workflow, by: str, typed: bool, timed: bool, scheduleMatches: bool): bool = w.owner == "" and by != ""
pure def defineWorkflow(w: Workflow, by: str, typed: bool, timed: bool, scheduleMatches: bool): Workflow = { ...w, owner: by, version: 1, typed: typed, timed: timed, scheduleMatches: scheduleMatches }
pure def canEditWorkflow(w: Workflow, by: str): bool = w.owner != "" and w.owner == by
pure def editWorkflow(w: Workflow, by: str): Workflow = { ...w, version: w.version + 1 }
pure def respond(reply: RunReply, runId: int, w: Workflow): Workflow = { ...w, reply: reply, replyRun: runId }
pure def submitWorkflow(w: Workflow, by: str, form: RequestForm, submission: str, expected: int, inputKey: str): Workflow = {
  val prior = entry(w, submission)
  if (w.owner == "" or w.owner != by) respond(MissingRun, 0, w)
  else if (form == InvalidRequest or (form == ExactRequest and (submission == "" or expected <= 0))) respond(InvalidRun, 0, w)
  else if (form == LegacyRequest) { ...respond(QueuedRun, w.serial + 1, w), serial: w.serial + 1 }
  else if (w.submissionIds.contains(submission)) {
    if (prior.owner != by) respond(MissingRun, 0, w)
    else if (prior.version != expected or prior.inputKey != inputKey) respond(KeyConflict, 0, w)
    else respond(ExistingRun, prior.runId, w)
  } else if (expected != w.version) respond(VersionRefused, 0, w)
  else { ...respond(QueuedRun, w.serial + 1, w), serial: w.serial + 1, submissionIds: w.submissionIds.union(Set(submission)), submissions: w.submissions.put(submission, { owner: by, version: expected, inputKey: inputKey, runId: w.serial + 1 }) }
}
pure def readSubmission(w: Workflow, by: str, submission: str): Workflow = {
  val prior = entry(w, submission)
  if (w.submissionIds.contains(submission) and prior.owner == by and w.owner == by) respond(ExistingRun, prior.runId, w) else respond(MissingRun, 0, w)
}
pure def canLoseRunReply(w: Workflow): bool = w.reply == QueuedRun or w.reply == ExistingRun
pure def loseRunReply(w: Workflow): Workflow = respond(UnknownRun, 0, w)
pure val byValues = Set("owner", "foreign")
pure val submissionValues = Set("", "first", "second")
pure val expectedValues = Set(0, 1, 2, 3)
pure val inputKeyValues = Set("{}", "different input")
pure def alwaysDefinitionVersion(w: Workflow): bool = (w.owner == "" implies w.version == 0 and w.serial == 0 and w.submissionIds.size() == 0 and not(w.active)) and (w.owner != "" implies w.version > 0) and w.serial >= 0
pure def alwaysSubmittedRunHasIdentity(w: Workflow): bool = w.submissionIds.forall(id => id != "" and entry(w, id).owner == w.owner and entry(w, id).version > 0 and entry(w, id).version <= w.version and entry(w, id).runId > 0 and entry(w, id).runId <= w.serial)
pure def alwaysRunReplyIsExplicit(w: Workflow): bool = if (w.reply == QueuedRun or w.reply == ExistingRun) w.replyRun > 0 and w.replyRun <= w.serial else w.replyRun == 0
pure def stepRetainsSubmittedRuns(before: Workflow, after: Workflow): bool = before.submissionIds.forall(id => after.submissionIds.contains(id) and entry(after, id) == entry(before, id))
pure def sometimesReviewedRun(w: Workflow): bool = w.submissionIds.size() > 0 and w.reply == QueuedRun
pure def sometimesLostResponse(w: Workflow): bool = w.submissionIds.size() > 0 and w.reply == UnknownRun
pure def sometimesRecoveredAfterEdit(w: Workflow): bool = w.reply == ExistingRun and w.submissionIds.exists(id => entry(w, id).runId == w.replyRun and entry(w, id).version < w.version)
```

### Schedule activation compares the reviewed version at commit

Activate and deactivate lock the current definition, check any supplied
version, and publish a fresh version with the changed active bit. Typed
device activation requires an exact version, a time trigger, and the
schedule derived from the reviewed trigger. Legacy omission remains valid
for eligible untyped definitions. The client checks the returned workflow
identity and active bit. Scheduling synchronization follows the database
commit and can fail after it, so a transport error is not a rollback receipt.

```quint
pure def canChangeActivation(w: Workflow, by: str, form: RequestForm, expected: int, enable: bool): bool =
  w.owner != "" and w.owner == by and form != InvalidRequest and
  (form != ExactRequest or (expected > 0 and expected == w.version)) and
  (not(enable) or not(w.typed) or (form == ExactRequest and w.timed and w.scheduleMatches))
pure def changeActivation(w: Workflow, by: str, form: RequestForm, expected: int, enable: bool): Workflow = { ...w, active: enable, version: w.version + 1 }
pure def lawForeignOwnerCannotActivate(w: Workflow, by: str, form: RequestForm, expected: int): bool = w.owner != by implies not(canChangeActivation(w, by, form, expected, true))
pure def alwaysTypedActiveUsesReviewedSchedule(w: Workflow): bool = (w.active and w.typed) implies w.timed and w.scheduleMatches
pure def sometimesActiveTypedSchedule(w: Workflow): bool = w.active and w.typed
```

### An activation receipt names the version its own commit produced

Ported from the workflow package's activation-version model. The action
validates the optional expected version before the embedded service commits
under its write lock. A malformed version, a foreign caller or a selected
version that a concurrent edit has passed changes nothing and returns no
receipt. An omitted version keeps the legacy contract and activates the
latest version. A receipt names the version that this commit produced, so a
later edit never changes what it reports, and a lost reply never re-runs the
change.

```quint
pure def activationReceipt(w: Workflow, by: str, form: RequestForm, expected: int, enable: bool): int =
  if (canChangeActivation(w, by, form, expected, enable)) changeActivation(w, by, form, expected, enable).version else 0
pure def lawMalformedActivationNeverMutates(w: Workflow, by: str, expected: int, enable: bool): bool =
  activationReceipt(w, by, InvalidRequest, expected, enable) == 0
pure def lawForeignCallerNeverMutates(w: Workflow, by: str, form: RequestForm, expected: int, enable: bool): bool =
  w.owner != by implies activationReceipt(w, by, form, expected, enable) == 0
pure def lawSelectedVersionRefusesNewerDefinition(w: Workflow, by: str, expected: int, enable: bool): bool =
  expected != w.version implies activationReceipt(w, by, ExactRequest, expected, enable) == 0
pure def lawLegacyOmissionActivatesLatest(w: Workflow, by: str, expected: int, enable: bool): bool =
  (w.owner != "" and w.owner == by and not(enable and w.typed)) implies activationReceipt(w, by, LegacyRequest, expected, enable) == w.version + 1
pure def lawReceiptNamesCommittedVersion(w: Workflow, by: str, form: RequestForm, expected: int, enable: bool): bool =
  activationReceipt(w, by, form, expected, enable) != 0 implies activationReceipt(w, by, form, expected, enable) == w.version + 1
```

### Turning a workflow off never needs a reviewed schedule

The off switch wins: the owner can deactivate the current version of a
definition whatever its trigger, and an inactive definition queues no
scheduled occurrence ([schedule](./schedule.md)).

```quint
pure def lawOwnerCanAlwaysDeactivate(w: Workflow, by: str): bool =
  (w.owner != "" and w.owner == by) implies canChangeActivation(w, by, ExactRequest, w.version, false) or w.version <= 0
pure def lawDeactivationClearsActive(w: Workflow, by: str, form: RequestForm, expected: int): bool =
  canChangeActivation(w, by, form, expected, false) implies not(changeActivation(w, by, form, expected, false).active)
```
