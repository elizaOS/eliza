# Alpha startup access walkthrough

The Alpha owner is `apps/app/src/startup-permissions.tsx`. It binds the
[shared permission step](./permissionStep.md) and Eliza's shared progress
reader. Browser setup visits notifications, microphone, camera, and location.
Native adds calendar, photos, and files in that order. `walkthroughProgress`
reads each known version against its old step count, adopts an unfinished
record into the current version, and retains completed old records. The
native versions have four, five, six, and seven steps. Browser version one
has four. Reviewed choices and durable prompt memory record UI intent and
never authorize later feature use.

## Story: Resume setup and review access without granting it implicitly

### Setup waits for the right owner and uses live bridge observations

A Cloud account or completed configured Cerebras setup admits initial
setup. Sign-in or foreground connection work holds it back. Resident
startup or background reconnection does not block it. A Settings review
may reopen completed setup, keeps the completed record, and may target one
permission. With a pending review tap, owner/environment/setup revision
change invalidates its lease, even if the platform call finishes later.
A Ready result advances an ordinary step only for the current interaction.
An unavailable or denied result stays on the step. The skip affordance
appears after 20 seconds on that visible step. Skipping may retire a busy
platform request and advances the UI without setting a permission grant.

```quint
type SetupFacts = { account: bool, setup: bool, providerSelected: bool, cerebras: bool, busy: bool, starting: bool, background: bool, signingIn: bool }
type SetupChoice = Allowed | Continued | Skipped
type SetupPhase = Hidden | Access | Ready | Home
pure val factsValues = Set(
  { account: true, setup: true, providerSelected: false, cerebras: false, busy: false, starting: false, background: false, signingIn: false },
  { account: false, setup: true, providerSelected: true, cerebras: true, busy: true, starting: true, background: false, signingIn: false },
  { account: true, setup: true, providerSelected: false, cerebras: false, busy: true, starting: false, background: false, signingIn: true },
  { account: false, setup: false, providerSelected: false, cerebras: false, busy: false, starting: false, background: false, signingIn: false }
)
pure def setupEnabled(facts: SetupFacts): bool =
  (facts.account or (facts.setup and facts.providerSelected and facts.cerebras)) and
  not(facts.busy and not(facts.starting or facts.background)) and not(facts.signingIn)
pure def lawForegroundSigninBlocksSetup(facts: SetupFacts): bool = facts.signingIn implies not(setupEnabled(facts))
type SetupPermission = Notifications | Microphone | Camera | Location | Calendar | Photos | Files
pure val browserPermissions = List(Notifications, Microphone, Camera, Location)
pure def setupPermissions(native: bool): List[SetupPermission] =
  if (native) browserPermissions.concat(List(Calendar, Photos, Files)) else browserPermissions
pure def setupCount(native: bool): int = setupPermissions(native).length()
pure def versionSteps(native: bool, version: int): int =
  if (native and version >= 1 and version <= 4) version + 3 else if (not(native) and version == 1) 4 else 0
pure def validStoredStep(native: bool, version: int, cursor: int, complete: bool): bool = {
  val count = versionSteps(native, version)
  count > 0 and (if (complete) cursor == count else cursor >= 0 and cursor < count)
}
pure def showCompletion(accountCreated: bool, resumed: bool): bool = accountCreated and not(resumed)
pure def lawOldCompletedSetupIsRecognized(version: int): bool = version >= 1 and version <= 3 implies validStoredStep(true, version, version + 3, true)
pure def lawReturningSigninCannotShowCompletion(resumed: bool): bool = not(showCompletion(false, resumed))
```

### Stored progress is validated before Alpha restores its UI

The shared reader checks a stored version against that version's step
count. Pending progress retains its cursor and supplied choices while the
returned record adopts the current version. Completed progress keeps its
stored version. Choices may be omitted; when supplied, they must contain
exactly one admitted choice per completed step. JSON parsing, exact durable
keys, integer checks, choice vocabulary and storage exceptions are host
codec observations. The model retains an actual durable snapshot only
after these observations and the progress checks succeed.

