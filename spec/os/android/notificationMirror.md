# Notification mirror

The opt-in mirror of other apps' notifications on an Android host
(`android/notifications/`, `NotificationMirror*`). The consumer declares its
listener subclass behind `BIND_NOTIFICATION_LISTENER_SERVICE` and keeps its
preferences name, Keystore alias and history file name stable once
installed. Rows show in the owner's app only: nothing leaves the device or
enters the agent's context. Call admission is [the bridge](./bridge.md)'s;
text, intents and Android keys stay in the shell.

## Story: Mirror only the notifications I allowed

> As the owner, I want my device to mirror only the apps I picked, and only
> while Android grants access and I have the mirror on, so that nothing from an
> app I did not pick is read.

### Android access, my switch and my pause are separate conditions for collecting

Opening Android's notification-access settings confers no grant; the shell
observes the grant on each call. A revoked grant, a pause and a resume each
cut the collection generation and drop every row; a revoked grant or a pause
also deletes history. A reviewed resume needs the exact current policy
revision and takes a fresh one after history cleanup.

```quint
import bridge.* from "./bridge"
type ListenerSlot = Unbound | Bound({ instance: int })
type MirrorScope = DeviceScope | UnknownScope | AccountScope({ ownerKey: str })
type RowHandle = { key: str, handle: int, postedAt: int }
type Callback = { instance: int, generation: int, key: str, app: str, postedAt: int, removal: bool }
type HistoryRecord = { app: str, at: int }
type HistoryFile = NoFile | KeptFile({ rows: List[HistoryRecord] }) | UndeletedFile
type MirrorState = { revision: int, ownerEnabled: bool, historyConsent: bool, paused: bool, granted: bool, selected: Set[str], changedSigners: Set[str],
  listener: ListenerSlot, nextInstance: int, generation: int, queue: List[Callback], handles: List[RowHandle], nextHandle: int, historyFile: HistoryFile, scope: MirrorScope, boundOwner: str }
pure val initial: MirrorState = { revision: 0, ownerEnabled: false, historyConsent: false, paused: false, granted: false, selected: Set(), changedSigners: Set(),
  listener: Unbound, nextInstance: 1, generation: 0, queue: List(), handles: List(), nextHandle: 1, historyFile: NoFile, scope: DeviceScope, boundOwner: "" }
pure def mirrorOwner(s: MirrorState): str =
  val scope = s.scope
  match scope { | AccountScope(account) => account.ownerKey | _ => "" }
pure def admitted(s: MirrorState): bool =
  s.scope == DeviceScope or (s.boundOwner != "" and mirrorOwner(s) == s.boundOwner)
pure def policyCollects(s: MirrorState): bool = s.granted and s.ownerEnabled and not(s.paused)
pure def collecting(s: MirrorState): bool = admitted(s) and policyCollects(s)
pure def keepsHistory(s: MirrorState): bool = collecting(s) and s.historyConsent
pure def afterDeletion(file: HistoryFile, deleted: bool): HistoryFile = if (deleted or file == NoFile) NoFile else UndeletedFile
pure def purged(deleted: bool, s: MirrorState): MirrorState =
  { ...s, generation: s.generation + 1, handles: List(), historyFile: afterDeletion(s.historyFile, deleted) }
pure def canObserveAccess(s: MirrorState, granted: bool): bool = granted != s.granted
pure def observeAccess(s: MirrorState, granted: bool, deleted: bool): MirrorState =
  if (granted) { ...s, granted: true } else { ...purged(deleted, s), granted: false }
pure val weight_observeAccess = 4
pure def canPause(s: MirrorState): bool = not(s.paused)
pure def pause(s: MirrorState, deleted: bool): MirrorState = { ...purged(deleted, s), paused: true }
pure def canResume(s: MirrorState, expectedRevision: int, facts: HostFacts): bool =
  admitted(s) and s.paused and expectedRevision == s.revision and meetsNeed(WithFocus, facts)
pure def resume(s: MirrorState, expectedRevision: int, facts: HostFacts, deleted: bool, committed: bool): MirrorState =
  val cleared = purged(deleted, s)
  if (deleted and committed) { ...cleared, paused: false, revision: s.revision + 1 } else cleared
```

### A selection holds at most twenty visible apps, and an app whose signer changed must be removed before it is chosen again

The picker offers exported launcher apps, never the consumer. A chosen app
is pinned to its signing digest; a signer change marks it until dropped.

