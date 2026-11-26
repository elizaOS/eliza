# Reviewed Gmail changes

Every change the cloud makes to the owner's mailbox, reviewed first and sent
to Google at most once on a receipt of [the dispatch ledger](../../shared/dispatchOnce.md)
(develop `agent-google-connector/inbox-{receipts,provider,operation-routes}.ts`).
Routes under `/api/v1/eliza/google/gmail/inbox-v1/` (device key or session,
grant chosen by [the connection](./connection.md)): `POST operations
{grantId, requestId, proposal}`, `POST operations/:requestId/dispatch
{grantId, reviewDigest, proposal}`, `GET operations/:requestId?grantId`; ids
are UUIDs. There is no other Gmail write route.

One instance is one `mail_operations` row, keyed by organization, user,
grant and request id (provider key `grantId:requestId`). The shell reads
Google for the review, computes its digest (SHA-256 hex of the canonical
review, kind included), builds the MIME message, calls Google with a 30 s
deadline and renders the wire.

## Story: Change or send from my mailbox once, as I reviewed it

> As an owner, I want each mail change my assistant proposes made only as I
> reviewed it, to the message or draft as I saw it, at most once, with its
> outcome readable even after a lost connection, so that nothing is sent
> twice or changed behind my back.

### A proposal passes review only whole: its shape, then the mail cap, then every message or draft it names at the revision read

A label change (`archive`, `unarchive`, `trash`, `untrash`, `mark-read`,
`mark-unread`, `star`, `unstar`) names `{messageId, expectedHistoryId}`;
`draft-delete` names `{draftId, expectedDigest}` with `confirmPermanentDelete:
true`. `send`, `draft-create` and `draft-replace` carry `mode ∈ {compose,
reply, reply-all, forward}`; `to`, `cc`, `bcc` (bare addresses, at most 50 in
all, a send at least one); `subject`; `bodyText`; `replyMessageId` exactly in
the reply modes (subject `Re:` the parent's, parent with safe `Message-ID` and
`References`); at most 10 uniquely named files, `attachments` of `mailRead`'s
types whose bytes match the type, and `forwardAttachments {messageId,
historyId, partIds}` only in a forward; `draft-replace` also `{draftId,
expectedDigest}` with `acceptNonAtomicReplacement: true`. A shape fault is
`400 invalid_request`, files over the 8 MiB mail cap `413`, a message, draft
or part that is gone `404 not_found`, one at another history id or digest
`409 stale_revision`.