Alpha's `savedProgress` then projects the reader result. A pending record
with omitted choices fills the preceding steps with `continued`. A missing
durable key can use the older session record. That separate format accepts
versions one through three, checks the cursor against the current step
count, and requires supplied choices. A second durable-key presence read selects the session fallback. A present
key suppresses that fallback, and an absent session keeps the already read
progress. If another context removes the durable key between reads, a valid
legacy session can replace the captured pending progress. A failed presence
or session read, an invalid legacy record, or an invalid initial durable
read starts a fresh walkthrough with no initial storage warning. Completed
progress and invalid initial reads return before consulting the second
presence read or session store.
This corrects the earlier visible-restore-error claim to the pinned Alpha
host at `startup-permissions.tsx:38-50`. Visible `Not saved` belongs to a
later write or readback failure, not to this initial fallback. Neither
restoration nor a recorded choice authorizes an OS permission.

These typed observations cover known integer version IDs. The pinned
reader uses ordinary object lookup for its version table: coercible keys
such as the string `"1"` and inherited names such as `"__proto__"` can
pass its raw check. An inherited pending version can even admit a cursor
beyond the installed list. That source decoder defect is outside the
known-version model domain. Rejecting such raw versions at the replacement
codec is an explicit compatibility correction pending owner review, not
parity already established by the model. The consumer contract map retains
the exact pinned defect and its controlled replay evidence.

