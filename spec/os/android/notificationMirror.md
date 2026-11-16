# Cross-app notification mirror

A consumer installs its notification listener behind Android's
`BIND_NOTIFICATION_LISTENER_SERVICE` permission; the listener and the
consumer's notifications plugin share the process-wide
`NotificationAccess.MIRROR`. Eliza supplies
`plugins/plugin-native-notifications/android` with `NotificationMirror`,
`NotificationMirrorPolicy`, `NotificationMirrorListenerService` and
`NotificationsHostPlugin`; the consumer keeps its preferences name,
Keystore alias and history filename stable once installed. This spec owns
cross-app observations, local history and external-row action requests.
The app's own notices belong to the
[notification projection](./notificationProjection.md).

## Story: Choose which apps the device can mirror

> As the person, I want to choose which other apps' notifications the
> device may mirror, so that nothing from an app I did not pick is read.

### Android access and the current app policy are independent admission checks

Opening Android's notification-access settings reports `opened` once the
activity starts and confers no grant. The mirror collects only while Android
grants access, the owner enabled the policy and collection is not paused;
rows and actions also need the connected listener. A notice is admitted
only from this process's Android user and profile, posted under the
package's registered UID, from another package than the consumer, and
matching the selected package's current signing digest; a removed,
unreadable or changed signer fails admission.

The picker offers enabled, exported launcher activities, one per package,
excluding the consumer. A selection holds at most 20 offered packages. A
selected package whose signer changed must be removed in one saved policy
before it can be selected again. An update needs the expected policy
revision and creates a fresh one, and it is saved only after history is
purged, the commit succeeds and status reads back. Resume rechecks the
reviewed revision and persists the unpaused bit without a new revision.

```quint
type MirrorAccess = { granted: bool, enabled: bool, paused: bool, listener: bool, interactive: bool, locked: bool, historyOptIn: bool }
type NoticeProvenance = { sameUser: bool, ownPackage: bool, uidMatches: bool, selected: bool, signatureMatches: bool }
type PolicyResult = PolicySaved | TooManyApps | AppUnavailable | RemoveAndSelect | RefreshOrUnavailable
pure def collectionActive(access: MirrorAccess): bool = access.enabled and not(access.paused) and access.granted
pure def rowsReadable(access: MirrorAccess): bool = collectionActive(access) and access.listener and access.interactive and not(access.locked)
pure def keepsLocalHistory(access: MirrorAccess): bool = collectionActive(access) and access.historyOptIn
pure def admitSource(source: NoticeProvenance): bool =
  source.sameUser and not(source.ownPackage) and source.uidMatches and source.selected and source.signatureMatches
type PolicyUpdate = { foreground: bool, mirrorExists: bool, revisionMatches: bool, changesApps: bool, selections: int,
  allVisibleAndDistinct: bool, anyPinnedSignerChanged: bool, historyPurged: bool, committed: bool, statusReadable: bool }
pure def policyResult(update: PolicyUpdate): PolicyResult =
  if (not(update.foreground and update.mirrorExists and update.revisionMatches)) RefreshOrUnavailable
  else if (update.changesApps and update.selections > 20) TooManyApps
  else if (update.changesApps and not(update.allVisibleAndDistinct)) AppUnavailable
  else if (update.changesApps and update.anyPinnedSignerChanged) RemoveAndSelect
  else if (not(update.historyPurged and update.committed and update.statusReadable)) RefreshOrUnavailable
  else PolicySaved
pure def lawChangedSignerRequiresSeparateReselection(update: PolicyUpdate): bool =
  update.changesApps and update.anyPinnedSignerChanged implies policyResult(update) != PolicySaved
pure def lawSelectionIsBounded(update: PolicyUpdate): bool =
  update.changesApps and policyResult(update) == PolicySaved implies update.selections <= 20
pure val enabledAccess: MirrorAccess = { granted: true, enabled: true, paused: false, listener: true, interactive: true, locked: false, historyOptIn: true }
pure val reviewedSource: NoticeProvenance = { sameUser: true, ownPackage: false, uidMatches: true, selected: true, signatureMatches: true }
pure val reviewedUpdate: PolicyUpdate = { foreground: true, mirrorExists: true, revisionMatches: true, changesApps: true, selections: 3,
  allVisibleAndDistinct: true, anyPinnedSignerChanged: false, historyPurged: true, committed: true, statusReadable: true }
pure val accessValues = Set(enabledAccess, { ...enabledAccess, granted: false }, { ...enabledAccess, enabled: false },
  { ...enabledAccess, paused: true }, { ...enabledAccess, listener: false }, { ...enabledAccess, interactive: false },
  { ...enabledAccess, locked: true }, { ...enabledAccess, historyOptIn: false })
pure val sourceValues = Set(reviewedSource, { ...reviewedSource, sameUser: false }, { ...reviewedSource, ownPackage: true },
  { ...reviewedSource, uidMatches: false }, { ...reviewedSource, selected: false }, { ...reviewedSource, signatureMatches: false })
pure val updateValues = Set(reviewedUpdate, { ...reviewedUpdate, selections: 20 }, { ...reviewedUpdate, selections: 21 },
  { ...reviewedUpdate, allVisibleAndDistinct: false }, { ...reviewedUpdate, anyPinnedSignerChanged: true },
  { ...reviewedUpdate, revisionMatches: false }, { ...reviewedUpdate, historyPurged: false },
  { ...reviewedUpdate, committed: false }, { ...reviewedUpdate, statusReadable: false })
```