```quint
import types.* from "../../shared/types"
import connection as C from "./connection"
import mailRead.* from "./mailRead"
import dispatchOnce as D from "../../shared/dispatchOnce"
import sessions as S from "../../../core/sessions"
type ComposeMode = Compose | Reply | ReplyAll | Forward
type TargetFit = TargetCurrent | TargetChanged | TargetMissing
type ReplyFit = NotReplying | ReplyHeadersSafe | ReplyHeadersUnsafe | ReplySubjectMismatch
type OutgoingFiles = { count: int, bytes: int, wellFormed: bool, forwarded: bool }
type Proposal =
  LabelChangeProposal({ kind: MailOperationKind, target: TargetFit })
  | DraftDeleteProposal({ target: TargetFit, confirmed: bool })
  | MessageProposal({ kind: MailOperationKind, mode: ComposeMode, recipients: int, reply: ReplyFit, target: TargetFit, acknowledged: bool, files: OutgoingFiles })
type ReviewOutcome = ReviewPasses | ReviewRefused({ refusal: Refusal })
pure val maxRecipients: int = 50
pure val maxAttachments: int = 10
pure def isLabelKind(kind: MailOperationKind): bool = kind != SendKind and not(isDraftKind(kind))
pure def kindOfProposal(proposal: Proposal): MailOperationKind = match proposal { | LabelChangeProposal(x) => x.kind | DraftDeleteProposal(x) => DraftDeleteKind | MessageProposal(x) => x.kind }
pure def targetOf(proposal: Proposal): TargetFit = match proposal { | LabelChangeProposal(x) => x.target | DraftDeleteProposal(x) => x.target | MessageProposal(x) => x.target }
pure def attachedBytes(proposal: Proposal): int = match proposal { | MessageProposal(x) => x.files.bytes | _ => 0 }
pure def shapeFits(proposal: Proposal): bool = match proposal {
  | LabelChangeProposal(x) => isLabelKind(x.kind)
  | DraftDeleteProposal(x) => x.confirmed
  | MessageProposal(x) =>
      (x.kind == SendKind or x.kind == DraftCreateKind or x.kind == DraftReplaceKind)
      and x.recipients >= (if (x.kind == SendKind) 1 else 0) and x.recipients <= maxRecipients
      and ((x.mode == Reply or x.mode == ReplyAll) iff x.reply != NotReplying) and x.reply != ReplyHeadersUnsafe and x.reply != ReplySubjectMismatch
      and (x.acknowledged iff x.kind == DraftReplaceKind)
      and x.files.count >= 0 and x.files.count <= maxAttachments and x.files.wellFormed and (x.files.forwarded implies x.mode == Forward)
}
pure def reviewOf(proposal: Proposal): ReviewOutcome = {
  val target = targetOf(proposal)
  if (not(shapeFits(proposal))) ReviewRefused({ refusal: refuse(InvalidRequest) })
  else if (not(withinMailCap(attachedBytes(proposal)))) ReviewRefused({ refusal: refuse(ContentTooLarge) })
  else if (target == TargetMissing) ReviewRefused({ refusal: refuse(NotFound) })
  else if (target == TargetChanged) ReviewRefused({ refusal: refuse(StaleRevision) })
  else ReviewPasses
}
pure val proposalValues: Set[Proposal] = {
  val files: OutgoingFiles = { count: 1, bytes: 1000, wellFormed: true, forwarded: false }
  val compose = { kind: SendKind, mode: Compose, recipients: 1, reply: NotReplying, target: TargetCurrent, acknowledged: false, files: files }
  Set(LabelChangeProposal({ kind: TrashKind, target: TargetCurrent }), LabelChangeProposal({ kind: MarkReadKind, target: TargetCurrent }),
    LabelChangeProposal({ kind: StarKind, target: TargetChanged }), LabelChangeProposal({ kind: SendKind, target: TargetCurrent }),
    DraftDeleteProposal({ target: TargetCurrent, confirmed: true }), DraftDeleteProposal({ target: TargetMissing, confirmed: true }),
    MessageProposal(compose), MessageProposal({ ...compose, mode: Reply, reply: ReplyHeadersSafe }), MessageProposal({ ...compose, mode: Reply, reply: ReplySubjectMismatch }),
    MessageProposal({ ...compose, mode: Forward, files: { ...files, forwarded: true } }), MessageProposal({ ...compose, recipients: 0 }),
    MessageProposal({ ...compose, files: { ...files, bytes: 8388609 } }), MessageProposal({ ...compose, kind: DraftCreateKind, recipients: 0 }),
    MessageProposal({ ...compose, kind: DraftReplaceKind, acknowledged: true }), MessageProposal({ ...compose, kind: DraftReplaceKind, target: TargetChanged, acknowledged: true }))
}
pure def lawAPassingReviewSawEverythingAtItsRevisionAndARefusalIsFinal(proposal: Proposal): bool = {
  val review = reviewOf(proposal)
  match review {
    | ReviewPasses => targetOf(proposal) == TargetCurrent and withinMailCap(attachedBytes(proposal))
    | ReviewRefused(x) => wellFormed(x.refusal) and not(retryableOf(x.refusal))
  }
}
```

### A change needs a usable connection holding the capability its kind needs, and a reply or forwarded part also message reads

