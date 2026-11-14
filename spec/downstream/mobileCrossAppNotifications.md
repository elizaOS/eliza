# AlphaPhone cross-app notification mirror

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` installs `AlphaNotificationListener` behind Android's `BIND_NOTIFICATION_LISTENER_SERVICE` permission. That component and `AlphaNotificationsPlugin`, registered as `AlphaNotifications`, use the same process-wide `NotificationAccess.MIRROR`. Alpha preserves the deployed preferences name `alpha-notification-access`, Keystore alias `alpha.notification.history.v1`, and no-backup filename `notification-history.enc`. Eliza `c518127a025ab173874af9c7d304f26b25213b0d` supplies `plugins/plugin-native-notifications/android` with `NotificationMirror`, `NotificationMirrorPolicy`, `NotificationMirrorListenerService`, and `NotificationsHostPlugin`. This spec owns cross-app observations, local history, and external-row action requests. Resident posts and own notification routing have separate owners.

## Story: Choose which apps Alpha can mirror

### Android access and the current app policy are independent admission checks

Opening Android notification-access settings reports `opened` after the settings activity starts. API 30 and newer prefer the component detail activity with a fallback to the general listener settings. That response confers no grant. Android access is queried for the installed component. The mirror is active when Android granted access, the owner enabled the policy, and collection is unpaused. The listener connection is required for active rows and actions. Each admitted notice must belong to the process's Android user handle, including its profile, be posted under the package's registered UID, come from a different package from Alpha, and match a selected package's current certificate digest. A removed, unreadable or changed signing identity fails admission. This uses the SHA-256 digest of the package's current APK signer bytes in platform order, encoded with Android Base64 without wrapping.

The app picker includes visible launcher activities that are enabled and exported and have an enabled app, with one choice per package excluding Alpha. A new selection has at most 20 distinct currently offered packages. A previously selected package with a changed signer must be removed in one saved policy before it can be selected under a new signer. The update requires the expected policy revision. Accepted app entries store the package, current signature, bounded label and preview choice. Each successful update creates a fresh policy revision. A failure rereading status can still reject after the commit. Resume checks the reviewed revision under the mirror lock and persists an unpaused bit without changing the policy revision. Switching Alpha into mock mode first waits for both the live notification collector and hosted background operation to pause. Restoration awaits the user's separate Resume decision. Eliza `NotificationMirror.java:71–164,199–267`, `NotificationMirrorPolicy.java:51–105`, `NotificationsHostPlugin.java:217–234`. Alpha `AlphaConnectionPlugin.java:172–175`, `runtime/mock-admission.ts:5–12`.

```quint
type MirrorAccess = { granted: bool, enabled: bool, paused: bool, listener: bool, interactive: bool, locked: bool, historyOptIn: bool }
type NoticeProvenance = { sameUser: bool, ownPackage: bool, uidMatches: bool, selected: bool, signatureMatches: bool }
pure def collectionActive(access: MirrorAccess): bool = access.enabled and not(access.paused) and access.granted
pure def rowsReadable(access: MirrorAccess): bool = collectionActive(access) and access.listener and access.interactive and not(access.locked)
pure def keepsLocalHistory(access: MirrorAccess): bool = collectionActive(access) and access.historyOptIn
pure def admitSource(source: NoticeProvenance): bool =
  source.sameUser and not(source.ownPackage) and source.uidMatches and source.selected and source.signatureMatches
type PolicyUpdate = { foreground: bool, mirrorExists: bool, revisionMatches: bool, changesApps: bool, selections: int, allVisibleAndDistinct: bool, anyPinnedSignerChanged: bool, historyPurged: bool, committed: bool, statusReadable: bool }
pure def policyResult(update: PolicyUpdate): str =
  if (not(update.foreground and update.mirrorExists and update.revisionMatches)) "refresh-or-unavailable"
  else if (update.changesApps and update.selections > 20) "too-many-apps"
  else if (update.changesApps and not(update.allVisibleAndDistinct)) "app-unavailable"
  else if (update.changesApps and update.anyPinnedSignerChanged) "remove-and-select"
  else if (not(update.historyPurged and update.committed and update.statusReadable)) "refresh-or-unavailable"
  else "saved"
