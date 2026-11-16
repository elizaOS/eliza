# Triggers

A trigger is a saved task that the agent runs on a schedule or on request. The
[core scheduling](../core/scheduling.md) spec owns when an occurrence is due;
this spec owns one owned trigger: its saved revision, a run in progress, and
the recovery calls that archive or restore it.

## Story: Run a trigger now or on schedule, and recover it without losing my edits

> As a user, I can run a trigger now, and pressing the button twice with the
> same request runs it once. Scheduled runs happen without a conversation and
> while the device is offline. When I archive or restore a trigger, a run in
> progress or an edit I saved meanwhile is never overwritten.

### A run starts only on a free, enabled, unarchived trigger, and a run-now key runs once

A run starts when no other run or recovery holds the trigger, the trigger is
enabled and not archived. A run-now request carries a key, and a key that
already started a run never starts another. The run remembers the revision it
started from.

```quint
type TriggerLock = LockFree | LockRunning | LockMutating
type RecoveryPhase = RecoveryIdle | RecoverySelected | RecoveryChecking | RecoveryWriting | RecoveryReplying
type RecoveryIntent = ArchiveIntent | RestoreIntent
type Trigger = { archived: bool, enabled: bool, lock: TriggerLock, phase: RecoveryPhase, revision: int, expected: int, runRevision: int, history: int, intent: RecoveryIntent, owner: bool, runKeys: Set[str], online: bool, offlineRuns: int }
pure val initial: Trigger = { archived: false, enabled: true, lock: LockFree, phase: RecoveryIdle, revision: 0, expected: 0, runRevision: 0, history: 0, intent: ArchiveIntent, owner: true, runKeys: Set(), online: true, offlineRuns: 0 }
pure def runnable(t: Trigger): bool = t.lock == LockFree and not(t.archived) and t.enabled
pure def canRunNow(t: Trigger, key: str): bool = runnable(t) and key != "" and not(t.runKeys.contains(key))
pure def runNow(t: Trigger, key: str): Trigger = { ...t, lock: LockRunning, runRevision: t.revision, runKeys: t.runKeys.union(Set(key)) }
pure val keyValues = Set("k1", "k2", "")
pure def alwaysRunningTriggerIsNotArchived(t: Trigger): bool = t.lock == LockRunning implies not(t.archived)
pure def stepRunNowKeyIsUsedOnce(before: Trigger, via: str, after: Trigger): bool =
  via == "runNow" implies after.runKeys.size() == before.runKeys.size() + 1
```

### A scheduled occurrence runs without a conversation and while offline

The scheduler starts a due occurrence under the same conditions as a run now,
whether or not the device is online and without any conversation open.

```quint
pure def canGoOffline(t: Trigger): bool = t.online
pure def goOffline(t: Trigger): Trigger = { ...t, online: false }
pure def canGoOnline(t: Trigger): bool = not(t.online)
pure def goOnline(t: Trigger): Trigger = { ...t, online: true }
pure def canRunScheduled(t: Trigger): bool = runnable(t)
pure def runScheduled(t: Trigger): Trigger = { ...t, lock: LockRunning, runRevision: t.revision, offlineRuns: if (t.online) t.offlineRuns else t.offlineRuns + 1 }
pure def sometimesRanWhileOffline(t: Trigger): bool = t.offlineRuns > 0 and t.history > 0
```

### A saved revision wins over a run's stale write

When a run finishes it is counted in the history. Its write to the trigger is
kept only if the trigger is still at the revision the run started from;
otherwise the edit I saved meanwhile stays as it is.

```quint
pure def canSaveEdit(t: Trigger): bool = t.lock != LockMutating
pure def saveEdit(t: Trigger): Trigger = { ...t, revision: t.revision + 1 }
pure def canFinishRun(t: Trigger): bool = t.lock == LockRunning
pure def finishRun(t: Trigger): Trigger =
  { ...t, lock: LockFree, history: t.history + 1, revision: if (t.revision == t.runRevision) t.revision + 1 else t.revision }
pure def stepStaleRunWriteKeepsTheSavedRevision(before: Trigger, via: str, after: Trigger): bool =
  (via == "finishRun" and before.revision != before.runRevision) implies after.revision == before.revision
pure def sometimesSavedEditSurvivedARun(t: Trigger): bool = t.history > 0 and t.lock == LockFree and t.revision > t.runRevision + 1
```

