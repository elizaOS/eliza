# Alpha managed Google operations

`scripts/native-google-product-host.ts` binds Alpha's production Cloud
origin and an owner settings reader to the pinned
`packages/app/src/runtime/managed-google-agent` host. The host uses
`NativeGoogleBinding` and Google grants to select scoped provider accounts.
`google-connection-ui.tsx`, `google-workspace-return.ts`, and
`google-accounts.ts` bind consent, account readback and disconnect to
exact environment, user, organization, session and credential identities.
[Cloud credential ownership](../cloudEnrollment.md) and
[Inbox pagination](./inbox.md) own separate boundaries.

## Story: Send a reviewed email once and recover its receipt

### Sending requires the current account and exact prepared review identity

A Gmail list or new send needs a unique eligible account; a scoped
message or receipt can name a specific eligible grant. A connection can
stay valid while its change switch is off. The switched-off state blocks
mailbox mutations and send preparation/dispatch before Cloud requests.
Send preparation requires both the current grant and a verified provider
review. The request UUID, provider-scoped ID, exact recipient arrays,
subject, body and review digest are retained. Receipt lookup checks the
scope and operation kind. A completed prior send returns its receipt.
Any other prior state except prepared is refused for dispatch. If an
accepted mutation loses its trailing access check, its verified provider
receipt still describes what happened. A read or preparation result
requires successful current authority and grant readback. Transport loss
remains unknown and only exact lookup can establish settlement.

```quint
type SendBinding = { owner: int, credential: int, grantId: str, requestId: str, digest: str, content: str }
type GmailPhase = Empty | Prepared | Dispatching | Unknown | Sent | TerminalFailure
pure val preparedPhase: GmailPhase = Prepared
pure val dispatchedPhase: GmailPhase = Dispatching
pure val sentPhase: GmailPhase = Sent
pure val failedPhase: GmailPhase = TerminalFailure
pure val unknownPhase: GmailPhase = Unknown
type GmailReceipt = Delivered | Rejected | MissingReceipt
pure val noBinding: SendBinding = { owner: 0, credential: 0, grantId: "", requestId: "", digest: "", content: "" }
pure val bindingValues = Set(
  { owner: 1, credential: 1, grantId: "a", requestId: "send", digest: "review", content: "exact" },
  { owner: 1, credential: 1, grantId: "a", requestId: "send", digest: "changed", content: "different" },
  { owner: 1, credential: 2, grantId: "a", requestId: "send", digest: "review", content: "exact" },
  { owner: 2, credential: 1, grantId: "b", requestId: "send", digest: "review", content: "exact" }
)
type GmailSend = { binding: SendBinding, phase: GmailPhase, dispatchCount: int, changesOn: bool, currentOwner: int, currentCredential: int, recovered: bool }
pure val initial: GmailSend = { binding: noBinding, phase: Empty, dispatchCount: 0, changesOn: false, currentOwner: 0, currentCredential: 0, recovered: false }
pure def validBinding(binding: SendBinding): bool = binding.owner > 0 and binding.credential > 0 and binding.grantId != "" and binding.requestId != "" and binding.digest != ""
pure def exactCurrent(s: GmailSend, binding: SendBinding): bool = binding.owner == s.currentOwner and binding.credential == s.currentCredential
pure def connect(s: GmailSend, ownerId: int, credential: int): GmailSend = { ...s, currentOwner: ownerId, currentCredential: credential, changesOn: false }
pure def canSetChanges(s: GmailSend): bool = s.currentOwner > 0 and s.currentCredential > 0
pure def setChanges(s: GmailSend, on: bool): GmailSend = { ...s, changesOn: on }
pure def canPrepare(s: GmailSend, binding: SendBinding, hasSendGrant: bool, soleAccount: bool, providerExact: bool): bool =
  s.phase == Empty and s.changesOn and hasSendGrant and soleAccount and providerExact and validBinding(binding) and exactCurrent(s, binding)
pure def prepare(s: GmailSend, binding: SendBinding, hasSendGrant: bool, soleAccount: bool, providerExact: bool): GmailSend =
  { ...s, phase: preparedPhase, binding: binding }
pure def canDispatch(s: GmailSend, binding: SendBinding, scopedGrant: bool): bool =
  s.phase == Prepared and s.changesOn and scopedGrant and binding == s.binding and exactCurrent(s, binding)
pure def dispatch(s: GmailSend, binding: SendBinding, scopedGrant: bool): GmailSend =
  { ...s, phase: dispatchedPhase, dispatchCount: s.dispatchCount + 1 }
pure def canObserveDispatch(s: GmailSend, binding: SendBinding): bool = s.phase == Dispatching and binding == s.binding
pure def observeDispatch(s: GmailSend, binding: SendBinding, receipt: GmailReceipt): GmailSend =
  { ...s, phase: if (receipt == Delivered) sentPhase else if (receipt == Rejected) failedPhase else unknownPhase }
pure def canReadReceipt(s: GmailSend, binding: SendBinding, scopedGrant: bool): bool =
  (s.phase == Sent or s.phase == Unknown or s.phase == TerminalFailure) and scopedGrant and binding == s.binding and exactCurrent(s, binding)
pure def readReceipt(s: GmailSend, binding: SendBinding, scopedGrant: bool, receipt: GmailReceipt): GmailSend =
  if (receipt == Delivered) { ...s, phase: sentPhase, recovered: true }
  else if (receipt == Rejected and s.phase == Unknown) { ...s, phase: failedPhase } else s
pure val ownerIdValues = Set(1, 2)
pure val credentialValues = Set(1, 2)
pure def alwaysOperationRetainsBinding(s: GmailSend): bool = s.phase == Empty or validBinding(s.binding)
pure def alwaysOneDispatch(s: GmailSend): bool =
  s.dispatchCount == (if (s.phase == Empty or s.phase == Prepared) 0 else 1)
pure def alwaysRecoversOnlySent(s: GmailSend): bool = s.recovered implies s.phase == Sent
pure def stepDispatchRequiresPreparedScope(before: GmailSend, via: str, after: GmailSend): bool =
  after.dispatchCount > before.dispatchCount implies via == "dispatch" and before.phase == Prepared and before.changesOn and exactCurrent(before, before.binding)
pure def stepUnconfirmedCannotRedispatch(before: GmailSend, after: GmailSend): bool =
  before.phase == Unknown implies after.dispatchCount == before.dispatchCount
pure def sometimesDispatches(s: GmailSend): bool = s.phase == Dispatching
pure def sometimesRecoversUnknown(s: GmailSend): bool = s.recovered
pure def sometimesUnconfirmed(s: GmailSend): bool = s.phase == Unknown
```