pure def lawGrantAndEnableAreBothRequired(access: MirrorAccess): bool =
  collectionActive(access) implies access.granted and access.enabled and not(access.paused)
pure def lawMirrorStaysInThisProfile(source: NoticeProvenance): bool =
  admitSource(source) implies source.sameUser and not(source.ownPackage) and source.uidMatches and source.selected and source.signatureMatches
pure def lawChangedSignerRequiresSeparateReselection(update: PolicyUpdate): bool =
  update.changesApps and update.anyPinnedSignerChanged implies policyResult(update) != "saved"
pure val enabledAccess: MirrorAccess = { granted: true, enabled: true, paused: false, listener: true, interactive: true, locked: false, historyOptIn: true }
pure val reviewedSource: NoticeProvenance = { sameUser: true, ownPackage: false, uidMatches: true, selected: true, signatureMatches: true }
pure val reviewedUpdate: PolicyUpdate = { foreground: true, mirrorExists: true, revisionMatches: true, changesApps: true, selections: 3, allVisibleAndDistinct: true, anyPinnedSignerChanged: false, historyPurged: true, committed: true, statusReadable: true }
pure val accessValues = Set(enabledAccess, { ...enabledAccess, granted: false }, { ...enabledAccess, enabled: false }, { ...enabledAccess, paused: true }, { ...enabledAccess, listener: false }, { ...enabledAccess, interactive: false }, { ...enabledAccess, locked: true }, { ...enabledAccess, historyOptIn: false })
pure val sourceValues = Set(reviewedSource, { ...reviewedSource, sameUser: false }, { ...reviewedSource, ownPackage: true }, { ...reviewedSource, uidMatches: false }, { ...reviewedSource, selected: false }, { ...reviewedSource, signatureMatches: false })
pure val updateValues = Set(reviewedUpdate, { ...reviewedUpdate, selections: 20 }, { ...reviewedUpdate, selections: 21 }, { ...reviewedUpdate, allVisibleAndDistinct: false }, { ...reviewedUpdate, anyPinnedSignerChanged: true }, { ...reviewedUpdate, revisionMatches: false }, { ...reviewedUpdate, historyPurged: false }, { ...reviewedUpdate, committed: false }, { ...reviewedUpdate, statusReadable: false })
```

## Story: Show only current selected-app notices and keep their handles local

### Preview visibility, Android-device state and renderer visits each control a separate read

The native list adds up to 100 of the newest admitted active notices after Alpha's own rows, with stable order for equal posting times. A failed mirror read leaves own rows available. The external list has no activity-focus precheck. Collection must be active, connected, unlocked and interactive. Otherwise it drops external handles and returns no external rows. The list retains handles only for the admitted keys and keeps a key's random ID and revision while its posting timestamp stays unchanged. Replacements, callback invalidation and retirement produce fresh handles. The Android key remains internal.

For each listed row, a secret notice or disabled preview uses the selected app label as title, the literal `Content hidden` as text, and `redacted: true`. Otherwise a missing text field is empty. The body prefers big text to ordinary text. The source label, title and body are bounded at 120, 200 and 2,000 UTF-16 units without ending on an unmatched high surrogate at the cut. In the ordered active scan, earlier admitted rows count toward the ceiling. Rejected rows consume no slots. The wire row is `id`, `revision`, `source: external`, `appLabel`, `title`, `text`, `redacted`, `at`, `clearable` and `canOpen`. Preview affects text, while opening depends on secrecy and the intent's creator UID. A secret row can still be clearable.

Alpha's installed shade applies results only while the same mounted, visible Home-shade visit is current. It retires a visit on leaving the shade, visibility changes, unmount and, in the browser mock only, device state events. Hiding or a mock device-state change empties retained rows. Closing the shade retires its actions and selection while a cached list may still exist. Action closures recheck the current visit and exact listed id, revision and source. An external row never becomes the selected notification in agent context and cannot start the shade's notification question. The browser preview's separate Focus adapter represents an external event as a held arrival with the app label and the fixed text `Notification received`. The native mirror's previews do not enter agent context through shade selection. Eliza `NotificationMirror.java:354–410`, `NotificationsHostPlugin.java:238–254`. Alpha `prototype/notifications-adapter.ts:10–17,90–143,149–210`, `prototype/context-selection.ts:143–147`.

```quint
pure def activeScanSlot(access: MirrorAccess, source: NoticeProvenance, alreadyAdmitted: int): bool =
  rowsReadable(access) and admitSource(source) and alreadyAdmitted >= 0 and alreadyAdmitted < 100