## Story: Show only current selected-app notices and keep their handles local

> As the person, I want to see only current notices from apps I picked,
> hidden when they are secret or I turned previews off, so that the
> mirror never shows more than the app itself would.

### Preview visibility, Android-device state and the viewing visit each control a separate read

The list adds up to 100 of the newest admitted active notices after the
app's own rows; rejected rows take no slot, and a failed mirror read leaves
the own rows. External rows need active collection, a connected listener
and an unlocked, interactive device; otherwise the list drops their handles
and returns none. A row keeps its random ID and revision while its posting
time is unchanged; replacement, invalidation and retirement issue fresh
handles, and the Android key never leaves native. A secret notice, or one
with previews off, shows the app label and fixed hidden-content text and is
marked redacted. Opening needs a nonsecret notice whose content intent the
posting UID created; a secret row can still be clearable. A view applies a
listed row only while the same visible visit is current and the row's ID,
revision and source are exact. An external row never becomes the selected
notification in agent context.

```quint
type ExternalRow = NoRow | PreviewRow | RedactedRow
type NoticeSource = OwnNotice | ExternalNotice | HostedNotice
type NoticeAppearance = { preview: bool, secret: bool, contentIntent: bool, creatorMatches: bool }
type ViewVisit = { visible: bool, sameVisit: bool, exactRow: bool }
pure def activeScanSlot(access: MirrorAccess, source: NoticeProvenance, alreadyAdmitted: int): bool =
  rowsReadable(access) and admitSource(source) and alreadyAdmitted >= 0 and alreadyAdmitted < 100
pure def previewVisible(access: MirrorAccess, source: NoticeProvenance, appearance: NoticeAppearance): bool =
  rowsReadable(access) and admitSource(source) and appearance.preview and not(appearance.secret)
pure def postingAppCanOpen(appearance: NoticeAppearance): bool =
  not(appearance.secret) and appearance.contentIntent and appearance.creatorMatches
pure def externalRow(access: MirrorAccess, source: NoticeProvenance, appearance: NoticeAppearance): ExternalRow =
  if (not(rowsReadable(access) and admitSource(source))) NoRow
  else if (previewVisible(access, source, appearance)) PreviewRow else RedactedRow
pure def enterAgentContext(noticeSource: NoticeSource): bool = noticeSource == OwnNotice
pure def rowUsable(visit: ViewVisit): bool = visit.visible and visit.sameVisit and visit.exactRow
pure def lawOlderRowsCannotExceedActiveLimit(access: MirrorAccess, source: NoticeProvenance, alreadyAdmitted: int): bool =
  alreadyAdmitted >= 100 implies not(activeScanSlot(access, source, alreadyAdmitted))
pure def lawSecretNeverRevealsOrOpens(access: MirrorAccess, source: NoticeProvenance, appearance: NoticeAppearance): bool =
  appearance.secret implies externalRow(access, source, appearance) != PreviewRow and not(postingAppCanOpen(appearance))
pure def lawExternalRowNeverEntersAgentContext(noticeSource: NoticeSource): bool =
  noticeSource == ExternalNotice implies not(enterAgentContext(noticeSource))
pure def lawRetiredVisitCannotUseRow(visit: ViewVisit): bool = not(visit.sameVisit) implies not(rowUsable(visit))
pure val alreadyAdmittedValues = Set(0, 1, 99, 100, 101)
pure val showNotice: NoticeAppearance = { preview: true, secret: false, contentIntent: true, creatorMatches: true }
pure val appearanceValues = Set(showNotice, { ...showNotice, preview: false }, { ...showNotice, secret: true },
  { ...showNotice, contentIntent: false }, { ...showNotice, creatorMatches: false })
pure val visitValues = Set({ visible: true, sameVisit: true, exactRow: true }, { visible: false, sameVisit: true, exactRow: true },
  { visible: true, sameVisit: false, exactRow: true }, { visible: true, sameVisit: true, exactRow: false })
```