### Agent reads retain scoped authority and apply an explicit size policy

Gmail search accepts a limit in `1..51`, with 51 for the overflow probe.
The complete composed query must fit 2048 code units. If a second page
is needed, a missing initial history ID or a changed history ID refuses
the read. Paged reads remove duplicated provider IDs. Calendar sources
can return an empty contribution when the optional credential is absent;
connected-owner and provider errors remain explicit. The follow-up feed
serves only the exact grant and calendar, with current grant recheck,
and rejects a serialized result over 256 KiB.

Alpha's pinned Gmail host explicitly reports `truncated: true` for bodies
over 32,000 UTF-16 code units and drops an incomplete high surrogate at
the cut. The replacement's core rules require complete model-facing
context and explicit failure at a hard limit. The two rules below preserve
this observed old compatibility case and state the intended replacement
behavior. User-visible strings and lexical/UTF-16 parsing need later
conformance at the broker boundary.

```quint
type GmailBodyDelivery = FullBody | LegacyMarkedPartial | HardLimitRefusal
pure def pinnedBodyDelivery(units: int): GmailBodyDelivery = if (units > 32000) LegacyMarkedPartial else FullBody
pure def replacementBodyDelivery(units: int): GmailBodyDelivery = if (units > 32000) HardLimitRefusal else FullBody
pure def lawReadBodyOverLimitIsExplicit(units: int): bool = units > 32000 implies pinnedBodyDelivery(units) == LegacyMarkedPartial and replacementBodyDelivery(units) == HardLimitRefusal
pure def lawWithinBudgetBodyRemainsComplete(units: int): bool = units >= 0 and units <= 32000 implies replacementBodyDelivery(units) == FullBody
pure def validGmailRead(limit: int, queryLength: int): bool = limit >= 1 and limit <= 51 and queryLength >= 0 and queryLength <= 2048
pure def validLaterPage(history: str, later: str): bool = history != "" and history == later
pure def lawLaterPageCannotCrossHistory(history: str, later: str): bool = validLaterPage(history, later) implies history != "" and history == later
pure def admitCalendarResult(bytes: int, exactScope: bool, trailingGrant: bool): bool = bytes >= 0 and bytes <= 262144 and exactScope and trailingGrant
pure def lawCalendarResultRequiresCurrentGrant(bytes: int, exactScope: bool, trailingGrant: bool): bool = admitCalendarResult(bytes, exactScope, trailingGrant) implies exactScope and trailingGrant
```