pure def lawOlderRowsCannotExceedActiveLimit(access: MirrorAccess, source: NoticeProvenance, alreadyAdmitted: int): bool =
  alreadyAdmitted >= 100 implies not(activeScanSlot(access, source, alreadyAdmitted))
pure val alreadyAdmittedValues = Set(0, 1, 99, 100, 101)
type NoticeAppearance = { preview: bool, secret: bool, contentIntent: bool, creatorMatches: bool }
pure def previewVisible(access: MirrorAccess, source: NoticeProvenance, appearance: NoticeAppearance): bool =
  rowsReadable(access) and admitSource(source) and appearance.preview and not(appearance.secret)
pure def postingAppCanOpen(appearance: NoticeAppearance): bool =
  not(appearance.secret) and appearance.contentIntent and appearance.creatorMatches
pure def externalRowMode(access: MirrorAccess, source: NoticeProvenance, appearance: NoticeAppearance): str =
  if (not(rowsReadable(access) and admitSource(source))) "no-row"
  else if (previewVisible(access, source, appearance)) "preview"
  else "redacted"
pure def sourceEligibleForShadeContext(sourceKind: str): bool = sourceKind == "own"
pure def lawExternalShadeContextNeverCarriesRow(sourceKind: str): bool =
  sourceKind == "external" implies not(sourceEligibleForShadeContext(sourceKind))
pure val sourceKindValues = Set("external", "own", "hosted")
type ShadeVisit = { mounted: bool, visible: bool, homeShade: bool, sameVisit: bool, exactRow: bool }
pure def retainShadeResult(visit: ShadeVisit): bool = visit.mounted and visit.visible and visit.homeShade and visit.sameVisit
pure def shadeRowUsable(visit: ShadeVisit): bool = retainShadeResult(visit) and visit.exactRow
pure def lawSecretNeverRevealsOrOpens(access: MirrorAccess, source: NoticeProvenance, appearance: NoticeAppearance): bool =
  appearance.secret implies not(previewVisible(access, source, appearance) or postingAppCanOpen(appearance))
