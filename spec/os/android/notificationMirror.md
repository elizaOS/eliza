# Notification mirror

The opt-in mirror of other apps' notifications on an Android host: the
`android/notifications/` module's `NotificationMirror`,
`NotificationMirrorPolicy` and `NotificationMirrorListenerService`. The
consumer declares its listener subclass behind
`BIND_NOTIFICATION_LISTENER_SERVICE` and keeps its preferences name, Keystore
alias and history file name stable once installed. The mirror shows rows in
the owner's app; nothing here leaves the device or reaches the agent's
context. The app's own notices are the notification projection's
(`notificationProjection.md`). Device facts for owner requests come from
[the bridge](./bridge.md). Notification text,
intents and Android keys stay in the shell; the spec models who may collect,
which rows exist, and what history keeps.

## Story: Mirror only the notifications I allowed

> As the owner, I want my device to mirror only the apps I picked, and only
> while Android grants access and I have the mirror on, so that nothing from an
> app I did not pick is read.

### Android access, my switch and my pause are separate conditions for collecting

Opening Android's notification-access settings confers no grant; the shell
observes the grant on each call. A revoked grant, a pause and a resume each
cut the collection generation and drop every row; a revoked grant or a pause
also deletes history.

```quint
import bridge.* from "./bridge"
type ListenerSlot = Unbound | Bound({ instance: int })
type RowHandle = { key: str, handle: int, postedAt: int }
type Callback = { instance: int, generation: int, key: str, app: str, postedAt: int, removal: bool }
type HistoryRecord = { app: str, at: int }
type HistoryFile = NoFile | KeptFile({ rows: List[HistoryRecord] }) | UndeletedFile
type MirrorState = { revision: int, ownerEnabled: bool, historyConsent: bool, paused: bool, granted: bool, selected: Set[str], changedSigners: Set[str],
  listener: ListenerSlot, nextInstance: int, generation: int, queue: List[Callback], handles: List[RowHandle], nextHandle: int, historyFile: HistoryFile }
pure val initial: MirrorState = { revision: 0, ownerEnabled: false, historyConsent: false, paused: false, granted: false, selected: Set(), changedSigners: Set(),
  listener: Unbound, nextInstance: 1, generation: 0, queue: List(), handles: List(), nextHandle: 1, historyFile: NoFile }
pure def collecting(s: MirrorState): bool = s.granted and s.ownerEnabled and not(s.paused)
pure def keepsHistory(s: MirrorState): bool = collecting(s) and s.historyConsent
pure def afterDeletion(file: HistoryFile, deleted: bool): HistoryFile = if (deleted or file == NoFile) NoFile else UndeletedFile
pure def canObserveAccess(s: MirrorState, granted: bool): bool = granted != s.granted
pure def observeAccess(s: MirrorState, granted: bool, deleted: bool): MirrorState =
  if (granted) { ...s, granted: true }
  else { ...s, granted: false, generation: s.generation + 1, handles: List(), historyFile: afterDeletion(s.historyFile, deleted) }
pure def canPause(s: MirrorState): bool = not(s.paused)
pure def pause(s: MirrorState, deleted: bool): MirrorState =
  { ...s, paused: true, generation: s.generation + 1, handles: List(), historyFile: afterDeletion(s.historyFile, deleted) }
pure def canResume(s: MirrorState): bool = s.paused
pure def resume(s: MirrorState): MirrorState = { ...s, paused: false, generation: s.generation + 1, handles: List() }
```

### A selection holds at most twenty visible apps, and an app whose signer changed must be removed before it is chosen again

The picker offers enabled, exported launcher activities, one per package,
never the consumer itself. Each chosen app is pinned to its current signing
digest; a later signer change marks it changed until a saved selection drops
it. A selection is saved under the reviewed revision, after the purge, as a
settings change is.