## Story: Finish or revoke a Google connection without adopting another owner's results

### A browser return only schedules an authenticated connection readback

A fallback browser authorization captures the complete current binding
and arms before leaving. Foreground or retained native resume events
before actual backgrounding cannot count. A foreground return after
background consumes the attempt before scheduling the read. Signed native
return must belong to the captured environment and credential; the
canonical account list must still show the exact connection when one was
named. Disconnect starts independent Cloud revocation without waiting
for optional Calendar control cleanup. A bound pause uses an exact
source, selection, revision and bounded acknowledgment. Its unknown
result does not claim underlying provider drain or block privacy
revocation. No result from a stale Cloud authority updates the UI.

```quint
type ReturnEvidence = { currentOwner: bool, armed: bool, backgroundSeen: bool, foreground: bool, signedResult: bool, exactReturnBinding: bool, exactGrantVisible: bool }
pure val returnedValues = Set({ currentOwner: true, armed: true, backgroundSeen: true, foreground: true, signedResult: false, exactReturnBinding: true, exactGrantVisible: false }, { currentOwner: true, armed: false, backgroundSeen: false, foreground: true, signedResult: true, exactReturnBinding: true, exactGrantVisible: true }, { currentOwner: false, armed: true, backgroundSeen: true, foreground: true, signedResult: true, exactReturnBinding: true, exactGrantVisible: true })
pure def shouldReloadAccounts(returned: ReturnEvidence): bool = returned.currentOwner and ((returned.armed and returned.backgroundSeen and returned.foreground) or (returned.signedResult and returned.exactReturnBinding))
pure def mayReportConnected(returned: ReturnEvidence): bool = shouldReloadAccounts(returned) and returned.exactGrantVisible
pure def lawBrowserReturnDoesNotConfirmGrant(returned: ReturnEvidence): bool = mayReportConnected(returned) implies returned.currentOwner and returned.exactGrantVisible
pure def lawRetainedResumeBeforeBackgroundCannotReload(returned: ReturnEvidence): bool = not(returned.signedResult) and not(returned.backgroundSeen) implies not(shouldReloadAccounts(returned))
type RevokeEvidence = { cloudCurrent: bool, cleanupCurrent: bool, exactDestination: bool, exactRevision: bool, exactSelection: bool, pauseAck: bool, revokeAck: bool }
pure val revokeValues = Set({ cloudCurrent: true, cleanupCurrent: false, exactDestination: false, exactRevision: false, exactSelection: false, pauseAck: false, revokeAck: true }, { cloudCurrent: true, cleanupCurrent: true, exactDestination: true, exactRevision: true, exactSelection: true, pauseAck: true, revokeAck: false })
pure def reportsRevoked(revoke: RevokeEvidence): bool = revoke.cloudCurrent and revoke.revokeAck
pure def confirmsCalendarPause(revoke: RevokeEvidence): bool = revoke.cloudCurrent and revoke.cleanupCurrent and revoke.exactDestination and revoke.exactRevision and revoke.exactSelection and revoke.pauseAck
pure def lawStaleCalendarDoesNotVetoRevocation(revoke: RevokeEvidence): bool = revoke.cloudCurrent and revoke.revokeAck implies reportsRevoked(revoke)
```