### A queued notification callback belongs to its listener and collection generation

The listener serializes post and removal callbacks on one worker with a
queue of 64. Enqueueing captures the generation and invalidates the key's
handle; overflow redacts all handles, advances the generation and drops
waiting callbacks. Only the exact listener and captured generation may run
a callback, which invalidates its key again before admission. An admitted
post establishes a handle only on an unlocked, interactive device, though
history may still record it while locked. A new listener, a disconnect of
the current listener, screen off and host pause each cut the generation and
redact handles. A settings update or an owner Clear cuts the generation and
deletes history before committing; a failed history deletion is never
reported as cleared. Pause and Resume cut the generation before persisting
the pause bit. A callback that finds collection off with access revoked
tries to delete history and clears the marker only if that succeeds. A
failed history append records nothing and leaves no handle.

```quint
type MirrorState = { generation: int, queuedAt: int, handleAt: int, historyAt: int, historyKept: bool }
pure val initial: MirrorState = { generation: 0, queuedAt: -1, handleAt: -1, historyAt: -1, historyKept: false }
pure def canQueueNotice(mirrorState: MirrorState): bool = mirrorState.queuedAt < 0
pure def queueNotice(mirrorState: MirrorState): MirrorState = { ...mirrorState, queuedAt: mirrorState.generation, handleAt: -1 }
type CallbackFacts = { listenerMatches: bool, sourceAdmitted: bool, collectionOn: bool, posted: bool, unlocked: bool,
  historyAllowed: bool, historySaved: bool, lostGrantClearedHistory: bool }
pure def canFinishNotice(mirrorState: MirrorState): bool = mirrorState.queuedAt >= 0
pure def finishNotice(mirrorState: MirrorState, callback: CallbackFacts): MirrorState =
  if (mirrorState.queuedAt != mirrorState.generation or not(callback.listenerMatches)) { ...mirrorState, queuedAt: -1 }
  else if (not(callback.collectionOn))
    { ...mirrorState, queuedAt: -1, handleAt: -1,
      historyAt: if (callback.lostGrantClearedHistory) -1 else mirrorState.historyAt,
      historyKept: mirrorState.historyKept and not(callback.lostGrantClearedHistory) }
  else if (not(callback.sourceAdmitted)) { ...mirrorState, queuedAt: -1, handleAt: -1 }
  else { ...mirrorState, queuedAt: -1,
    handleAt: if (callback.posted and callback.unlocked and (not(callback.historyAllowed) or callback.historySaved)) mirrorState.generation else -1,
    historyAt: if (callback.historyAllowed and callback.historySaved) mirrorState.generation else mirrorState.historyAt,
    historyKept: mirrorState.historyKept or (callback.historyAllowed and callback.historySaved) }
pure def redactHandles(mirrorState: MirrorState): MirrorState =
  { ...mirrorState, generation: mirrorState.generation + 1, handleAt: -1 }
pure def clearMirrorHistory(mirrorState: MirrorState, deleted: bool): MirrorState =
  { ...mirrorState, generation: mirrorState.generation + 1, handleAt: -1,
    historyKept: mirrorState.historyKept and not(deleted), historyAt: if (deleted) -1 else mirrorState.historyAt }
pure def alwaysLiveHandleMatchesGeneration(mirrorState: MirrorState): bool =
  mirrorState.generation >= 0 and (mirrorState.handleAt == -1 or mirrorState.handleAt == mirrorState.generation)
pure def alwaysQueuedGenerationIsNotFuture(mirrorState: MirrorState): bool =
  mirrorState.queuedAt >= -1 and mirrorState.queuedAt <= mirrorState.generation
pure def alwaysHistoryMarkerTracksRetainedEvidence(mirrorState: MirrorState): bool =
  (mirrorState.historyAt >= 0) == mirrorState.historyKept and mirrorState.historyAt <= mirrorState.generation
pure def stepStaleCallbackCannotChangeEvidence(before: MirrorState, via: str, after: MirrorState): bool =
  via == "finishNotice" and before.queuedAt != before.generation implies
    after.handleAt == before.handleAt and after.historyAt == before.historyAt
pure def sometimesLiveNoticeAndHistory(mirrorState: MirrorState): bool = mirrorState.handleAt >= 0 and mirrorState.historyKept
pure def sometimesPendingNoticePrecedesClear(mirrorState: MirrorState): bool =
  mirrorState.queuedAt >= 0 and mirrorState.queuedAt < mirrorState.generation and not(mirrorState.historyKept)
pure val admittedCallback: CallbackFacts = { listenerMatches: true, sourceAdmitted: true, collectionOn: true, posted: true,
  unlocked: true, historyAllowed: true, historySaved: true, lostGrantClearedHistory: false }
pure val callbackValues = Set(admittedCallback, { ...admittedCallback, posted: false }, { ...admittedCallback, unlocked: false },
  { ...admittedCallback, historySaved: false }, { ...admittedCallback, listenerMatches: false },
  { ...admittedCallback, sourceAdmitted: false }, { ...admittedCallback, collectionOn: false, lostGrantClearedHistory: true })
```