```quint
pure val maxSelectedApps = 20
pure def canChooseApps(s: MirrorState, expectedRevision: int, requested: Set[str], visible: Set[str], facts: HostFacts): bool =
  meetsNeed(WithFocus, facts) and expectedRevision == s.revision and requested.size() <= maxSelectedApps and
  requested.subseteq(visible) and requested.intersect(s.changedSigners).size() == 0
pure def chooseApps(s: MirrorState, expectedRevision: int, requested: Set[str], visible: Set[str], facts: HostFacts, deleted: bool, committed: bool): MirrorState = {
  val purged = { ...s, generation: s.generation + 1, handles: List(), historyFile: afterDeletion(s.historyFile, deleted) }
  if (deleted and committed) { ...purged, selected: requested, changedSigners: Set(), revision: s.revision + 1 } else purged
}
pure def canObserveSignerChanged(s: MirrorState, app: str): bool = s.selected.contains(app) and not(s.changedSigners.contains(app))
pure def observeSignerChanged(s: MirrorState, app: str): MirrorState = { ...s, changedSigners: s.changedSigners.union(Set(app)) }
pure val requestedValues = Set(Set(), Set("a"), Set("a", "b"))
pure val visibleValues = Set(Set("a", "b"), Set("b"))
pure val appValues = Set("a", "b")
pure val expectedRevisionValues = Set(0, 1, 2)
pure def alwaysSelectionIsBounded(s: MirrorState): bool = s.selected.size() <= maxSelectedApps and s.changedSigners.subseteq(s.selected)
pure def sometimesChangedSignerAwaitsRemoval(s: MirrorState): bool = s.changedSigners.size() > 0
```

### A settings change is saved only for the reviewed revision and only after rows and history are purged

Every change cuts the generation, so callbacks queued under the old settings
cannot act, and deletes history first; a failed deletion or a failed commit
saves nothing. A saved change gets a fresh revision.

```quint
pure def canSaveSettings(s: MirrorState, expectedRevision: int, facts: HostFacts): bool = meetsNeed(WithFocus, facts) and expectedRevision == s.revision
pure def saveSettings(s: MirrorState, expectedRevision: int, ownerEnabled: bool, historyConsent: bool, facts: HostFacts, deleted: bool, committed: bool): MirrorState = {
  val purged = { ...s, generation: s.generation + 1, handles: List(), historyFile: afterDeletion(s.historyFile, deleted) }
  if (deleted and committed) { ...purged, ownerEnabled: ownerEnabled, historyConsent: historyConsent, revision: s.revision + 1 } else purged
}
pure def stepPolicyChangeFollowsAPurge(before: MirrorState, after: MirrorState): bool =
  after.revision != before.revision implies (after.revision == before.revision + 1 and after.historyFile == NoFile and after.handles.length() == 0 and after.generation > before.generation)
```

## Story: Show only current notices from apps I picked

> As the owner, I want to see only current notices from apps I picked, hidden
> when they are secret or I turned previews off, so that the mirror never
> shows more than the app itself would.

### A notice is admitted only from another app of my user, posted under its own UID, selected and with its current signer

The shell classifies the notice in that order; a removed or unreadable
package is `MismatchedUidNotice`. A listed row keeps its handle while its
posting time is unchanged; the Android key never leaves native code. A list
read on a locked or non-interactive device, or with collection off, drops
every row and returns none.

```quint
type NoticeSource = ForeignAppNotice | OwnAppNotice | OtherUserNotice | MismatchedUidNotice
pure val maxActiveRows = 100
pure def admits(s: MirrorState, source: NoticeSource, app: str): bool =
  source == ForeignAppNotice and s.selected.contains(app) and not(s.changedSigners.contains(app))
pure def isBound(s: MirrorState): bool = {
  val slot = s.listener
  match slot { | Bound(_) => true | Unbound => false }
}
pure def withHandle(handles: List[RowHandle], h: RowHandle): List[RowHandle] = {
  val others = handles.select(x => x.key != h.key).append(h)
  if (others.length() > maxActiveRows) others.removeAt(0) else others
}
pure def listNotice(s: MirrorState, key: str, app: str, postedAt: int, source: NoticeSource, unlocked: bool): MirrorState =
  if (not(collecting(s) and isBound(s) and unlocked)) { ...s, handles: List() }
  else if (not(admits(s, source, app))) s
  else if (s.handles.some(h => h.key == key and h.postedAt == postedAt)) s
  else { ...s, handles: withHandle(s.handles, { key: key, handle: s.nextHandle, postedAt: postedAt }), nextHandle: s.nextHandle + 1 }
pure val keyValues = Set("k1", "k2")
pure val postedAtValues = Set(1, 2)
```

### A row handle exists only while collecting with a connected listener, and a replaced notice gets a fresh one

At most the newest hundred rows hold handles.