pure def lawRetiredShadeVisitCannotUseRow(visit: ShadeVisit): bool = not(visit.sameVisit) implies not(retainShadeResult(visit) or shadeRowUsable(visit))
pure val showNotice: NoticeAppearance = { preview: true, secret: false, contentIntent: true, creatorMatches: true }
pure val visibleVisit: ShadeVisit = { mounted: true, visible: true, homeShade: true, sameVisit: true, exactRow: true }
pure val appearanceValues = Set(showNotice, { ...showNotice, preview: false }, { ...showNotice, secret: true }, { ...showNotice, contentIntent: false }, { ...showNotice, creatorMatches: false })
pure val visitValues = Set(visibleVisit, { ...visibleVisit, visible: false }, { ...visibleVisit, mounted: false }, { ...visibleVisit, sameVisit: false }, { ...visibleVisit, exactRow: false }, { ...visibleVisit, homeShade: false })
```

### A queued notification callback belongs to its listener and collection generation

The listener serializes post and removal callbacks on one worker with a queue of 64. On enqueue it captures the current generation and removes the notification key's handle before queueing. A null notice does neither. Overflow redacts all handles, advances the generation and clears waiting callbacks. On execution, only the exact listener and captured generation proceed. Either post or removal invalidates its key again before policy admission. A current admitted post can establish a handle only when the device is unlocked and interactive. Policy admission still permits an app-only history event while locked.

A new listener starts a generation and clears handles. A disconnect only invalidates the mirror when it is from the current listener. Screen off and native host pause advance the generation and redact handles. A settings update invalidates and clears history before committing the new policy. Explicit owner Clear does the same generation cut before deleting history. Pause and Resume advance the generation before persisting the pause bit. Pause clears history after that commit and unbinds on success. A failed settings commit retains the old policy after redaction and history deletion, and a failed history deletion cannot be reported as a successful clear. The model uses one admitted source, one pending callback, a live handle marker, and one retained history marker. The callback object's source and listener facts come from the host. Inactive callback processing with revoked Android access attempts to delete history. If that deletion succeeds the retained marker is cleared. A failed history append does not establish a new history row and clears handle entries. Other Android or crypto failures stay at their receipts. Eliza `NotificationMirrorListenerService.java:21–78`, `NotificationMirror.java:244–343,573–589`.

```quint
type MirrorState = { generation: int, queuedAt: int, handleAt: int, historyAt: int, historyKept: bool }
pure val initial: MirrorState = { generation: 0, queuedAt: -1, handleAt: -1, historyAt: -1, historyKept: false }
pure def canQueueNotice(mirrorState: MirrorState): bool = mirrorState.queuedAt < 0
pure def queueNotice(mirrorState: MirrorState): MirrorState = { ...mirrorState, queuedAt: mirrorState.generation, handleAt: -1 }
type CallbackFacts = { listenerMatches: bool, sourceAdmitted: bool, collectionOn: bool, posted: bool, unlocked: bool, historyAllowed: bool, historySaved: bool, lostGrantClearedHistory: bool }
pure def canFinishNotice(mirrorState: MirrorState): bool = mirrorState.queuedAt >= 0
pure def finishNotice(mirrorState: MirrorState, callback: CallbackFacts): MirrorState =
  if (mirrorState.queuedAt != mirrorState.generation or not(callback.listenerMatches)) { ...mirrorState, queuedAt: -1 }
  else if (not(callback.collectionOn)) { ...mirrorState, queuedAt: -1, handleAt: -1, historyAt: if (callback.lostGrantClearedHistory) -1 else mirrorState.historyAt, historyKept: mirrorState.historyKept and not(callback.lostGrantClearedHistory) }
  else if (not(callback.sourceAdmitted)) { ...mirrorState, queuedAt: -1, handleAt: -1 }
  else {
    ...mirrorState, queuedAt: -1,
    handleAt: if (callback.posted and callback.unlocked and (not(callback.historyAllowed) or callback.historySaved)) mirrorState.generation else -1,
    historyAt: if (callback.historyAllowed and callback.historySaved) mirrorState.generation else mirrorState.historyAt,
    historyKept: mirrorState.historyKept or (callback.historyAllowed and callback.historySaved)
  }
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
pure val admittedCallback: CallbackFacts = { listenerMatches: true, sourceAdmitted: true, collectionOn: true, posted: true, unlocked: true, historyAllowed: true, historySaved: true, lostGrantClearedHistory: false }
pure val callbackValues = Set(admittedCallback, { ...admittedCallback, posted: false }, { ...admittedCallback, unlocked: false }, { ...admittedCallback, historySaved: false }, { ...admittedCallback, listenerMatches: false }, { ...admittedCallback, sourceAdmitted: false }, { ...admittedCallback, collectionOn: false, lostGrantClearedHistory: true })
pure val weight_queueNotice = 7
pure val weight_finishNotice = 7
```

### History keeps bounded encrypted metadata and opens only under current authority

History is separate consent and can be recorded for admitted post or remove callbacks. It stores a random ID, package, pinned signature, app label, recorded time, posting time and state. It contains no notification title, body, platform key or intent. The bridge returns only ID, app label, recorded time and state. A retained recording is no older than strictly less than 24 hours and no later than the clock now. Pruning checks active collection and separate history consent, keeps only still-selected matching signatures, and limits the file to 100 entries. The append path prepends its newly recorded item to the unexpired earlier rows and keeps the first 100. The cursor below counts only rows already retained by the corresponding operation. The foreground bridge gate requires a focused, nonfinishing activity and an unlocked device for explicit history reads, clear, policy mutations and external actions. The native history read also requires an interactive device and prunes before deciding whether to expose rows. The status call can run without that foreground check and reports unavailable history on prune failure.

The history file uses Android `AtomicFile` in the no-backup directory, with Android Keystore AES-GCM, a 12-byte IV prefix and the alias as additional authenticated data. Read accepts 29 through 131,072 bytes and can recover its AtomicFile backup. Authentication, JSON decoding and write errors are effect results. A successful clear verifies the absence of the base, backup and pending file. `MirrorConsumerTest.java` exercises real Android history redaction, backup restoration and revocation when run on its required disposable Android user. Eliza `NotificationMirror.java:166–185,449–589` and `NotificationsHostPlugin.java:101–104,219–236`.

```quint
pure def historyRange(recordedAt: int, now: int): bool = recordedAt <= now and recordedAt > now - 86400000
type HistoryFacts = { foreground: bool, readable: bool, samePackage: bool, sameSignature: bool, signatureCurrent: bool, recordedAt: int, now: int, envelopeBytes: int }
pure def historySlot(retainedBefore: int): bool = retainedBefore >= 0 and retainedBefore < 100
pure val retainedBeforeValues = Set(0, 99, 100, 101)
pure def historyEnvelopeSize(history: HistoryFacts): bool = history.envelopeBytes >= 29 and history.envelopeBytes <= 131072
pure def historyRowVisible(access: MirrorAccess, history: HistoryFacts): bool =
  history.foreground and history.readable and keepsLocalHistory(access) and access.interactive and not(access.locked) and
  history.samePackage and history.sameSignature and history.signatureCurrent and historyRange(history.recordedAt, history.now)