```quint
pure val maxSelectedApps = 20
pure def canChooseApps(s: MirrorState, expectedRevision: int, requested: Set[str], visible: Set[str], facts: HostFacts): bool =
  admitted(s) and meetsNeed(WithFocus, facts) and expectedRevision == s.revision and requested.size() <= maxSelectedApps and
  requested.subseteq(visible) and requested.intersect(s.changedSigners).size() == 0
pure def chooseApps(s: MirrorState, expectedRevision: int, requested: Set[str], visible: Set[str], facts: HostFacts, deleted: bool, committed: bool): MirrorState =
  if (deleted and committed) { ...purged(deleted, s), selected: requested, changedSigners: Set(), revision: s.revision + 1 } else purged(deleted, s)
pure def canObserveSignerChanged(s: MirrorState, app: str): bool = s.selected.contains(app) and not(s.changedSigners.contains(app))
pure def observeSignerChanged(s: MirrorState, app: str): MirrorState = { ...s, changedSigners: s.changedSigners.union(Set(app)) }
pure val weight_chooseApps = 8
pure val requestedValues = Set(Set(), Set("a"), Set("a", "b"))
pure val visibleValues = Set(Set("a", "b"), Set("b"))
pure val appValues = Set("a", "b")
pure val expectedRevisionValues = Set(0, 1, 2)
pure def alwaysSelectionIsBounded(s: MirrorState): bool = s.selected.size() <= maxSelectedApps and s.changedSigners.subseteq(s.selected)
pure def sometimesChangedSignerAwaitsRemoval(s: MirrorState): bool = s.changedSigners.size() > 0
```

### A settings change is saved only for the reviewed revision and only after rows and history are purged

The purge cuts the generation, so callbacks queued under the old settings
cannot act; a failed deletion or a failed commit saves nothing.

```quint
pure def canSaveSettings(s: MirrorState, expectedRevision: int, facts: HostFacts): bool = admitted(s) and meetsNeed(WithFocus, facts) and expectedRevision == s.revision
pure def saveSettings(s: MirrorState, expectedRevision: int, ownerEnabled: bool, historyConsent: bool, facts: HostFacts, deleted: bool, committed: bool): MirrorState =
  if (deleted and committed) { ...purged(deleted, s), ownerEnabled: ownerEnabled, historyConsent: historyConsent, revision: s.revision + 1 } else purged(deleted, s)
pure val weight_saveSettings = 8
pure def stepPolicyChangeFollowsAPurge(before: MirrorState, after: MirrorState): bool =
  after.revision != before.revision implies (after.revision == before.revision + 1 and after.historyFile == NoFile and after.handles.length() == 0 and after.generation > before.generation)
```

## Story: Show only current notices from apps I picked

> As the owner, I want to see only current notices from apps I picked, hidden
> when they are secret or I turned previews off, so that the mirror never
> shows more than the app itself would.

### A notice is admitted only from another app of my user, posted under its own UID, selected and with its current signer

A removed package counts as `MismatchedUidNotice`. A row keeps its handle
while its posting time holds; a list read that is locked, unbound or not
collecting drops every row.

```quint
type NoticeSource = ForeignAppNotice | OwnAppNotice | OtherUserNotice | MismatchedUidNotice
pure val maxActiveRows = 100
pure def admits(s: MirrorState, source: NoticeSource, app: str): bool =
  source == ForeignAppNotice and s.selected.contains(app) and not(s.changedSigners.contains(app))
pure def boundTo(s: MirrorState, instance: int): bool = {
  val slot = s.listener
  match slot { | Bound(b) => b.instance == instance | Unbound => false }
}
pure def isBound(s: MirrorState): bool = {
  val slot = s.listener
  match slot { | Bound(_) => true | Unbound => false }
}
pure def withHandle(handles: List[RowHandle], h: RowHandle): List[RowHandle] = {
  val rows = handles.select(x => x.key != h.key).append(h)
  if (rows.length() > maxActiveRows) rows.removeAt(0) else rows
}
pure def listNotice(s: MirrorState, key: str, app: str, postedAt: int, source: NoticeSource, unlocked: bool): MirrorState =
  if (not(collecting(s) and isBound(s) and unlocked)) { ...s, handles: List() }
  else if (not(admits(s, source, app)) or s.handles.some(h => h.key == key and h.postedAt == postedAt)) s
  else { ...s, handles: withHandle(s.handles, { key: key, handle: s.nextHandle, postedAt: postedAt }), nextHandle: s.nextHandle + 1 }
pure val keyValues = Set("k1", "k2")
pure val postedAtValues = Set(1, 2)
```

### A row handle exists only while collecting with a connected listener, and a new or replaced notice gets a fresh one

At most the newest hundred rows hold handles; the Android key never leaves
native code. The mirror starts with a positive next handle and never moves
that counter back.

```quint
pure def alwaysRowsNeedLiveCollection(s: MirrorState): bool = s.handles.length() > 0 implies (collecting(s) and isBound(s))
pure def alwaysRowHandlesAreIssued(s: MirrorState): bool = s.nextHandle >= 1 and s.handles.length() <= maxActiveRows and s.handles.every(h => h.handle >= 1 and h.handle < s.nextHandle)
pure def stepNewRowsGetFreshHandles(before: MirrorState, after: MirrorState): bool =
  after.handles.every(h => before.handles.includes(h) or h.handle >= before.nextHandle)
pure def sometimesLiveRow(s: MirrorState): bool = s.handles.length() > 0
```