```quint
pure def alwaysRowsNeedLiveCollection(s: MirrorState): bool = s.handles.length() > 0 implies (collecting(s) and isBound(s))
pure def alwaysRowHandlesAreIssued(s: MirrorState): bool = s.handles.length() <= maxActiveRows and s.handles.every(h => h.handle >= 1 and h.handle < s.nextHandle)
pure def stepNewRowsGetFreshHandles(before: MirrorState, after: MirrorState): bool =
  after.handles.every(h => before.handles.includes(h) or h.handle >= before.nextHandle)
pure def sometimesLiveRow(s: MirrorState): bool = s.handles.length() > 0
```

### A queued callback acts only for its own listener and the generation it was queued in

The listener runs post and removal callbacks one at a time from a queue of
64. Queuing captures the generation and drops the key's row. A refused
submission (full queue, or the executor shut down), a new listener, the
current listener's disconnect, screen off and a host pause each cut the
generation and drop every row; overflow and disconnect also drop the waiting
callbacks. An admitted post makes a row only on an unlocked, interactive
device; history may still record it. A history append that fails records
nothing and drops every row.

```quint
pure val noCallback: Callback = { instance: 0, generation: -1, key: "", app: "", postedAt: 0, removal: false }
pure def boundTo(s: MirrorState, instance: int): bool = {
  val slot = s.listener
  match slot { | Bound(b) => b.instance == instance | Unbound => false }
}
pure def connectListener(s: MirrorState): MirrorState =
  { ...s, listener: Bound({ instance: s.nextInstance }), nextInstance: s.nextInstance + 1, generation: s.generation + 1, handles: List() }
pure def canDisconnectListener(s: MirrorState, instance: int): bool = boundTo(s, instance)
pure def disconnectListener(s: MirrorState, instance: int): MirrorState =
  { ...s, listener: Unbound, generation: s.generation + 1, handles: List(), queue: s.queue.select(c => c.instance != instance) }
pure def redactRows(s: MirrorState): MirrorState = { ...s, generation: s.generation + 1, handles: List() }
pure def canEnqueueCallback(s: MirrorState, instance: int): bool = instance >= 1 and instance < s.nextInstance
pure def enqueueCallback(s: MirrorState, instance: int, key: str, app: str, postedAt: int, removal: bool): MirrorState =
  { ...s, queue: s.queue.append({ instance: instance, generation: s.generation, key: key, app: app, postedAt: postedAt, removal: removal }), handles: s.handles.select(h => h.key != key) }
pure def canOverflowQueue(s: MirrorState): bool = s.queue.length() > 0
pure def overflowQueue(s: MirrorState): MirrorState = { ...s, generation: s.generation + 1, handles: List(), queue: List() }
pure def staleCallback(s: MirrorState): bool = {
  val c = s.queue.nthOr(0, noCallback)
  c.generation != s.generation or not(boundTo(s, c.instance))
}
pure def canRunCallback(s: MirrorState): bool = s.queue.length() > 0
pure def runCallback(s: MirrorState, source: NoticeSource, unlocked: bool, appended: bool, now: int): MirrorState = {
  val c = s.queue.nthOr(0, noCallback)
  val rest = s.queue.removeAt(0)
  val others = s.handles.select(h => h.key != c.key)
  val recording = keepsHistory(s) and s.historyFile != UndeletedFile
  val rows = if (not(c.removal) and unlocked) withHandle(others, { key: c.key, handle: s.nextHandle, postedAt: c.postedAt }) else others
  if (staleCallback(s)) { ...s, queue: rest }
  else if (not(collecting(s))) { ...s, queue: rest, handles: List() }
  else if (not(admits(s, source, c.app))) { ...s, queue: rest, handles: others }
  else if (recording and not(appended)) { ...s, queue: rest, handles: List() }
  else { ...s, queue: rest, handles: rows, nextHandle: s.nextHandle + 1,
    historyFile: if (recording) KeptFile({ rows: withRecord(keptRows(s.historyFile), { app: c.app, at: now }) }) else s.historyFile }
}
pure val instanceValues = Set(1, 2)
pure def alwaysQueuedCallbacksAreIssued(s: MirrorState): bool = s.queue.every(c => c.generation <= s.generation and c.instance >= 1 and c.instance < s.nextInstance)
pure def stepGenerationNeverGoesBack(before: MirrorState, after: MirrorState): bool = after.generation >= before.generation
pure def stepCutGenerationDropsEveryRow(before: MirrorState, after: MirrorState): bool = after.generation != before.generation implies after.handles.length() == 0
pure def stepStaleCallbackChangesNothing(before: MirrorState, via: str, after: MirrorState): bool =
  (via == "runCallback" and staleCallback(before)) implies (after.handles == before.handles and after.historyFile == before.historyFile)
pure def sometimesStaleCallbackWaits(s: MirrorState): bool = s.queue.some(c => c.generation < s.generation)
```