pure def lawHistoryNeverShowsOtherSigner(access: MirrorAccess, history: HistoryFacts): bool =
  historyRowVisible(access, history) implies history.samePackage and history.sameSignature and history.signatureCurrent
pure def lawHistoryBoundaryIsExclusive(recordedAt: int, now: int): bool =
  recordedAt <= now - 86400000 or recordedAt > now implies not(historyRange(recordedAt, now))
pure val recentHistory: HistoryFacts = { foreground: true, readable: true, samePackage: true, sameSignature: true, signatureCurrent: true, recordedAt: 1, now: 86400000, envelopeBytes: 29 }
pure val historyValues = Set(recentHistory, { ...recentHistory, recordedAt: 0 }, { ...recentHistory, recordedAt: 86400001 }, { ...recentHistory, signatureCurrent: false }, { ...recentHistory, envelopeBytes: 28 }, { ...recentHistory, envelopeBytes: 131073 })
pure val recordedAtValues = Set(0, 1, 86400000, 86400001)
pure val nowValues = Set(0, 86400000)
```

## Story: Request an action on the exact current notice

### Android acceptance of a request does not establish the resulting screen or removal

The bridge dispatches external actions only for the exact `source: external` branch. It first checks foreground. Inside the mirror lock the operation rechecks access, connection, unlocked and interactive device, exact opaque ID and revision, then rereads the original Android notification key. The notification must still have the original post timestamp and pass the current source checks. Opening requires a nonsecret notice and content intent created by the posting UID. A successful `send()` may be followed by cancellation for `FLAG_AUTO_CANCEL`. Manual dismiss requires Android's current clearable flag and asks the listener to cancel that key.

An external open resolves void if the calls return normally. External dismiss resolves `{status:"requested"}`. Bulk clear returns one `{id,status}` per parsed row, with `requested` for accepted cancellation requests and `unavailable` for failures from that row's action. Malformed outer input or a malformed row identity can reject the outer call after earlier actions. The returned statuses establish neither a new screen nor observed Android removal. A failed auto-cancel after a successful send returns rejection with launch effect still possible. The listener action does not consume a row handle itself. The next callback, policy boundary or new active read invalidates an obsolete handle. The state here models the receipt semantics as a pure projection of current admission and actual port returns. There is no assistant-originated external send. Eliza `NotificationMirror.java:413–447` and `NotificationsHostPlugin.java:255–285`.

```quint
type ExternalAction = { foreground: bool, exactHandle: bool, exactPostTime: bool, androidRowFound: bool, clearable: bool, open: bool, autoCancel: bool, sendReturned: bool, cancelReturned: bool }
pure def actionAdmitted(access: MirrorAccess, source: NoticeProvenance, appearance: NoticeAppearance, request: ExternalAction): bool =
  request.foreground and rowsReadable(access) and request.exactHandle and request.exactPostTime and request.androidRowFound and admitSource(source) and
  (if (request.open) postingAppCanOpen(appearance) else request.clearable)