### History keeps bounded encrypted metadata and opens only under current authority

History is separate consent and records admitted posts and removals as a
random ID, package, signing digest, app label, recorded and posting time
and state, never a title, body, platform key or intent; the bridge returns
only ID, app label, recorded time and state. A retained record is younger
than 24 hours and not in the future. Pruning keeps only still-selected
matching signers, under active collection and history consent, and at most
100 entries, newest first. Explicit history reads, clear, policy changes and
external actions need a focused activity and an unlocked device, and the
history read also an interactive one. History is encrypted at rest with a
Keystore key in no-backup storage, and a clear verifies that no base,
backup or pending file remains.

```quint
pure def historyRange(recordedAt: int, now: int): bool = recordedAt <= now and recordedAt > now - 86400000
type HistoryFacts = { foreground: bool, readable: bool, samePackage: bool, sameSignature: bool, signatureCurrent: bool, recordedAt: int, now: int }
pure def historySlot(retainedBefore: int): bool = retainedBefore >= 0 and retainedBefore < 100
pure def historyRowVisible(access: MirrorAccess, history: HistoryFacts): bool =
  history.foreground and history.readable and keepsLocalHistory(access) and access.interactive and not(access.locked) and
  history.samePackage and history.sameSignature and history.signatureCurrent and historyRange(history.recordedAt, history.now)
pure def lawHistoryNeverShowsOtherSigner(access: MirrorAccess, history: HistoryFacts): bool =
  historyRowVisible(access, history) implies history.samePackage and history.sameSignature and history.signatureCurrent
pure def lawHistoryBoundaryIsExclusive(recordedAt: int, now: int): bool =
  recordedAt <= now - 86400000 or recordedAt > now implies not(historyRange(recordedAt, now))
pure def lawHistoryIsBounded(retainedBefore: int): bool = retainedBefore >= 100 implies not(historySlot(retainedBefore))
pure val retainedBeforeValues = Set(0, 99, 100, 101)
pure val recentHistory: HistoryFacts = { foreground: true, readable: true, samePackage: true, sameSignature: true, signatureCurrent: true, recordedAt: 1, now: 86400000 }
pure val historyValues = Set(recentHistory, { ...recentHistory, recordedAt: 0 }, { ...recentHistory, recordedAt: 86400001 },
  { ...recentHistory, signatureCurrent: false }, { ...recentHistory, foreground: false })
pure val recordedAtValues = Set(0, 1, 86400000, 86400001)
pure val nowValues = Set(0, 86400000)
```