### A secret notice is never shown or opened, and previews off hide the content

A hidden row shows the app label and fixed hidden-content text and is
marked redacted; it can still be dismissed if clearable. Open runs only the
posting app's own content intent.

```quint
type NoticeLook = PublicNotice | SecretNotice
type IntentOwner = NoIntent | PostingAppIntent | OtherAppIntent
type RowContent = FullContent | HiddenContent
pure def rowContent(previewAllowed: bool, look: NoticeLook): RowContent = if (previewAllowed and look == PublicNotice) FullContent else HiddenContent
pure def opensOwnIntent(look: NoticeLook, intent: IntentOwner): bool = look == PublicNotice and intent == PostingAppIntent
pure def lawSecretNoticeIsNeitherShownNorOpened(previewAllowed: bool, intent: IntentOwner): bool =
  rowContent(previewAllowed, SecretNotice) == HiddenContent and not(opensOwnIntent(SecretNotice, intent)) and rowContent(false, PublicNotice) == HiddenContent
```

## Story: Keep a short private history only while I allow it

> As the owner, I want an optional one-day history of when my picked apps
> posted and removed notices, kept only while I allow it, so that nothing
> lingers after I turn it off.

History is separate consent. A record holds a random ID, the package, its
signing digest, the app label, the recorded and posting times and Posted or
Removed; never a title, text, Android key or intent. It is encrypted with a
Keystore key in no-backup storage; a deletion checks that no base, backup or
pending file remains.

### History is kept only with my consent while collecting, for selected apps, at most a hundred records

```quint
pure val maxHistoryRecords = 100
pure def keptRows(file: HistoryFile): List[HistoryRecord] = match file { | KeptFile(k) => k.rows | _ => List() }
pure def isKept(file: HistoryFile): bool = match file { | KeptFile(_) => true | _ => false }
pure def withRecord(rows: List[HistoryRecord], r: HistoryRecord): List[HistoryRecord] =
  if (rows.length() < maxHistoryRecords) List(r).concat(rows) else List(r).concat(rows.removeAt(rows.length() - 1))
pure def alwaysKeptHistoryHasConsent(s: MirrorState): bool =
  isKept(s.historyFile) implies (keepsHistory(s) and keptRows(s.historyFile).length() <= maxHistoryRecords and keptRows(s.historyFile).every(r => s.selected.contains(r.app)))
pure def sometimesHistoryKept(s: MirrorState): bool = keptRows(s.historyFile).length() > 0
```

### A failed deletion is never reported as cleared and blocks history until a deletion succeeds

The owner's Clear cuts the generation, so queued callbacks cannot refill
history. A history file that should be gone but is not is never read or
appended to; each later status call retries the deletion.

```quint
type Confirmation = AndroidReturned | NoReturn
type RowAction = OpenRow | DismissRow
type MirrorReport = ActionRequested({ handle: int, rowAction: RowAction, confirmation: Confirmation }) | ActionRefused
  | HistoryCleared | HistoryNotCleared | HistoryShown({ now: int, rows: List[HistoryRecord] }) | HistoryWithheld
type MirrorStep = { state: MirrorState, out: List[MirrorReport] }
pure def canClearHistory(s: MirrorState, facts: HostFacts): bool = meetsNeed(WithFocus, facts)
pure def clearHistory(s: MirrorState, facts: HostFacts, deleted: bool): MirrorStep = {
  val file = afterDeletion(s.historyFile, deleted)
  { state: { ...s, generation: s.generation + 1, handles: List(), historyFile: file }, out: List(if (file == NoFile) HistoryCleared else HistoryNotCleared) }
}
pure def canRetryHistoryDeletion(s: MirrorState): bool = s.historyFile == UndeletedFile
pure def retryHistoryDeletion(s: MirrorState, deleted: bool): MirrorState = { ...s, historyFile: afterDeletion(s.historyFile, deleted) }
pure def stepClearedOnlyWhenNoFileRemains(before: MirrorState, via: str, after: MirrorState, out: List[MirrorReport]): bool =
  out.includes(HistoryCleared) implies after.historyFile == NoFile
pure def stepOwedDeletionBlocksHistory(before: MirrorState, after: MirrorState): bool =
  before.historyFile == UndeletedFile implies (after.historyFile == UndeletedFile or after.historyFile == NoFile)
pure def sometimesDeletionOwed(s: MirrorState): bool = s.historyFile == UndeletedFile
```

