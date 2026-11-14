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
pure def setupCount(native: bool): int = if (native) 7 else 4
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

### Progress and storage acknowledgement have independent lifetimes

Walking forward writes pending cursors and the completion marker. A
successful save means the progress bytes read back exactly. If saving
fails, the session still advances and exposes the storage error. Finish
may retry the completion write. A completed setup remains complete
when reopened for review or when external OS permission status changes.
Restore validates the shape, version, cursor and choice cardinality before
considering progress; a malformed/unreadable record is a visible error.
`observedReady` means the current bridge flow returned ready after a tap.
It is not a promise that permissions remain available.

```quint
type Walk = { native: bool, phase: SetupPhase, enabled: bool, reviewing: bool, reopened: bool, target: int, cursor: int, choices: List[SetupChoice], durableCursor: int, durableChoices: List[SetupChoice], durableVersion: int, durableComplete: bool, saveFailed: bool, epoch: int, pending: bool, elapsed: int }
pure val initial: Walk = { native: false, phase: Hidden, enabled: false, reviewing: false, reopened: false, target: -1, cursor: 0, choices: List(), durableCursor: 0, durableChoices: List(), durableVersion: 1, durableComplete: false, saveFailed: false, epoch: 0, pending: false, elapsed: 0 }
pure def currentVersion(native: bool): int = if (native) 4 else 1
pure def canMount(s: Walk, native: bool): bool = s.phase == Hidden and s.epoch == 0 and not(s.durableComplete)
pure def mount(s: Walk, native: bool): Walk = { ...s, native: native, durableVersion: currentVersion(native), epoch: 1 }
pure def canRestoreCompleted(s: Walk, version: int): bool = s.phase == Hidden and s.epoch == 1 and versionSteps(s.native, version) > 0
pure def restoreCompleted(s: Walk, version: int): Walk =
  { ...s, cursor: setupCount(s.native), durableCursor: versionSteps(s.native, version), durableVersion: version, durableComplete: true, epoch: s.epoch + 1 }
pure def changeContext(s: Walk, facts: SetupFacts): Walk =
  { ...s, enabled: setupEnabled(facts), pending: false, epoch: s.epoch + 1 }
pure def canOpenSetup(s: Walk, accountCreated: bool): bool = s.epoch > 0 and s.enabled and s.phase == Hidden and not(s.pending) and (s.durableComplete or s.cursor < setupCount(s.native))
pure def openSetup(s: Walk, accountCreated: bool): Walk = {
  val resumed = not(s.durableComplete)
  { ...s, phase: if (resumed) Access else if (showCompletion(accountCreated, false)) Ready else Home, elapsed: 0 }
}
pure def canReopen(s: Walk, target: int): bool = s.epoch > 0 and s.enabled and target >= -1 and target < setupCount(s.native) and (target >= 0 or s.durableComplete or s.cursor < setupCount(s.native))
pure def reopen(s: Walk, target: int): Walk = {
  val review = s.durableComplete
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
  val saved = s.target < 0 and not(s.reviewing or s.durableComplete) and writeAck
  { ...s, cursor: cursor, choices: choices, phase: if (s.target >= 0) Home else if (complete) Ready else Access,
    pending: false, elapsed: 0, durableCursor: if (saved) cursor else s.durableCursor,
    durableChoices: if (saved) choices else s.durableChoices, durableVersion: if (saved) currentVersion(s.native) else s.durableVersion,
    durableComplete: if (saved) complete else s.durableComplete,
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
    durableCursor: if (retry) s.cursor else s.durableCursor,
    durableChoices: if (retry) s.choices else s.durableChoices, durableVersion: if (retry) currentVersion(s.native) else s.durableVersion,
    durableComplete: s.durableComplete or retry }
}
pure val millisecondsValues = Set(0, 1, 19999, 20000, 20001)
pure val targetValues = Set(-1, 0, 1, 2, 3, 4, 5, 6)
pure val ticketValues = Set(0, 1, 2, 3, 4, 5, 6)
pure def alwaysProgressIsBounded(s: Walk): bool = s.cursor >= 0 and s.cursor <= setupCount(s.native) and (s.phase == Access and s.target == -1 implies s.cursor < setupCount(s.native)) and s.target >= -1 and s.target < setupCount(s.native)
pure def alwaysDurableProgressIsValid(s: Walk): bool = validStoredStep(s.native, s.durableVersion, s.durableCursor, s.durableComplete)
pure def alwaysReviewRetainsCompletion(s: Walk): bool = s.reviewing implies s.durableComplete
pure def alwaysBusyIsAnAccessTap(s: Walk): bool = s.pending implies s.phase == Access and (s.enabled or s.reopened)
pure def alwaysElapsedIsBounded(s: Walk): bool = s.elapsed >= 0 and s.elapsed <= 20000
pure def alwaysEpochIsNonnegative(s: Walk): bool = s.epoch >= 0
pure def stepDurableCompletionNeverRegresses(before: Walk, after: Walk): bool = before.durableComplete implies after.durableComplete
pure def sometimesResumesOldCompletion(s: Walk): bool = s.phase == Home and s.durableComplete and s.native and s.durableVersion < 4
pure def sometimesRecordedSkip(s: Walk): bool = s.choices.some(choice => choice == Skipped)
pure def sometimesProgressUnsaved(s: Walk): bool = s.saveFailed and s.cursor > s.durableCursor
pure def sometimesReopenedReview(s: Walk): bool = s.reviewing and s.phase == Access and s.target >= 0
```

### Platform shape is chosen before setup has progress

Discovered by the proof: a fabricated pre-mount record could carry native
cursor values into a four-step browser setup. The initial mount owns no
pending progress and selects its version before reading storage. Later
owner changes and reopens do not switch the platform shape.

```quint
pure def alwaysUninitializedHasNoProgress(s: Walk): bool =
  s.epoch == 0 implies s.cursor == 0 and s.target == -1 and s.durableCursor == 0 and not(s.durableComplete)
```