pure def externalActionReceipt(access: MirrorAccess, source: NoticeProvenance, appearance: NoticeAppearance, request: ExternalAction): str =
  if (not(actionAdmitted(access, source, appearance, request))) "refused"
  else if (request.open) {
    if (not(request.sendReturned)) "effect-unconfirmed"
    else if (request.autoCancel and not(request.cancelReturned)) "effect-unconfirmed"
    else "resolved-void"
  } else if (request.cancelReturned) "requested"
  else "effect-unconfirmed"
pure def clearRowReceipt(actionReceipt: str): str = if (actionReceipt == "requested") "requested" else "unavailable"
pure def lawActionNeedsExactLiveRow(access: MirrorAccess, source: NoticeProvenance, appearance: NoticeAppearance, request: ExternalAction): bool =
  externalActionReceipt(access, source, appearance, request) != "refused" implies request.exactHandle and request.androidRowFound and request.exactPostTime and rowsReadable(access) and admitSource(source)
pure def lawOpenReceiptRequiresIntentReturn(access: MirrorAccess, source: NoticeProvenance, appearance: NoticeAppearance, request: ExternalAction): bool =
  externalActionReceipt(access, source, appearance, request) == "resolved-void" implies request.open and postingAppCanOpen(appearance) and request.sendReturned and (not(request.autoCancel) or request.cancelReturned)
pure def lawDismissReceiptRequiresCancelReturn(access: MirrorAccess, source: NoticeProvenance, appearance: NoticeAppearance, request: ExternalAction): bool =
  externalActionReceipt(access, source, appearance, request) == "requested" implies not(request.open) and request.clearable and request.cancelReturned
pure val currentAction: ExternalAction = { foreground: true, exactHandle: true, exactPostTime: true, androidRowFound: true, clearable: true, open: true, autoCancel: false, sendReturned: true, cancelReturned: true }
pure val requestValues = Set(currentAction, { ...currentAction, open: false }, { ...currentAction, exactHandle: false }, { ...currentAction, exactPostTime: false }, { ...currentAction, foreground: false }, { ...currentAction, autoCancel: true, cancelReturned: false }, { ...currentAction, sendReturned: false }, { ...currentAction, open: false, clearable: false })
pure val actionReceiptValues = Set("requested", "refused", "effect-unconfirmed", "resolved-void")
```