### A queued callback acts only for its own listener and the generation it was queued in

Callbacks run one at a time from a queue of 64. Only the current admitted
listener can queue a callback, which captures the generation and drops
the key's row. A refused submission (full queue or
shut-down executor) also drops the queue; a new listener, a disconnect,
screen off and a host pause cut the generation. A post makes a row only on
an unlocked, interactive device; a failed history append drops every row.

```quint
pure val maxQueuedCallbacks = 64
pure val noCallback: Callback = { instance: 0, generation: -1, key: "", app: "", postedAt: 0, removal: false }
pure def canConnectListener(s: MirrorState): bool = admitted(s)
pure def connectListener(s: MirrorState): MirrorState =
  { ...s, listener: Bound({ instance: s.nextInstance }), nextInstance: s.nextInstance + 1, generation: s.generation + 1, handles: List() }
pure def canDisconnectListener(s: MirrorState, instance: int): bool = boundTo(s, instance)
pure def disconnectListener(s: MirrorState, instance: int): MirrorState =
  { ...s, listener: Unbound, generation: s.generation + 1, handles: List(), queue: s.queue.select(c => c.instance != instance) }
pure def redactRows(s: MirrorState): MirrorState = { ...s, generation: s.generation + 1, handles: List() }
pure def canEnqueueCallback(s: MirrorState, instance: int): bool =
  admitted(s) and boundTo(s, instance) and instance >= 1 and instance < s.nextInstance and s.queue.length() < maxQueuedCallbacks
pure def enqueueCallback(s: MirrorState, instance: int, key: str, app: str, postedAt: int, removal: bool): MirrorState =
  { ...s, queue: s.queue.append({ instance: instance, generation: s.generation, key: key, app: app, postedAt: postedAt, removal: removal }), handles: s.handles.select(h => h.key != key) }
pure def refuseCallback(s: MirrorState): MirrorState = { ...s, generation: s.generation + 1, handles: List(), queue: List() }
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
pure val weight_enqueueCallback = 6
pure val weight_runCallback = 6
pure val instanceValues = Set(1, 2)
pure def alwaysQueuedCallbacksAreIssued(s: MirrorState): bool =
  s.queue.length() <= maxQueuedCallbacks and s.queue.every(c => c.generation <= s.generation and c.instance >= 1 and c.instance < s.nextInstance)
pure def stepCutGenerationDropsEveryRow(before: MirrorState, after: MirrorState): bool =
  after.generation >= before.generation and (after.generation != before.generation implies after.handles.length() == 0)
pure def stepStaleCallbackChangesNothing(before: MirrorState, via: str, after: MirrorState): bool =
  (via == "runCallback" and staleCallback(before)) implies (after.handles == before.handles and after.historyFile == before.historyFile)
pure def sometimesStaleCallbackWaits(s: MirrorState): bool = s.queue.some(c => c.generation < s.generation)
```

### Secret notice content and disabled previews are hidden, and secret notice opens are refused

A hidden row shows the app label and fixed hidden-content text and is marked
redacted; it can still be dismissed if clearable. Open runs only an intent
the posting app created.

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

History is separate consent. A record holds an ID, package, signing digest,
label, times and Posted or Removed, never text, key or intent; it is
encrypted in no-backup storage, and a deletion checks no file remains.

### History records only selected apps while collecting with my consent, up to a hundred records

An account-bound host with unresolved custody keeps the encrypted history
withheld until it authenticates the same owner or retires the old one.

```quint
pure val maxHistoryRecords = 100
pure def keptRows(file: HistoryFile): List[HistoryRecord] = match file { | KeptFile(k) => k.rows | _ => List() }
pure def isKept(file: HistoryFile): bool = match file { | KeptFile(_) => true | _ => false }
pure def withRecord(rows: List[HistoryRecord], r: HistoryRecord): List[HistoryRecord] =
  if (rows.length() < maxHistoryRecords) List(r).concat(rows) else List(r).concat(rows.removeAt(rows.length() - 1))
pure def alwaysKeptHistoryHasConsent(s: MirrorState): bool =
  isKept(s.historyFile) implies (policyCollects(s) and s.historyConsent and keptRows(s.historyFile).length() <= maxHistoryRecords and keptRows(s.historyFile).every(r => s.selected.contains(r.app)))
pure def sometimesHistoryKept(s: MirrorState): bool = keptRows(s.historyFile).length() > 0
```

### A failed deletion is never reported as cleared and blocks history until a deletion succeeds