### Only an unarchived trigger can be enabled again

Archiving and restoring leave a trigger disabled. Enabling it is a saved edit
of its own, allowed only when the trigger is not archived and no recovery
holds it.

```quint
pure def canEnable(t: Trigger): bool = not(t.archived) and not(t.enabled) and t.lock != LockMutating
pure def enable(t: Trigger): Trigger = { ...t, enabled: true, revision: t.revision + 1 }
pure def stepOnlyAnUnarchivedTriggerIsEnabled(before: Trigger, via: str, after: Trigger): bool = via == "enable" implies not(before.archived)
pure def sometimesRestoredTriggerRunsAgain(t: Trigger): bool = t.lock == LockRunning and t.revision > 1 and t.history == 0
```

### Archive and restore commit only for the owner, on the revision they selected

A recovery call selects an intent at the current revision. It proceeds only
for the trigger's owner when nothing holds the trigger; otherwise it is
refused. It then checks that the revision has not moved, and only then writes:
archive or restore, either way leaving the trigger disabled. A refused or
stale call releases the trigger without writing.

```quint
pure def canChoose(t: Trigger, intent: RecoveryIntent, owner: bool): bool = t.phase == RecoveryIdle
pure def choose(t: Trigger, intent: RecoveryIntent, owner: bool): Trigger = { ...t, intent: intent, owner: owner, expected: t.revision, phase: RecoverySelected }
pure def canClaimRecovery(t: Trigger): bool = t.phase == RecoverySelected and t.lock == LockFree and t.owner
pure def claimRecovery(t: Trigger): Trigger = { ...t, lock: LockMutating, phase: RecoveryChecking }
pure def canRefuseRecovery(t: Trigger): bool = t.phase == RecoverySelected and (not(t.owner) or t.lock != LockFree)
pure def refuseRecovery(t: Trigger): Trigger = { ...t, phase: RecoveryIdle }
pure def canCheckRevision(t: Trigger): bool = t.phase == RecoveryChecking
pure def checkRevision(t: Trigger): Trigger =
  if (t.expected == t.revision) { ...t, phase: RecoveryWriting } else { ...t, phase: RecoveryIdle, lock: LockFree }
pure def canCommitRecovery(t: Trigger): bool = t.phase == RecoveryWriting
pure def commitRecovery(t: Trigger): Trigger = { ...t, archived: t.intent == ArchiveIntent, enabled: false, revision: t.revision + 1, phase: RecoveryReplying }
pure def canRejectWrite(t: Trigger): bool = t.phase == RecoveryWriting
pure def rejectWrite(t: Trigger): Trigger = { ...t, lock: LockFree, phase: RecoveryIdle }
pure def canSettleReply(t: Trigger): bool = t.phase == RecoveryReplying
pure def settleReply(t: Trigger): Trigger = { ...t, lock: LockFree, phase: RecoveryIdle }
pure def alwaysArchivedTriggerIsDisabled(t: Trigger): bool = t.archived implies not(t.enabled)
pure def alwaysWriteHasOwnerAndCurrentRevision(t: Trigger): bool =
  t.phase == RecoveryWriting implies (t.owner and t.expected == t.revision and t.lock == LockMutating)
pure val fair_settleReply = "weak"
pure def leadsToReplySettles(t: Trigger, later: Trigger): bool = t.phase == RecoveryReplying implies later.phase == RecoveryIdle
pure def sometimesArchived(t: Trigger): bool = t.archived and t.phase == RecoveryIdle
pure def sometimesRestoredStaysInactive(t: Trigger): bool = not(t.archived) and not(t.enabled) and t.revision > 1
```