## Story: Request an action on the exact current notice

> As the person, I want Open or Dismiss to act on exactly the notice I see,
> and to be told only what Android accepted, so that a stale row never acts
> and a request is never shown as done.

### Android acceptance of a request does not establish the resulting screen or removal

External actions run only for an exact external row. After the foreground
check, inside the mirror lock, the action rechecks access, connection,
unlocked and interactive device, exact ID and revision, and rereads the
original Android key, which must keep its posting time and pass the current
source checks. Open needs a nonsecret notice whose content intent the
posting UID created; a successful send may be followed by auto-cancel.
Dismiss needs Android's current clearable flag and asks the listener to
cancel the key. Open resolves only when the send, and any auto-cancel,
returned; Dismiss and each row of a bulk clear report requested only when
the cancel returned, and otherwise unavailable or unconfirmed. No receipt
claims a new screen or an observed removal, and the assistant never sends
an external action.

```quint
type ActionReceipt = ActionRefused | OpenResolved | DismissRequested | EffectUnconfirmed
type ClearRowStatus = ClearRequested | ClearUnavailable
type ExternalAction = { foreground: bool, exactHandle: bool, exactPostTime: bool, androidRowFound: bool, clearable: bool,
  open: bool, autoCancel: bool, sendReturned: bool, cancelReturned: bool }
pure def actionAdmitted(access: MirrorAccess, source: NoticeProvenance, appearance: NoticeAppearance, request: ExternalAction): bool =
  request.foreground and rowsReadable(access) and request.exactHandle and request.exactPostTime and request.androidRowFound and
  admitSource(source) and (if (request.open) postingAppCanOpen(appearance) else request.clearable)
pure def externalActionReceipt(access: MirrorAccess, source: NoticeProvenance, appearance: NoticeAppearance, request: ExternalAction): ActionReceipt =
  if (not(actionAdmitted(access, source, appearance, request))) ActionRefused
  else if (request.open) {
    if (request.sendReturned and (not(request.autoCancel) or request.cancelReturned)) OpenResolved else EffectUnconfirmed
  } else if (request.cancelReturned) DismissRequested else EffectUnconfirmed
pure def clearRowStatus(actionReceipt: ActionReceipt): ClearRowStatus =
  if (actionReceipt == DismissRequested) ClearRequested else ClearUnavailable
pure def lawActionNeedsExactLiveRow(access: MirrorAccess, source: NoticeProvenance, appearance: NoticeAppearance, request: ExternalAction): bool =
  externalActionReceipt(access, source, appearance, request) != ActionRefused implies
    request.exactHandle and request.androidRowFound and request.exactPostTime and rowsReadable(access) and admitSource(source)
pure def lawOpenReceiptRequiresIntentReturn(access: MirrorAccess, source: NoticeProvenance, appearance: NoticeAppearance, request: ExternalAction): bool =
  externalActionReceipt(access, source, appearance, request) == OpenResolved implies
    request.open and postingAppCanOpen(appearance) and request.sendReturned and (not(request.autoCancel) or request.cancelReturned)
pure def lawDismissReceiptRequiresCancelReturn(access: MirrorAccess, source: NoticeProvenance, appearance: NoticeAppearance, request: ExternalAction): bool =
  externalActionReceipt(access, source, appearance, request) == DismissRequested implies
    not(request.open) and request.clearable and request.cancelReturned
pure def lawOnlyARequestedDismissClearsARow(actionReceipt: ActionReceipt): bool =
  clearRowStatus(actionReceipt) == ClearRequested implies actionReceipt == DismissRequested
pure val currentAction: ExternalAction = { foreground: true, exactHandle: true, exactPostTime: true, androidRowFound: true, clearable: true,
  open: true, autoCancel: false, sendReturned: true, cancelReturned: true }
pure val requestValues = Set(currentAction, { ...currentAction, open: false }, { ...currentAction, exactHandle: false },
  { ...currentAction, exactPostTime: false }, { ...currentAction, foreground: false },
  { ...currentAction, autoCancel: true, cancelReturned: false }, { ...currentAction, sendReturned: false },
  { ...currentAction, open: false, clearable: false })
```