### History opens only on my focused, unlocked request and shows only current-signer records from the last day

Reading prunes records older than a day, from the future, or of an app whose
signer changed; the bridge returns only ID, app label, recorded time and
state.

```quint
pure val historyRetentionMs = 86400000
pure def retained(at: int, now: int): bool = at <= now and at > now - historyRetentionMs
pure def canShowHistory(s: MirrorState, facts: HostFacts): bool = meetsNeed(WithFocus, facts)
pure def showHistory(s: MirrorState, facts: HostFacts, now: int): MirrorStep = {
  val rows = keptRows(s.historyFile).select(r => retained(r.at, now) and not(s.changedSigners.contains(r.app)))
  if (keepsHistory(s) and isKept(s.historyFile)) { state: { ...s, historyFile: KeptFile({ rows: rows }) }, out: List(HistoryShown({ now: now, rows: rows })) }
  else { state: s, out: List(HistoryWithheld) }
}
pure val nowValues = Set(1, 86400001)
pure def stepHistoryOpensUnderCurrentAuthority(before: MirrorState, via: str, after: MirrorState, out: List[MirrorReport]): bool =
  out.every(o => match o {
    | HistoryShown(h) => keepsHistory(before) and isKept(before.historyFile) and
        h.rows.every(r => before.selected.contains(r.app) and not(before.changedSigners.contains(r.app)) and retained(r.at, h.now))
    | _ => true
  })
```

## Story: Act on exactly the notice I see

> As the owner, I want Open or Dismiss to act on exactly the notice I see, and
> to be told only what Android accepted, so that a stale row never acts and a
> request is never shown as done.

### Android accepting an open or dismiss request does not establish the new screen or the removal

Inside the mirror lock the shell rereads the Android row by its key; it is
`CurrentRow` only if its posting time is unchanged and it still passes
admission. Open sends the posting app's own intent, then cancels the row if
it auto-cancels; Dismiss asks the listener to cancel a clearable row.
`AndroidReturned` means those calls returned. The row disappears only when
Android's removal callback arrives. The assistant never sends an action.

```quint
type AndroidRow = RowGone | CurrentRow({ look: NoticeLook, intent: IntentOwner, clearable: bool })
pure def rowAllows(row: AndroidRow, rowAction: RowAction): bool =
  match row { | CurrentRow(r) => if (rowAction == OpenRow) opensOwnIntent(r.look, r.intent) else r.clearable | RowGone => false }
pure def requestAction(s: MirrorState, handle: int, rowAction: RowAction, facts: HostFacts, row: AndroidRow, confirmation: Confirmation): MirrorStep = {
  val admitted = meetsNeed(WithFocus, facts) and collecting(s) and isBound(s) and s.handles.some(h => h.handle == handle) and rowAllows(row, rowAction)
  { state: s, out: List(if (admitted) ActionRequested({ handle: handle, rowAction: rowAction, confirmation: confirmation }) else ActionRefused) }
}
pure val handleValues = Set(1, 2, 3)
pure val rowValues = Set(RowGone, CurrentRow({ look: PublicNotice, intent: PostingAppIntent, clearable: true }),
  CurrentRow({ look: SecretNotice, intent: PostingAppIntent, clearable: true }), CurrentRow({ look: PublicNotice, intent: OtherAppIntent, clearable: false }))
pure def stepActionLeavesRowsInPlace(before: MirrorState, via: str, after: MirrorState, out: List[MirrorReport]): bool =
  via == "requestAction" implies (after.handles == before.handles and
    out.every(o => match o { | ActionRequested(a) => collecting(before) and isBound(before) and before.handles.some(h => h.handle == a.handle) | _ => true }))
```