The owner's Clear applies only to the reviewed revision. It cuts the
generation, so queued callbacks cannot refill history, and a successful
clear takes a fresh revision. A file that should be gone but is not is never read or appended
to; each later status call retries the deletion.

```quint
type Confirmation = AndroidReturned | NoReturn
type RowAction = OpenRow | DismissRow
type MirrorReport = ActionRequested({ handle: int, rowAction: RowAction, confirmation: Confirmation }) | ActionRefused
  | HistoryCleared | HistoryNotCleared | HistoryShown({ now: int, rows: List[HistoryRecord] }) | HistoryWithheld
type MirrorStep = { state: MirrorState, out: List[MirrorReport] }
pure def canClearHistory(s: MirrorState, expectedRevision: int, facts: HostFacts): bool =
  admitted(s) and expectedRevision == s.revision and meetsNeed(WithFocus, facts)
pure def clearHistory(s: MirrorState, expectedRevision: int, facts: HostFacts, deleted: bool, committed: bool): MirrorStep = {
  val cleared = purged(deleted, s)
  if (cleared.historyFile == NoFile and committed)
    { state: { ...cleared, revision: s.revision + 1 }, out: List(HistoryCleared) }
  else { state: cleared, out: List(HistoryNotCleared) }
}
pure def canRetryHistoryDeletion(s: MirrorState): bool = s.historyFile == UndeletedFile
pure def retryHistoryDeletion(s: MirrorState, deleted: bool): MirrorState = { ...s, historyFile: afterDeletion(s.historyFile, deleted) }
pure val weight_clearHistory = 3
pure val weight_retryHistoryDeletion = 8
pure def stepClearedOnlyWhenNoFileRemains(before: MirrorState, via: str, after: MirrorState, out: List[MirrorReport]): bool =
  out.includes(HistoryCleared) implies after.historyFile == NoFile
pure def stepOwedDeletionBlocksHistory(before: MirrorState, after: MirrorState): bool =
  before.historyFile == UndeletedFile implies (after.historyFile == UndeletedFile or after.historyFile == NoFile)
pure def sometimesDeletionOwed(s: MirrorState): bool = s.historyFile == UndeletedFile
```

### History opens only on my focused, unlocked request and shows only current-signer records from the last day

An unresolved owner leaves encrypted history withheld. Reading prunes records older than a day, from the future, or of an app whose
signer changed; the bridge returns only ID, app label, recorded time and
state.

```quint
pure val historyRetentionMs = 86400000
pure def retained(at: int, now: int): bool = at <= now and at > now - historyRetentionMs
pure def canShowHistory(s: MirrorState, facts: HostFacts): bool = admitted(s) and meetsNeed(WithFocus, facts)
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

The shell rereads the Android row by key under the mirror lock: `CurrentRow`
only with an unchanged posting time and current admission. `AndroidReturned`
means the send or cancel call returned; the row goes only on Android's
removal callback. The assistant never sends an action.

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

### A host with account custody activates collection only for the native owner bound to its policy

A host whose scope is the Android user needs no account binding. An
account-bound host with unresolved custody withholds its policy and
history, unbinds its listener, and invalidates queued work. A return of
the same verified owner keeps the policy and history. Retiring a
different or signed-out owner first durably removes admission. Only
when old history is actually deleted does retirement store a fresh off
policy, and only then can a verified owner be bound again. A legacy
policy with no account binding needs fresh consent.

```quint
pure val scopeValues = Set(DeviceScope, UnknownScope, AccountScope({ ownerKey: "first" }), AccountScope({ ownerKey: "second" }))

pure def canObserveMirrorScope(s: MirrorState, scope: MirrorScope): bool = scope != s.scope

pure def observeMirrorScope(s: MirrorState, scope: MirrorScope): MirrorState =
  { ...s, scope: scope, listener: Unbound, generation: s.generation + 1, handles: List() }

pure def canRetireMirrorOwner(s: MirrorState): bool = s.scope != DeviceScope

pure def retireMirrorOwner(s: MirrorState, deleted: bool, committed: bool): MirrorState =
  val retired = purged(deleted, { ...s, boundOwner: "", listener: Unbound, paused: true })
  if (deleted and committed) { ...retired, ownerEnabled: false, historyConsent: false, paused: true,
    selected: Set(), changedSigners: Set(), revision: s.revision + 1 } else retired

pure def canBindMirrorOwner(s: MirrorState): bool =
  val owner = mirrorOwner(s)
  owner != "" and s.boundOwner == "" and not(s.ownerEnabled) and not(s.historyConsent)
    and s.selected.size() == 0 and s.historyFile == NoFile

pure def bindMirrorOwner(s: MirrorState): MirrorState =
  { ...s, boundOwner: mirrorOwner(s), paused: false }

pure def alwaysUnadmittedMirrorHasNoHandles(s: MirrorState): bool =
  not(admitted(s)) implies s.handles.length() == 0
```