```quint
type ProgressStatus = SavedPending | SavedCompleted
type ChoiceHistory = ChoicesOmitted | ChoicesRecorded({ choices: List[SetupChoice] })
type StoredProgress = { version: int, status: ProgressStatus, cursor: int, history: ChoiceHistory }
type ProgressObservation = ProgressAbsent | ProgressUnreadable | ProgressMalformed | ProgressObserved({ record: StoredProgress })
type ProgressRead = FreshProgress | InvalidProgress | PendingProgress({ record: StoredProgress }) | CompletedProgress({ record: StoredProgress })
type ProgressSnapshot = NoKnownProgress | ValidatedProgress({ record: StoredProgress })
type LegacyProgress = { version: int, cursor: int, choices: List[SetupChoice] }
type LegacyObservation = LegacySuppressed | LegacyAbsent | LegacyReadFailed | LegacyInvalid | LegacyObserved({ record: LegacyProgress })
type StartupProgress = FreshStartup | PendingStartup({ cursor: int, choices: List[SetupChoice] }) | CompletedStartup
pure val skippedChoice: SetupChoice = Skipped
pure val allowedChoice: SetupChoice = Allowed
pure val continuedChoice: SetupChoice = Continued
pure val noKnownProgress: ProgressSnapshot = NoKnownProgress
pure val freshStartup: StartupProgress = FreshStartup
pure val noLegacy: LegacyObservation = LegacyAbsent
pure val suppressedLegacy: LegacyObservation = LegacySuppressed
pure def currentVersion(native: bool): int = if (native) 4 else 1
pure def pendingRead(record: StoredProgress): ProgressRead = PendingProgress({ record: record })
pure def completedRead(record: StoredProgress): ProgressRead = CompletedProgress({ record: record })
pure def validatedSnapshot(record: StoredProgress): ProgressSnapshot = ValidatedProgress({ record: record })
pure def validHistory(cursor: int, history: ChoiceHistory): bool = match history {
  | ChoicesOmitted => true
  | ChoicesRecorded(value) => value.choices.length() == cursor
}
pure def validProgress(native: bool, record: StoredProgress): bool =
  validStoredStep(native, record.version, record.cursor, record.status == SavedCompleted) and validHistory(record.cursor, record.history)
pure def readProgress(native: bool, observed: ProgressObservation): ProgressRead = match observed {
  | ProgressAbsent => FreshProgress
  | ProgressObserved(value) =>
    if (not(validProgress(native, value.record))) InvalidProgress
    else if (value.record.status == SavedCompleted) CompletedProgress({ record: value.record })
    else PendingProgress({ record: { ...value.record, version: currentVersion(native) } })
  | _ => InvalidProgress
}
pure def progressSnapshot(native: bool, observed: ProgressObservation): ProgressSnapshot = match observed {
  | ProgressObserved(value) => if (validProgress(native, value.record)) ValidatedProgress({ record: value.record }) else NoKnownProgress
  | _ => NoKnownProgress
}
pure def continuedChoices(native: bool, cursor: int): List[SetupChoice] =
  setupPermissions(native).foldl(List(), (choices, permission) => if (choices.length() < cursor) choices.append(continuedChoice) else choices)
pure def startupChoices(native: bool, cursor: int, history: ChoiceHistory): List[SetupChoice] = match history {
  | ChoicesOmitted => continuedChoices(native, cursor)
  | ChoicesRecorded(value) => value.choices
}
pure def validLegacyProgress(native: bool, legacyRecord: LegacyProgress): bool =
  legacyRecord.version >= 1 and legacyRecord.version <= 3 and legacyRecord.cursor >= 0 and legacyRecord.cursor < setupCount(native) and legacyRecord.choices.length() == legacyRecord.cursor
pure def legacyStartup(native: bool, legacy: LegacyObservation, captured: StartupProgress): StartupProgress = match legacy {
  | LegacySuppressed => captured
  | LegacyAbsent => captured
  | LegacyObserved(value) => if (validLegacyProgress(native, value.record)) PendingStartup({ cursor: value.record.cursor, choices: value.record.choices }) else FreshStartup
  | _ => FreshStartup
}
pure def startupProgress(native: bool, observed: ProgressObservation, legacy: LegacyObservation): StartupProgress = {
  val progress = readProgress(native, observed)
  match progress {
    | FreshProgress => legacyStartup(native, legacy, freshStartup)
    | PendingProgress(value) => legacyStartup(native, legacy, PendingStartup({ cursor: value.record.cursor, choices: startupChoices(native, value.record.cursor, value.record.history) }))
    | CompletedProgress(_) => CompletedStartup
    | InvalidProgress => FreshStartup
  }
}
pure def storedCursor(snapshot: ProgressSnapshot): int = match snapshot { | NoKnownProgress => 0 | ValidatedProgress(value) => value.record.cursor }
pure def storedVersion(snapshot: ProgressSnapshot): int = match snapshot { | NoKnownProgress => 0 | ValidatedProgress(value) => value.record.version }
pure def storedCompleted(snapshot: ProgressSnapshot): bool = match snapshot { | NoKnownProgress => false | ValidatedProgress(value) => value.record.status == SavedCompleted }
pure def snapshotValid(native: bool, snapshot: ProgressSnapshot): bool = match snapshot { | NoKnownProgress => true | ValidatedProgress(value) => validProgress(native, value.record) }
pure def startupCursor(native: bool, progress: StartupProgress): int = match progress { | PendingStartup(value) => value.cursor | CompletedStartup => setupCount(native) | FreshStartup => 0 }
pure def startupHistory(progress: StartupProgress): List[SetupChoice] = match progress { | PendingStartup(value) => value.choices | _ => List() }
pure def historyForWrite(choices: List[SetupChoice]): ChoiceHistory = if (choices.includes(skippedChoice)) ChoicesRecorded({ choices: choices }) else ChoicesOmitted
pure def writtenProgress(native: bool, cursor: int, complete: bool, choices: List[SetupChoice]): ProgressSnapshot =
  ValidatedProgress({ record: { version: currentVersion(native), status: if (complete) SavedCompleted else SavedPending, cursor: cursor, history: historyForWrite(choices) } })
pure val pendingRecord: StoredProgress = { version: 1, status: SavedPending, cursor: 2, history: ChoicesRecorded({ choices: List(Allowed, Skipped) }) }
pure val recordValues = Set(pendingRecord, { ...pendingRecord, history: ChoicesOmitted },
  { ...pendingRecord, status: SavedCompleted, cursor: 4, history: ChoicesOmitted },
  { ...pendingRecord, version: 5 }, { ...pendingRecord, history: ChoicesRecorded({ choices: List() }) })
pure val observedValues = Set(ProgressAbsent, ProgressUnreadable, ProgressMalformed, ProgressObserved({ record: pendingRecord }),
  ProgressObserved({ record: { ...pendingRecord, history: ChoicesOmitted } }),
  ProgressObserved({ record: { ...pendingRecord, history: ChoicesRecorded({ choices: List() }) } }),
  ProgressObserved({ record: { ...pendingRecord, status: SavedCompleted, cursor: 4, history: ChoicesOmitted } }))
pure val legacyValues = Set(LegacySuppressed, LegacyAbsent, LegacyReadFailed, LegacyInvalid, LegacyObserved({ record: { version: 3, cursor: 2, choices: List(Allowed, Skipped) } }))
pure val capturedValues = Set(FreshStartup, CompletedStartup, PendingStartup({ cursor: 1, choices: List(Continued) }))
pure val legacyRecordValues = Set({ version: 3, cursor: 2, choices: List(Allowed, Skipped) },
  { version: 4, cursor: 2, choices: List(Allowed, Skipped) }, { version: 1, cursor: 0, choices: List() })
pure def lawSuppressedSessionKeepsCapturedProgress(native: bool, observed: ProgressObservation): bool =
  startupProgress(native, observed, suppressedLegacy) == startupProgress(native, observed, noLegacy)
pure def lawInvalidDurableStartsFresh(native: bool, legacy: LegacyObservation): bool =
  startupProgress(native, ProgressMalformed, legacy) == freshStartup and startupProgress(native, ProgressUnreadable, legacy) == freshStartup
pure def lawPendingReaderAdoptsCurrentVersion(native: bool, record: StoredProgress): bool =
  validProgress(native, record) and record.status == SavedPending implies
    readProgress(native, ProgressObserved({ record: record })) == pendingRead({ ...record, version: currentVersion(native) })
pure def lawCompletedReaderRetainsStoredVersion(native: bool, record: StoredProgress): bool =
  validProgress(native, record) and record.status == SavedCompleted implies
    readProgress(native, ProgressObserved({ record: record })) == completedRead(record)
pure def lawSnapshotKeepsOriginalRecord(native: bool, record: StoredProgress): bool =
  validProgress(native, record) implies progressSnapshot(native, ProgressObserved({ record: record })) == validatedSnapshot(record)
pure def lawRecordedHistoryRequiresCursorLength(cursor: int, choices: List[SetupChoice]): bool =
  validHistory(cursor, ChoicesRecorded({ choices: choices })) iff choices.length() == cursor
pure def lawLegacyUsesCurrentCount(native: bool, legacyRecord: LegacyProgress): bool =
  validLegacyProgress(native, legacyRecord) implies legacyRecord.version >= 1 and legacyRecord.version <= 3 and legacyRecord.cursor < setupCount(native)
pure def lawStartupPendingHasCurrentBounds(native: bool, observed: ProgressObservation, legacy: LegacyObservation): bool = {
  val progress = startupProgress(native, observed, legacy)
  match progress {
    | PendingStartup(value) => value.cursor >= 0 and value.cursor < setupCount(native) and value.choices.length() == value.cursor
    | _ => true
  }
}
```

