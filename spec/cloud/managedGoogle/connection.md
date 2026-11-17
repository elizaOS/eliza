# Managed Google connection

The cloud holds an organization's Google connection on the owner's behalf
and lets the owner's agent use it through a managed host: list and read
mail, read calendars, and send a reviewed email. The host selects the
scoped provider account by the owner's binding and Google grants, and every
read, preparation and send is bound to the exact environment, user,
organization, session and credential that admitted it. Native credential
ownership is [native enrollment](../../auth/native/enrollment.md), mailbox
paging is [the mailbox reads](../../inbox/reads.md), and the mail wire
is [Gmail](./gmail.md).

## Story: Send a reviewed email once and recover its receipt

> As an owner, I want an email my agent prepared and I reviewed sent once,
> to exactly the reviewed recipients and content, and its outcome known even
> if the connection drops.

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

## Story: Read through the grant I chose when the task began

> As a person whose agent reads my mail, each result comes from the account
> and grant I selected when the task began, or the task fails; it never
> silently switches to another one.

### Agent reads stay on the captured grant and apply their search bounds

A Google read is bound to the host epoch, actor, Google generation and
grant captured when the task began, and never falls back to a different
grant. Only a timeout, a rate limit or a server error permits a bounded
retry; a refusal and an oversize response are explicit failures. An agent search
asks for 1 to 51 results, one more than the largest page so it can tell that
more exist, and its composed query fits 2,048 code units. A later page is
read only under the history ID of the first: a missing first history ID or a
changed one refuses the read, unlike [the mailbox
reads](../../inbox/reads.md), which mark such a page shifted. Later pages add
only unseen message IDs. Calendar reads are [managed calendar
reads](./calendarRead.md).

```quint
type HostAuthority = { hostEpoch: int, googleEpoch: int, actor: str, grant: str }
pure def sameGoogleGrant(captured: HostAuthority, observed: HostAuthority): bool =
  captured.hostEpoch == observed.hostEpoch and captured.actor != "" and captured.actor == observed.actor and
  captured.googleEpoch == observed.googleEpoch and captured.grant != "" and captured.grant == observed.grant
pure val capturedValues = Set({ hostEpoch: 1, googleEpoch: 1, actor: "owner", grant: "grant" })
pure val observedValues = Set({ hostEpoch: 1, googleEpoch: 1, actor: "owner", grant: "grant" }, { hostEpoch: 1, googleEpoch: 2, actor: "owner", grant: "replacement" }, { hostEpoch: 2, googleEpoch: 1, actor: "another", grant: "grant" })
pure def lawGoogleReadCannotFollowGrantChange(captured: HostAuthority, observed: HostAuthority): bool = captured.grant != observed.grant implies not(sameGoogleGrant(captured, observed))
pure val agentPageLimit = 50
pure def validGmailRead(limit: int, queryLength: int): bool = limit >= 1 and limit <= agentPageLimit + 1 and queryLength >= 0 and queryLength <= 2048
pure def validLaterPage(historyId: str, laterHistoryId: str): bool = historyId != "" and historyId == laterHistoryId
pure val limitValues = Set(0, 1, 50, 51, 52)
pure val queryLengthValues = Set(0, 2048, 2049)
pure val historyIdValues = Set("", "7", "8")
pure val laterHistoryIdValues = Set("", "7", "8")
pure def lawAgentCanProbeForMore(queryLength: int): bool = (queryLength >= 0 and queryLength <= 2048) implies validGmailRead(agentPageLimit + 1, queryLength)
pure def lawOversizeSearchIsRefused(limit: int, queryLength: int): bool = (limit > agentPageLimit + 1 or queryLength > 2048) implies not(validGmailRead(limit, queryLength))
pure def lawLaterPageCannotCrossHistory(historyId: str, laterHistoryId: str): bool = (historyId == "" or historyId != laterHistoryId) implies not(validLaterPage(historyId, laterHistoryId))
```

## Story: Read the complete body of my selected email

> As the owner, I want the agent to receive the selected email's complete
> body or an explicit size refusal.

### The message body and the complete reply have independent limits

A message read is scoped to the selected account and message, and the host
finishes the current owner and grant recheck before it publishes the
result. The body may hold at most 32,000 UTF-16 code units, and the whole
serialized reply, metadata included, at most 262,144 UTF-8 bytes. A body
within its own limit may still make the reply too large. The message is
delivered whole only when both limits hold; past either one the read is
refused at that limit rather than handed on as a prefix. The
[Gmail wire](./gmail.md) keeps its own plain-body and HTML presentation
rules.