`send` needs `google.gmail.send`, drafts `google.gmail.drafts`, label kinds
`google.gmail.manage`; a reply or forwarded part also needs message reads. A
refusal is the connection's use refusal, after its refresh.

```quint
type MailAuthority = { status: C::ConnectionStatus, access: C::AccessState, scopes: List[C::GoogleScope] }
pure def readsAMessage(proposal: Proposal): bool = match proposal { | MessageProposal(x) => x.mode == Reply or x.mode == ReplyAll or x.files.forwarded | _ => false }
pure def holdsFor(proposal: Proposal, scopes: List[C::GoogleScope]): bool =
  C::capabilitiesOf(scopes).includes(kindNeeds(kindOfProposal(proposal))) and (not(readsAMessage(proposal)) or surfaceHeld(MessageSurface, scopes))
pure def authorityAllows(proposal: Proposal, authority: MailAuthority): bool = C::useAllowed(authority.status, authority.access, holdsFor(proposal, authority.scopes))
pure def authorityRefusal(proposal: Proposal, authority: MailAuthority): Refusal = C::useRefusal(authority.status, authority.access, holdsFor(proposal, authority.scopes))
pure val authorityValues: Set[MailAuthority] = {
  val ok: MailAuthority = { status: C::Active, access: C::AccessLive, scopes: List(C::ScopeGmailModify, C::ScopeGmailSend) }
  Set(ok, { ...ok, scopes: List(C::ScopeGmailModify) }, { ...ok, scopes: List(C::ScopeGmailSend) }, { ...ok, status: C::Expired })
}
pure def lawAnAdmittedChangeIsOneTheCapabilitiesOffer(proposal: Proposal, authority: MailAuthority): bool =
  authorityAllows(proposal, authority) implies offeredKinds(authority.scopes).includes(kindOfProposal(proposal))
```

### Preparing binds the request id to its kind and reviewed digest once, and a repeat with the same digest answers the receipt as it stands

A receipt already held is answered first: as it stands for the same digest,
`409 idempotency_conflict` (unchanged) for another. Otherwise authority and
review must pass, and the answer adds `review: {from, to, cc, subject,
attachments, forwardedAttachments}`. A claim is stale after 90 s, three
times Google's call deadline.

```quint
type KindSlot = NoKind | KindOf({ kind: MailOperationKind })
type MailResult = NoResult | Shown({ shownLabels: List[MailLabel] })
type Operation = { slot: KindSlot, result: MailResult, receipt: D::Receipt }
type OperationAnswer = AnswerReceipt | AnswerRefused({ refusal: Refusal })
pure val initial: Operation = { slot: NoKind, result: NoResult, receipt: D::initial }
pure val mailStaleAfter: Millis = 90 * millisPerSecond
pure val preparedLifetime: Millis = millisPerDay
pure def nowOf(o: Operation): Millis = o.receipt.session.now
pure def keyOf(providerId: str): ProviderKey = { providerKind: GmailOperation, providerId: providerId }
pure def slotKind(o: Operation): MailOperationKind = { val slot = o.slot match slot { | KindOf(x) => x.kind | NoKind => SendKind } }
pure def canPrepare(o: Operation, by: S::SessionOwner, proposal: Proposal, providerId: str, digest: str, authority: MailAuthority): bool =
  o.slot == NoKind and authorityAllows(proposal, authority) and reviewOf(proposal) == ReviewPasses and D::canPrepare(o.receipt, by, digest, keyOf(providerId), mailStaleAfter, nowOf(o) + preparedLifetime)
pure def prepare(o: Operation, by: S::SessionOwner, proposal: Proposal, providerId: str, digest: str, authority: MailAuthority): Operation =
  { ...o, slot: KindOf({ kind: kindOfProposal(proposal) }), receipt: D::prepare(o.receipt, by, digest, keyOf(providerId), mailStaleAfter, nowOf(o) + preparedLifetime) }
pure def prepareAnswer(o: Operation, by: S::SessionOwner, proposal: Proposal, digest: str, authority: MailAuthority): OperationAnswer = {
  val review = reviewOf(proposal)
  if (o.receipt.session.phase != S::Absent) (if (D::isConflict(o.receipt, by, digest)) AnswerRefused({ refusal: refuse(IdempotencyConflict) }) else AnswerReceipt)
  else if (not(authorityAllows(proposal, authority))) AnswerRefused({ refusal: authorityRefusal(proposal, authority) })
  else match review { | ReviewRefused(x) => AnswerRefused({ refusal: x.refusal }) | ReviewPasses => AnswerReceipt }
}
pure val byValues = Set({ agentId: "org1", actorId: "user1", connector: "gmail_operation" })
pure val providerIdValues = Set("g1:r1")
pure val weight_prepare = 5
pure def alwaysAPreparedOperationHasItsKindAndAGmailKey(o: Operation): bool =
  ((o.slot == NoKind) iff (o.receipt.session.phase == S::Absent)) and (o.slot == NoKind implies o.receipt.settlement == D::Unsettled)
  and (o.slot != NoKind implies D::kindOf(o.receipt) == GmailOperation)
pure def stepKindIsFixed(before: Operation, after: Operation): bool = before.slot != NoKind implies after.slot == before.slot
pure def sometimesPreparedAwaitingDispatch(o: Operation): bool = o.slot != NoKind and D::receiptStatus(o.receipt) == D::StatusPrepared
```