### Progress and storage acknowledgement have independent lifetimes

Walking forward writes pending cursors and the completion marker. A
successful save means the progress bytes read back exactly. If saving
fails, the session still advances and exposes the storage error. Finish
may retry the completion write. A completed setup remains complete
when reopened for review or when external OS permission status changes.
Initial restoration uses the preceding reader and Alpha fallback policy.
It keeps a validated durable snapshot separate from the adopted UI cursor
and choices. No known snapshot means no claim about stored progress.
Discovered by the proof: an active Access checklist and a session awaiting a failed-write retry
retain exactly one choice per completed step. Only a completed idle
projection without a storage warning may omit that UI history. This
cardinality fact prevents a fabricated retry from copying incomplete
history into a completed durable record.
`observedReady` means the current bridge flow returned ready after a tap.
It is not a promise that permissions remain available.

```quint
type Walk = { native: bool, phase: SetupPhase, enabled: bool, reviewing: bool, reopened: bool, target: int, cursor: int, choices: List[SetupChoice], durable: ProgressSnapshot, restored: bool, saveFailed: bool, epoch: int, pending: bool, elapsed: int }
pure val initial: Walk = { native: false, phase: Hidden, enabled: false, reviewing: false, reopened: false, target: -1, cursor: 0, choices: List(), durable: NoKnownProgress, restored: false, saveFailed: false, epoch: 0, pending: false, elapsed: 0 }
pure def canMount(s: Walk, native: bool): bool = s.phase == Hidden and s.epoch == 0 and not(s.restored)
pure def mount(s: Walk, native: bool): Walk = { ...s, native: native, epoch: 1 }
pure def canRestoreProgress(s: Walk): bool = s.phase == Hidden and s.epoch > 0 and not(s.restored)
pure def restoreProgress(s: Walk, observed: ProgressObservation, legacy: LegacyObservation): Walk = {
  val progress = startupProgress(s.native, observed, legacy)
  { ...s, cursor: startupCursor(s.native, progress), choices: startupHistory(progress), durable: progressSnapshot(s.native, observed), restored: true, saveFailed: false, epoch: s.epoch + 1 }
}
pure def canChangeContext(s: Walk): bool = s.epoch > 0
pure def changeContext(s: Walk, facts: SetupFacts): Walk =
  { ...s, enabled: setupEnabled(facts), pending: false, epoch: s.epoch + 1 }
pure def canOpenSetup(s: Walk, accountCreated: bool): bool = s.restored and s.enabled and s.phase == Hidden and not(s.pending) and (storedCompleted(s.durable) or s.cursor < setupCount(s.native))
pure def openSetup(s: Walk, accountCreated: bool): Walk = {
  val resumed = not(storedCompleted(s.durable))
  { ...s, phase: if (resumed) Access else if (showCompletion(accountCreated, false)) Ready else Home, elapsed: 0 }
}
pure def canReopen(s: Walk, target: int): bool = s.restored and s.enabled and target >= -1 and target < setupCount(s.native) and (target >= 0 or storedCompleted(s.durable) or s.cursor < setupCount(s.native))
pure def reopen(s: Walk, target: int): Walk = {
  val review = storedCompleted(s.durable)
  { ...s, phase: Access, reopened: true, reviewing: review, target: target,
    cursor: if (review) 0 else s.cursor, choices: if (review) List() else s.choices,
    pending: false, epoch: s.epoch + 1, elapsed: 0 }
}
pure def canBeginTap(s: Walk): bool = s.epoch > 0 and s.phase == Access and (s.enabled or s.reopened) and not(s.pending)
pure def beginTap(s: Walk): Walk = { ...s, epoch: s.epoch + 1, pending: true }
pure def canElapse(s: Walk, milliseconds: int): bool = s.phase == Access and milliseconds >= 0
pure def elapse(s: Walk, milliseconds: int): Walk = { ...s, elapsed: if (milliseconds > 20000 - s.elapsed) 20000 else s.elapsed + milliseconds }
pure def advanceChoice(choice: SetupChoice, writeAck: bool, s: Walk): Walk = {
  val cursor = if (s.target < 0) s.cursor + 1 else s.cursor
  val choices = if (s.target < 0) s.choices.append(choice) else s.choices
  val complete = s.target < 0 and cursor == setupCount(s.native)
  val saved = s.target < 0 and not(s.reviewing or storedCompleted(s.durable)) and writeAck
  { ...s, cursor: cursor, choices: choices, phase: if (s.target >= 0) Home else if (complete) Ready else Access,
    pending: false, elapsed: 0, durable: if (saved) writtenProgress(s.native, cursor, complete, choices) else s.durable,
    saveFailed: if (s.target < 0 and not(s.reviewing)) not(writeAck) else s.saveFailed }
}
pure def canSettleTap(s: Walk, ticket: int): bool = s.epoch > 0 and s.pending and ticket == s.epoch
pure def settleTap(s: Walk, ticket: int, observedReady: bool, wasReady: bool, writeAck: bool): Walk =
  if (observedReady and s.target < 0) advanceChoice(if (wasReady) Continued else Allowed, writeAck, s) else { ...s, pending: false }
pure def canSkipChoice(s: Walk): bool = s.epoch > 0 and s.phase == Access and (s.enabled or s.reopened) and s.elapsed == 20000
pure def skipChoice(s: Walk, writeAck: bool): Walk = advanceChoice(Skipped, writeAck, { ...s, epoch: s.epoch + 1 })
pure def canCloseTarget(s: Walk): bool = s.phase == Access and s.target >= 0 and not(s.pending)
pure def closeTarget(s: Walk): Walk = { ...s, phase: Home, reopened: false, target: -1 }
pure def canCloseReview(s: Walk): bool = s.phase == Access and s.reviewing
pure def closeReview(s: Walk): Walk = { ...s, phase: Home, reopened: false, target: -1, pending: false, epoch: s.epoch + 1 }
pure def canFinish(s: Walk): bool = s.epoch > 0 and s.phase == Ready and (s.enabled or s.reopened) and not(s.pending)
pure def finish(s: Walk, retryAck: bool): Walk = {
  val retry = s.saveFailed and not(s.reviewing) and s.cursor == setupCount(s.native) and retryAck
  { ...s, phase: Home, reopened: false, saveFailed: s.saveFailed and not(retry),
    durable: if (retry) writtenProgress(s.native, s.cursor, true, s.choices) else s.durable }
}
pure val millisecondsValues = Set(0, 1, 19999, 20000, 20001)
pure val targetValues = Set(-1, 0, 1, 2, 3, 4, 5, 6)
pure val ticketValues = Set(0, 1, 2, 3, 4, 5, 6)
pure def alwaysProgressIsBounded(s: Walk): bool = s.cursor >= 0 and s.cursor <= setupCount(s.native) and (s.phase == Access and s.target == -1 implies s.cursor < setupCount(s.native)) and s.target >= -1 and s.target < setupCount(s.native)
pure def alwaysDurableProgressIsValid(s: Walk): bool = snapshotValid(s.native, s.durable)
pure def alwaysReviewRetainsCompletion(s: Walk): bool = s.reviewing implies storedCompleted(s.durable)
pure def alwaysBusyIsAnAccessTap(s: Walk): bool = s.pending implies s.phase == Access and (s.enabled or s.reopened)
pure def alwaysElapsedIsBounded(s: Walk): bool = s.elapsed >= 0 and s.elapsed <= 20000
pure def alwaysEpochIsNonnegative(s: Walk): bool = s.epoch >= 0
pure def alwaysRestoredBeforeAccess(s: Walk): bool = s.phase != Hidden implies s.restored
pure def alwaysUnrestoredHasNoKnownProgress(s: Walk): bool = not(s.restored) implies s.durable == noKnownProgress and s.cursor == 0 and s.choices == List()
pure def alwaysRestoredChoicesMatchCursor(s: Walk): bool =
  not(s.restored) or (storedCompleted(s.durable) and s.phase != Access and not(s.saveFailed)) or s.choices.length() == s.cursor
pure def stepDurableCompletionNeverRegresses(before: Walk, after: Walk): bool = storedCompleted(before.durable) implies storedCompleted(after.durable)
pure def stepRestoreDoesNotReportWriteFailure(before: Walk, via: str, after: Walk): bool = via == "restoreProgress" implies after.restored and not(after.saveFailed)
pure def sometimesResumesOldCompletion(s: Walk): bool = s.phase == Home and storedCompleted(s.durable) and s.native and storedVersion(s.durable) < currentVersion(s.native)
pure def sometimesRecordedSkip(s: Walk): bool = s.choices.some(choice => choice == Skipped)
pure def sometimesProgressUnsaved(s: Walk): bool = s.saveFailed and s.cursor > storedCursor(s.durable)
pure def sometimesReopenedReview(s: Walk): bool = s.reviewing and s.phase == Access and s.target >= 0
pure def sometimesResumesPendingProgress(s: Walk): bool = s.restored and s.phase == Access and s.cursor == 2 and s.choices == List(allowedChoice, skippedChoice) and storedVersion(s.durable) == 1
```

### Platform shape is chosen before setup has progress

Discovered by the proof: a fabricated pre-mount record could carry native
cursor values into a four-step browser setup. The initial mount owns no
pending progress and selects its version before reading storage. Later
owner changes and reopens do not switch the platform shape.

```quint
pure def alwaysUninitializedHasNoProgress(s: Walk): bool =
  s.epoch == 0 implies s.cursor == 0 and s.target == -1 and s.durable == noKnownProgress and not(s.restored)
```