```quint
type GmailBodyDelivery = FullBody | HardLimitRefusal
pure def bodyUnitsFit(units: int): bool = units >= 0 and units <= 32000
pure def replyBytesFit(replyBytes: int): bool = replyBytes >= 0 and replyBytes <= 262144
pure def bodyDelivery(units: int, replyBytes: int): GmailBodyDelivery =
  if (bodyUnitsFit(units) and replyBytesFit(replyBytes)) FullBody else HardLimitRefusal
pure val unitsValues = Set(0, 1, 31999, 32000, 32001, 262144)
pure val replyBytesValues = Set(0, 262143, 262144, 262145)
pure def lawReadBodyOverLimitIsExplicit(units: int, replyBytes: int): bool = units > 32000 implies bodyDelivery(units, replyBytes) == HardLimitRefusal
pure def lawWithinBudgetBodyRemainsComplete(units: int, replyBytes: int): bool =
  bodyUnitsFit(units) and replyBytesFit(replyBytes) implies bodyDelivery(units, replyBytes) == FullBody
pure def lawOversizeReplyIsRefused(units: int, replyBytes: int): bool = replyBytes > 262144 implies bodyDelivery(units, replyBytes) == HardLimitRefusal
```

### The agent receives an explicit size refusal when complete content cannot be returned

A refusal at either limit reaches the agent as an explicit size refusal
carrying no body, never as the generic host-unavailable error and never
as part of a body. [Complete model context](../../core/context.md) owns
keeping complete source evidence once it is admitted.

```quint
type GmailAgentMessage = CompleteMessage | HostUnavailable | ExplicitSizeRefusal
pure def agentMessage(units: int, replyBytes: int): GmailAgentMessage =
  if (bodyDelivery(units, replyBytes) == FullBody) CompleteMessage else ExplicitSizeRefusal
pure def lawAgentRefusesAnyMessageThatExceedsABound(units: int, replyBytes: int): bool =
  units > 32000 or replyBytes > 262144 implies agentMessage(units, replyBytes) == ExplicitSizeRefusal
pure def lawSizeRefusalIsNeverHostUnavailable(units: int, replyBytes: int): bool = agentMessage(units, replyBytes) != HostUnavailable
```

## Story: Revoke a Google connection without waiting on calendar cleanup

> As an owner, I want disconnecting Google to revoke the cloud's access at
> once, whatever state an optional calendar cleanup is in.

### Disconnect revokes in the cloud without waiting for calendar cleanup

Disconnect starts the cloud revocation on its own, without waiting for the
optional calendar control cleanup. A bound calendar pause uses an exact
destination, selection, revision and bounded acknowledgment; its unknown
result neither claims that the provider drained nor blocks the privacy
revocation. No result from a stale cloud authority is reported.

```quint
type RevokeEvidence = { cloudCurrent: bool, cleanupCurrent: bool, exactDestination: bool, exactRevision: bool, exactSelection: bool, pauseAck: bool, revokeAck: bool }
pure val revokeValues = Set({ cloudCurrent: true, cleanupCurrent: false, exactDestination: false, exactRevision: false, exactSelection: false, pauseAck: false, revokeAck: true }, { cloudCurrent: true, cleanupCurrent: true, exactDestination: true, exactRevision: true, exactSelection: true, pauseAck: true, revokeAck: false }, { cloudCurrent: false, cleanupCurrent: true, exactDestination: true, exactRevision: true, exactSelection: true, pauseAck: true, revokeAck: true })
pure def reportsRevoked(revoke: RevokeEvidence): bool = revoke.cloudCurrent and revoke.revokeAck
pure def confirmsCalendarPause(revoke: RevokeEvidence): bool = revoke.cloudCurrent and revoke.cleanupCurrent and revoke.exactDestination and revoke.exactRevision and revoke.exactSelection and revoke.pauseAck
pure def lawStaleCalendarDoesNotVetoRevocation(revoke: RevokeEvidence): bool = revoke.cloudCurrent and revoke.revokeAck implies reportsRevoked(revoke)
pure def lawStaleAuthorityReportsNothing(revoke: RevokeEvidence): bool = not(revoke.cloudCurrent) implies not(reportsRevoked(revoke) or confirmsCalendarPause(revoke))
```