### A prepared change is claimed only by a dispatch naming its digest, reviewed again against Google at that moment

No receipt is `404 not_found`, another `reviewDigest` or kind `409
stale_revision`; a receipt no longer prepared is answered as it stands,
without credentials or Google. A prepared one is reviewed again under the
grant's authority and claimed (committed) before Google is asked.

```quint
pure def canDispatch(o: Operation, by: S::SessionOwner, proposal: Proposal, digest: str, authority: MailAuthority): bool =
  o.slot == KindOf({ kind: kindOfProposal(proposal) }) and digest == o.receipt.digest
  and authorityAllows(proposal, authority) and reviewOf(proposal) == ReviewPasses and D::canClaim(o.receipt, by)
pure def dispatch(o: Operation, by: S::SessionOwner, proposal: Proposal, digest: str, authority: MailAuthority): Operation = { ...o, receipt: D::claim(o.receipt, by) }
pure def dispatchAnswer(o: Operation, proposal: Proposal, digest: str, authority: MailAuthority): OperationAnswer = {
  val review = reviewOf(proposal)
  if (o.receipt.session.phase == S::Absent) AnswerRefused({ refusal: refuse(NotFound) })
  else if (digest != o.receipt.digest or o.slot != KindOf({ kind: kindOfProposal(proposal) })) AnswerRefused({ refusal: refuse(StaleRevision) })
  else if (D::receiptStatus(o.receipt) != D::StatusPrepared or nowOf(o) >= o.receipt.session.expiresAt) AnswerReceipt
  else if (not(authorityAllows(proposal, authority))) AnswerRefused({ refusal: authorityRefusal(proposal, authority) })
  else match review { | ReviewRefused(x) => AnswerRefused({ refusal: x.refusal }) | ReviewPasses => AnswerReceipt }
}
pure val weight_dispatch = 5
pure def sometimesClaimedBeforeGoogleIsAsked(o: Operation): bool = o.receipt.session.phase == S::Committed and o.receipt.session.effects == 0 and o.receipt.session.executorAlive
```

### A change not dispatched within a day of its preparation is settled not applied

Nothing was sent: it answers `rejected`, code `not_applied`; a new request id may propose it again.

```quint
pure def canExpire(o: Operation, by: S::SessionOwner): bool = o.slot != NoKind and nowOf(o) >= o.receipt.session.expiresAt and D::canAbandon(o.receipt, by)
pure def expire(o: Operation, by: S::SessionOwner): Operation = { ...o, receipt: D::abandon(o.receipt, by) }
pure def sometimesExpiredBeforeDispatch(o: Operation): bool = o.slot != NoKind and o.receipt.settlement == D::NotApplied and o.receipt.session.phase == S::Pending
```

### Google is asked once, by the claim holder, with exactly the reviewed message, before the stale time

A send or draft save carries the reviewed MIME bytes (with `threadId` for a
reply); a label change adds or removes only its one label (`trash` and
`untrash` use Gmail's Trash calls). Nothing is retried.

```quint
pure def canSend(o: Operation, by: S::SessionOwner, claimToken: int): bool = o.slot != NoKind and D::canSend(o.receipt, by, claimToken)
pure def send(o: Operation, by: S::SessionOwner, claimToken: int): Operation = { ...o, receipt: D::send(o.receipt, by, claimToken) }
pure def canLoseExecutor(o: Operation): bool = o.slot != NoKind and D::canLoseExecutor(o.receipt)
pure def loseExecutor(o: Operation): Operation = { ...o, receipt: D::loseExecutor(o.receipt) }
pure def canElapse(o: Operation, elapsed: Millis): bool = D::canElapse(o.receipt, elapsed)
pure def elapse(o: Operation, elapsed: Millis): Operation = { ...o, receipt: D::elapse(o.receipt, elapsed) }
pure val elapsedValues = Set(1000, 90000, 86400000)
pure val weight_send = 5
pure def alwaysReceiptIsSound(o: Operation): bool =
  D::alwaysPreparedIsBound(o.receipt) and D::alwaysSessionIsSound(o.receipt) and D::alwaysSentBeforeStale(o.receipt) and D::alwaysOutcomeFollowsTheSession(o.receipt)
pure def stepReceiptKeepsItsRules(before: Operation, via: str, after: Operation): bool =
  D::stepBindingIsFixed(before.receipt, after.receipt) and D::stepCommitNeverReopens(before.receipt, after.receipt) and D::stepStaleTimeIsFixed(before.receipt, after.receipt)
  and D::stepSettledIsFinal(before.receipt, after.receipt) and D::stepUnknownSettlesOnlyByLookup(before.receipt, via, after.receipt)
```

### A change succeeds only when Google's reply shows the requested state, and any other reply that is not a refusal leaves it unknown

A label change succeeds when the returned labels show its label (`TRASH`,
`UNREAD`, `INBOX`, `STARRED`) added or removed, a send when Google returns
its ids, a draft save when the draft read back holds exactly the reviewed
bytes, a draft delete when Google confirms it. Google's 404 rejects as
`not_found`, 401 or 403 as `reauth_required`, 400, 409, 412 or 422 as
`provider_rejected`. Only a succeeded receipt carries `providerResult`.

```quint
type MailLabel = LabelInbox | LabelTrash | LabelUnread | LabelStarred
type LabelChange = AddLabel({ label: MailLabel }) | RemoveLabel({ label: MailLabel }) | NoLabelChange
type MailReply = LabelsReturned({ labels: List[MailLabel] }) | MessageSent | DraftStored({ sameBytes: bool }) | DraftDeleted | GoogleNotFound | GoogleRefusedAccess | GoogleRefusedOther | NoClearReply
pure def labelChangeOf(kind: MailOperationKind): LabelChange =
  if (kind == ArchiveKind) RemoveLabel({ label: LabelInbox }) else if (kind == UnarchiveKind) AddLabel({ label: LabelInbox }) else if (kind == TrashKind) AddLabel({ label: LabelTrash })
  else if (kind == UntrashKind) RemoveLabel({ label: LabelTrash }) else if (kind == MarkReadKind) RemoveLabel({ label: LabelUnread }) else if (kind == MarkUnreadKind) AddLabel({ label: LabelUnread })
  else if (kind == StarKind) AddLabel({ label: LabelStarred }) else if (kind == UnstarKind) RemoveLabel({ label: LabelStarred }) else NoLabelChange
pure def showsRequested(kind: MailOperationKind, labels: List[MailLabel]): bool = { val change = labelChangeOf(kind)
  match change { | AddLabel(x) => labels.includes(x.label) | RemoveLabel(x) => not(labels.includes(x.label)) | NoLabelChange => true } }
pure def replyFits(kind: MailOperationKind, reply: MailReply): bool = match reply {
  | LabelsReturned(x) => isLabelKind(kind) | MessageSent => kind == SendKind | DraftDeleted => kind == DraftDeleteKind
  | DraftStored(x) => kind == DraftCreateKind or kind == DraftReplaceKind | _ => true }
pure def resultOf(kind: MailOperationKind, reply: MailReply): MailResult = match reply {
  | LabelsReturned(x) => if (showsRequested(kind, x.labels)) Shown({ shownLabels: x.labels }) else NoResult
  | DraftStored(x) => if (x.sameBytes) Shown({ shownLabels: List() }) else NoResult
  | MessageSent => Shown({ shownLabels: List() }) | DraftDeleted => Shown({ shownLabels: List() }) | _ => NoResult }
pure def providerReplyOf(kind: MailOperationKind, reply: MailReply): D::ProviderReply =
  if (resultOf(kind, reply) != NoResult) D::ShowsEffect
  else if (reply == GoogleNotFound) D::DefiniteRefusal({ cause: D::NotFoundAtProvider })
  else if (reply == GoogleRefusedAccess) D::DefiniteRefusal({ cause: D::AuthorizationLost })
  else if (reply == GoogleRefusedOther) D::DefiniteRefusal({ cause: D::OtherRefusal })
  else D::Unclear
pure def shownLabelsOf(result: MailResult): List[MailLabel] = match result { | Shown(x) => x.shownLabels | NoResult => List() }
pure def canReceiveReply(o: Operation, reply: MailReply): bool =
  o.slot != NoKind and replyFits(slotKind(o), reply) and D::canReceiveReply(o.receipt, providerReplyOf(slotKind(o), reply))
pure def receiveReply(o: Operation, reply: MailReply): Operation =
  { ...o, receipt: D::receiveReply(o.receipt, providerReplyOf(slotKind(o), reply)), result: resultOf(slotKind(o), reply) }
pure val replyValues = Set(LabelsReturned({ labels: List(LabelTrash) }), LabelsReturned({ labels: List(LabelInbox, LabelUnread) }), MessageSent,
  DraftStored({ sameBytes: true }), DraftStored({ sameBytes: false }), DraftDeleted, GoogleNotFound, GoogleRefusedAccess, GoogleRefusedOther, NoClearReply)
pure val weight_receiveReply = 5
pure def alwaysAResultExactlyWhenGoogleShowedTheRequestedState(o: Operation): bool =
  ((o.result != NoResult) iff (o.receipt.settlement == D::Succeeded)) and (o.result != NoResult implies showsRequested(slotKind(o), shownLabelsOf(o.result)))
pure def sometimesSentAsReviewed(o: Operation): bool = slotKind(o) == SendKind and o.receipt.settlement == D::Succeeded
pure def sometimesLabelChangeShown(o: Operation): bool = o.slot != NoKind and isLabelKind(slotKind(o)) and o.receipt.settlement == D::Succeeded
pure def sometimesDraftSavedAsReviewed(o: Operation): bool = (slotKind(o) == DraftCreateKind or slotKind(o) == DraftReplaceKind) and o.receipt.settlement == D::Succeeded
pure def sometimesUnverifiedReplyLeftUnknown(o: Operation): bool =
  o.slot != NoKind and isLabelKind(slotKind(o)) and o.receipt.session.effects == 1 and o.receipt.settlement == D::Unsettled and not(o.receipt.session.executorAlive)
pure def sometimesRejectedByGoogle(o: Operation): bool = o.receipt.settlement == D::Refused
```

### An unknown outcome settles only when the effect is found or Google was never asked

Gmail cannot be asked by key whether a change was made, so a sent change
whose reply was lost or unclear is never settled by a guess. A draft
creation looks for the draft with the request's Message-ID. A replacement
reads the named draft. Either save is found only when Gmail holds the
exact prepared bytes, and returns the draft ID and digest of those bytes
without sending the operation again. A claim whose sender was lost before
asking settles `not applied`.

```quint
pure def draftBytesMatch(prepared: str, seen: str): bool = prepared != "" and seen == prepared
pure def observedMail(kind: MailOperationKind, reply: MailReply): MailResult =
  if (replyFits(kind, reply)) resultOf(kind, reply) else NoResult
pure def lookupOfMail(kind: MailOperationKind, reply: MailReply): D::LookupResult =
  if (observedMail(kind, reply) == NoResult) D::NothingSeen else D::EffectSeen
pure def canResolve(o: Operation, reply: MailReply): bool =
  o.slot != NoKind and D::canResolve(o.receipt, lookupOfMail(slotKind(o), reply))
pure def resolve(o: Operation, reply: MailReply): Operation =
  { ...o, receipt: D::resolve(o.receipt, lookupOfMail(slotKind(o), reply)), result: observedMail(slotKind(o), reply) }
pure def alwaysASentChangeIsNeverSettledNotApplied(o: Operation): bool = o.receipt.settlement == D::NotApplied implies o.receipt.session.effects == 0
pure def sometimesClaimedButNeverSentSettled(o: Operation): bool = o.receipt.settlement == D::NotApplied and o.receipt.session.phase == S::Committed
pure def lawADraftLookupRequiresItsPreparedBytes(prepared: str, seen: str): bool =
  lookupOfMail(DraftCreateKind, DraftStored({ sameBytes: draftBytesMatch(prepared, seen) })) == D::EffectSeen
    iff (prepared != "" and seen == prepared)
```

### Every answer carries the receipt as it stands, and says Google does not apply a change exactly once

Prepare, dispatch and `GET` (which only reads, even on a lapsed grant)
answer `{version: 1, receipt, providerExactlyOnce: false}`, the receipt
`{requestId, kind, reviewDigest, state, providerResult, rejectionCode,
createdAt, dispatchedAt, finishedAt}`; `state` is `prepared`, `dispatched`,
`succeeded`, `rejected` (with `rejectionCode`) or `outcome-unknown` (claimed,
then stale or its sender lost).

```quint
type WireState = WirePrepared | WireDispatched | WireSucceeded | WireRejected | WireOutcomeUnknown
type Rejection = NoRejection | RejectedNotFound | RejectedReauth | RejectedByGoogle | RejectedNotApplied
pure def wireStateOf(o: Operation): WireState = { val st = D::receiptStatus(o.receipt)
  if (st == D::StatusSucceeded) WireSucceeded else if (st == D::StatusRejected) WireRejected else if (st == D::StatusUnknown) WireOutcomeUnknown
  else if (st == D::StatusDispatched) WireDispatched else WirePrepared }
pure def rejectionOf(o: Operation): Rejection = { val r = o.receipt
  if (r.settlement == D::NotApplied) RejectedNotApplied else if (r.settlement != D::Refused) NoRejection
  else if (r.refusal == D::NotFoundAtProvider) RejectedNotFound else if (r.refusal == D::AuthorizationLost) RejectedReauth else RejectedByGoogle }
pure def sometimesAnsweredOutcomeUnknown(o: Operation): bool = o.slot != NoKind and wireStateOf(o) == WireOutcomeUnknown
```
