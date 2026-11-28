# Managed Google Calendar

The owner's Google Calendar, read and written by the cloud with the grant of
`spec/cloud/services/google/connection.md`. Sources: develop
`agent-google-connector/{calendar,calendar-sync-provider}.ts` and the routes
`api/v1/eliza/google/calendar/**`. Under `/api/v1/eliza/google/calendar/`,
`GET calendars`, `GET feed` and `GET events/:eventId` accept a signed session
or device lease. `POST events`, `PATCH events/:eventId` and
`DELETE events/:eventId` require a signed session
([session route classes](../../identity/sessions.md)). Every call may name
`grantId` and selects the connection by the rules of `connection`
(`side` other than `owner`, several active grants, another organization's
grant); every call needs a usable connection (`G::usable`). When a read
names an expected Google account, its current grant must hold that subject.
`sync-v1` is gone.

One instance of the machine is one write row (`calendar_writes`): its
request, its target event and its one provider change
(`spec/cloud/shared/dispatchOnce.md`). The shell keys rows by organization,
user and request key, writes each transition in one store transaction, and
does the Google calls, the event bodies and their JSON shapes.

## Story: Read my calendar for a window

> As an owner, I want my assistant to list my calendars and read the events
> of one of them for a time window, so that it plans around what I already
> have.

### A calendar row may be written exactly when the grant holds calendar write and Google makes the owner a writer or owner of it

`GET calendars` answers rows `{calendarId, accountId, accountEmail, label,
accessRole, read, write}` for every calendar Google lists that is neither
hidden nor deleted; `label` is the owner's override, else Google's summary,
else the id, and a missing `accessRole` is `reader`. Each writable row also
advertises `recurrenceLines: true` and `privateCreate: true`.

```quint
import types.* from "../../shared/types"
import connection as G from "./connection"
import dispatchOnce as D from "../../shared/dispatchOnce"
import sessions as S from "../../../core/sessions"
type CalendarRole = FreeBusyReader | Reader | Writer | Owner
type CalendarAccess = { read: bool, write: bool }
pure def rowAccess(scopes: List[G::GoogleScope], role: CalendarRole): CalendarAccess = {
  val held = G::capabilitiesOf(scopes)
  { read: held.includes(G::CalendarRead) and role != FreeBusyReader, write: held.includes(G::CalendarWrite) and (role == Writer or role == Owner) }
}
pure def lawAWritableCalendarIsReadable(scopes: List[G::GoogleScope], role: CalendarRole): bool = rowAccess(scopes, role).write implies rowAccess(scopes, role).read
```

### A feed is served only for a window that ends after it starts, in a known time zone, and whole or not at all

`GET feed?calendarId&timeMin&timeMax&timeZone` needs calendar read and a
calendar whose row is readable, else `403 access_denied`. Its answer names
the authorized Cloud account and gives a null continuation after completing
all provider pages for the requested window. It answers
`{accountId, calendarId, events, syncedAt, nextPageToken: null}` with every
page Google returns; a body over
512 KiB is refused whole as `413 content_too_large`, never cut. A bad window
or an unknown IANA zone is `400 invalid_request`. Feed and event cards keep
the recurrence rules Google supplies, the parent series ID of an occurrence,
and the original start of an occurrence even when it moved to another time.

```quint
type FeedAnswer = FeedServed | FeedRefused({ refusal: Refusal })
pure val feedByteLimit: int = 512 * 1024
pure def feedAnswer(timeMin: Millis, timeMax: Millis, zoneKnown: bool, bodyBytes: int): FeedAnswer =
  if (timeMin >= timeMax or not(zoneKnown)) FeedRefused({ refusal: refuse(InvalidRequest) })
  else if (bodyBytes > feedByteLimit) FeedRefused({ refusal: refuse(ContentTooLarge) })
  else FeedServed
pure val bodyBytesValues = Set(0, 262144, 524288, 524289)
pure def lawAFeedRefusalNeedsANewRequest(timeMin: Millis, timeMax: Millis, zoneKnown: bool, bodyBytes: int): bool = {
  val a = feedAnswer(timeMin, timeMax, zoneKnown, bodyBytes)
  match a { | FeedRefused(x) => wellFormed(x.refusal) and not(retryableOf(x.refusal)) | FeedServed => bodyBytes <= feedByteLimit }
}
```

## Story: Change an event only at the revision I read

> As an owner, I want each event my assistant creates made once however
> often the request is repeated, and each change or deletion applied only to
> the version I last read, so that nothing newer is lost and nothing is
> doubled.

### A create needs an Idempotency-Key and can carry a reviewed recurrence rule. Changes and deletions need one exact If-Match revision

The `If-Match` value is one event `etag` from a read: empty, `*`, a list,
over 1,024 characters or not printable ASCII is malformed. A missing or
malformed header is `400 invalid_request`. A create can carry a reviewed
daily, weekly or weekday rule with an optional end and excluded starts.
Timed recurrences name an IANA time zone. All-day rules use calendar dates
for the end and exclusions. A change or deletion cannot carry recurrence
fields. A refused recurrence uses `400 invalid_request` with reason
`unsupported_field`. Deletion of an instance id removes one occurrence,
and deletion of a series id removes the series. An event body over
256 KiB is `413 content_too_large`. Every refusal before Google is asked
carries `outcome: not_accepted`.

A create with `privateCreate: true` sets Google's event visibility to
`private` and disables provider default reminders. Cloud confirms those
settings in Google's response or a readback, including when retrying an
already accepted create. It reports an unknown outcome if the event no
longer matches the reviewed settings. Other clients can omit the option to
use Google's defaults.

```quint
type WriteOp = NoWrite | CreateEvent | ChangeEvent | RemoveEvent
type RevisionHeader = NoIfMatch | MalformedIfMatch | ExactRevision({ readEtag: str })
type RecurrenceFit = NoRecurrence | ReviewedRecurrence | InvalidRecurrence
type WriteRequest = { op: WriteOp, keyed: bool, revision: RevisionHeader, recurrence: RecurrenceFit, bodyBytes: int }
type RequestFit = RequestFits | RequestRefused({ refusal: Refusal })
pure val writeBodyLimit: int = 256 * 1024
pure def readEtagOf(h: RevisionHeader): str = match h { | ExactRevision(x) => x.readEtag | _ => "" }
pure def headerFits(request: WriteRequest): bool =
  if (request.op == CreateEvent) request.keyed and request.revision == NoIfMatch
  else request.op != NoWrite and readEtagOf(request.revision) != ""
pure def recurrenceFits(request: WriteRequest): bool =
  request.recurrence == NoRecurrence or (request.op == CreateEvent and request.recurrence == ReviewedRecurrence)
pure def requestFit(request: WriteRequest): RequestFit =
  if (not(headerFits(request))) RequestRefused({ refusal: refuse(InvalidRequest) })
  else if (not(recurrenceFits(request))) RequestRefused({ refusal: refuseFor(InvalidRequest, UnsupportedField) })
  else if (request.bodyBytes > writeBodyLimit) RequestRefused({ refusal: refuse(ContentTooLarge) })
  else RequestFits
pure val requestValues: Set[WriteRequest] = {
  val create: WriteRequest = { op: CreateEvent, keyed: true, revision: NoIfMatch, recurrence: NoRecurrence, bodyBytes: 100 }
  val change: WriteRequest = { op: ChangeEvent, keyed: false, revision: ExactRevision({ readEtag: "etag1" }), recurrence: NoRecurrence, bodyBytes: 100 }
  Set(create, change, { ...change, op: RemoveEvent, bodyBytes: 0 }, { ...create, keyed: false }, { ...create, recurrence: ReviewedRecurrence }, { ...create, recurrence: InvalidRecurrence }, { ...change, recurrence: ReviewedRecurrence }, { ...change, revision: NoIfMatch }, { ...change, revision: MalformedIfMatch })
}
pure def lawARequestRefusalNeedsANewRequest(request: WriteRequest): bool = {
  val f = requestFit(request)
  match f { | RequestRefused(x) => wellFormed(x.refusal) and not(retryableOf(x.refusal)) | RequestFits => headerFits(request) and recurrenceFits(request) }
}
```

### A write needs a usable grant that holds calendar write, the account the caller expected and a calendar it may write

`expectedAccountId`, when named, must be the Google subject of the selected
grant, else `403 access_denied` reason `google_account_changed`; a calendar
the row does not let the grant write is `403 access_denied`.

```quint
type AccountFit = NoAccountNamed | SameAccount | OtherAccount
type WriteAuthority = { status: G::ConnectionStatus, access: G::AccessState, scopes: List[G::GoogleScope], account: AccountFit, role: CalendarRole }
pure def holdsWrite(authority: WriteAuthority): bool = G::capabilitiesOf(authority.scopes).includes(G::CalendarWrite)
pure def writeAllowed(authority: WriteAuthority): bool = G::useAllowed(authority.status, authority.access, holdsWrite(authority)) and authority.account != OtherAccount and rowAccess(authority.scopes, authority.role).write
pure def writeRefusal(authority: WriteAuthority): Refusal =
  if (not(G::useAllowed(authority.status, authority.access, holdsWrite(authority)))) G::useRefusal(authority.status, authority.access, holdsWrite(authority))
  else if (authority.account == OtherAccount) refuseFor(AccessDenied, GoogleAccountChanged) else refuse(AccessDenied)
pure val authorityValues: Set[WriteAuthority] = {
  val ok: WriteAuthority = { status: G::Active, access: G::AccessLive, scopes: List(G::ScopeCalendarEvents), account: SameAccount, role: Writer }
  Set(ok, { ...ok, account: NoAccountNamed }, { ...ok, account: OtherAccount }, { ...ok, role: Reader }, { ...ok, scopes: List(G::ScopeCalendarReadonly) }, { ...ok, status: G::Expired })
}
pure def lawAWriteRefusalIsWellFormed(authority: WriteAuthority): bool = not(writeAllowed(authority)) implies wellFormed(writeRefusal(authority))
```

### An admitted write is claimed before Google is asked, and a create is keyed by the event id derived from its Idempotency-Key

The shell derives the create's event id from the organization and the key
(Google's id alphabet), so a repeated create can only meet its own event. A
change or deletion is keyed by its request id. The receipt is found stale one
minute after its claim, twice Google's 30-second call deadline.

```quint
type EventTarget = { grantId: str, calendarId: str, eventId: str }
type Write = { op: WriteOp, grantId: str, calendarId: str, eventId: str, expectedEtag: str, resultEtag: str, receipt: D::Receipt }
pure val initial: Write = { op: NoWrite, grantId: "", calendarId: "", eventId: "", expectedEtag: "", resultEtag: "", receipt: D::initial }
pure val calendarStaleAfter: Millis = millisPerMinute
pure val writeLifetime: Millis = millisPerDay
pure def nowOf(w: Write): Millis = w.receipt.session.now
pure def keyOf(providerId: str): ProviderKey = { providerKind: CalendarEvent, providerId: providerId }
pure def preparedFor(w: Write, by: S::SessionOwner, providerId: str, digest: str): D::Receipt =
  D::prepare(w.receipt, by, digest, keyOf(providerId), calendarStaleAfter, nowOf(w) + writeLifetime)
pure def canBeginWrite(w: Write, by: S::SessionOwner, request: WriteRequest, target: EventTarget, providerId: str, digest: str, authority: WriteAuthority): bool =
  w.op == NoWrite and requestFit(request) == RequestFits and writeAllowed(authority)
  and target.grantId != "" and target.calendarId != "" and target.eventId != ""
  and (if (request.op == CreateEvent) providerId == target.eventId else providerId != "")
  and D::canPrepare(w.receipt, by, digest, keyOf(providerId), calendarStaleAfter, nowOf(w) + writeLifetime)
  and D::canClaim(preparedFor(w, by, providerId, digest), by)
pure def beginWrite(w: Write, by: S::SessionOwner, request: WriteRequest, target: EventTarget, providerId: str, digest: str, authority: WriteAuthority): Write =
  { ...w, op: request.op, grantId: target.grantId, calendarId: target.calendarId, eventId: target.eventId, expectedEtag: readEtagOf(request.revision),
    receipt: D::claim(preparedFor(w, by, providerId, digest), by) }
pure val byValues = Set({ agentId: "org1", actorId: "user1", connector: "calendar_event" })
pure val targetValues = Set({ grantId: "g1", calendarId: "primary", eventId: "ev1" }, { grantId: "g1", calendarId: "", eventId: "ev1" })
pure val providerIdValues = Set("ev1", "req1")
pure val weight_beginWrite = 5
pure def alwaysWriteIsWellFormed(w: Write): bool =
  ((w.op == NoWrite) iff (w.receipt.session.phase == S::Absent))
  and (w.op == NoWrite implies (w.grantId == "" and w.eventId == "" and w.expectedEtag == "" and w.resultEtag == ""))
  and (w.op != NoWrite implies (w.grantId != "" and w.calendarId != "" and w.eventId != "" and w.receipt.providerKey.providerKind == CalendarEvent))
  and (w.op == CreateEvent implies (w.expectedEtag == "" and D::usesProviderKey(w.receipt, keyOf(w.eventId))))
  and ((w.op == ChangeEvent or w.op == RemoveEvent) implies w.expectedEtag != "")
pure def stepTargetIsFixed(before: Write, after: Write): bool =
  before.op != NoWrite implies (after.op == before.op and after.grantId == before.grantId and after.calendarId == before.calendarId
    and after.eventId == before.eventId and after.expectedEtag == before.expectedEtag and (before.resultEtag != "" implies after.resultEtag == before.resultEtag))
```

### Google is asked once, and a change or deletion only with If-Match set to the revision read

Google refuses a newer revision with 412 and changes nothing; the cloud
answers it `412 precondition_failed`. Google's answer that the create's id is
taken, and any reply that is not clear, leave the outcome unknown until the
event is read back. A deletion that finds the event gone, once the calendar
is confirmed writable, has its effect.

```quint
type CalendarReply = Saved({ savedEtag: str }) | Removed | EventMissing | RevisionMoved | GoogleRefusedAccess | DuplicateEventId | NoClearReply
pure def replyFits(op: WriteOp, reply: CalendarReply): bool = match reply {
  | Saved(x) => (op == CreateEvent or op == ChangeEvent) and x.savedEtag != ""
  | Removed => op == RemoveEvent
  | EventMissing => op == ChangeEvent
  | RevisionMoved => op == ChangeEvent or op == RemoveEvent
  | DuplicateEventId => op == CreateEvent
  | GoogleRefusedAccess => op != NoWrite
  | NoClearReply => op != NoWrite
}
pure def providerReplyOf(reply: CalendarReply): D::ProviderReply = match reply {
  | Saved(x) => D::ShowsEffect
  | Removed => D::ShowsEffect
  | EventMissing => D::DefiniteRefusal({ cause: D::NotFoundAtProvider })
  | RevisionMoved => D::DefiniteRefusal({ cause: D::OtherRefusal })
  | GoogleRefusedAccess => D::DefiniteRefusal({ cause: D::AuthorizationLost })
  | _ => D::Unclear
}
pure def savedEtagOf(reply: CalendarReply): str = match reply { | Saved(x) => x.savedEtag | _ => "" }
pure def canSend(w: Write, by: S::SessionOwner, claimToken: int): bool = w.op != NoWrite and D::canSend(w.receipt, by, claimToken)
pure def send(w: Write, by: S::SessionOwner, claimToken: int): Write = { ...w, receipt: D::send(w.receipt, by, claimToken) }
pure def canReceiveReply(w: Write, reply: CalendarReply): bool = replyFits(w.op, reply) and D::canReceiveReply(w.receipt, providerReplyOf(reply))
pure def receiveReply(w: Write, reply: CalendarReply): Write = { ...w, receipt: D::receiveReply(w.receipt, providerReplyOf(reply)), resultEtag: savedEtagOf(reply) }
pure def canLoseExecutor(w: Write): bool = w.op != NoWrite and D::canLoseExecutor(w.receipt)
pure def loseExecutor(w: Write): Write = { ...w, receipt: D::loseExecutor(w.receipt) }
pure def canElapse(w: Write, elapsed: Millis): bool = D::canElapse(w.receipt, elapsed)
pure def elapse(w: Write, elapsed: Millis): Write = { ...w, receipt: D::elapse(w.receipt, elapsed) }
pure val replyValues = Set(Saved({ savedEtag: "etag2" }), Removed, EventMissing, RevisionMoved, GoogleRefusedAccess, DuplicateEventId, NoClearReply)
pure val elapsedValues = Set(1000, 60000)
pure def alwaysRefusalFitsTheWrite(w: Write): bool =
  (w.receipt.refusal == D::OtherRefusal implies (w.op == ChangeEvent or w.op == RemoveEvent))
  and (w.receipt.refusal == D::NotFoundAtProvider implies w.op == ChangeEvent)
pure def sometimesCreated(w: Write): bool = w.op == CreateEvent and w.receipt.settlement == D::Succeeded and w.receipt.session.executorAlive
pure def sometimesChangedAtTheRevisionRead(w: Write): bool = w.op == ChangeEvent and w.receipt.settlement == D::Succeeded
pure def sometimesRemoved(w: Write): bool = w.op == RemoveEvent and w.receipt.settlement == D::Succeeded
pure def sometimesNewerRevisionRefused(w: Write): bool = w.receipt.refusal == D::OtherRefusal
pure def sometimesChangedEventMissing(w: Write): bool = w.receipt.refusal == D::NotFoundAtProvider
```

### An unknown outcome is settled only by reading the event back

The shell reads the event id (a create's derived id, cancelled events
included). An event bound to this request's content has its effect; an event
still at the revision read, or a create's id unused, has not, and settles
`not applied` only after the stale wait of `dispatchOnce`. A deleted event is
the effect of a deletion; for a change it, like an event at another
revision, cannot tell, and the shell does not step.

```quint
type CalendarLookup = FoundAsRequested({ foundEtag: str }) | FoundUnchanged | FoundNothing
pure def lookupFits(op: WriteOp, lookup: CalendarLookup): bool = match lookup {
  | FoundAsRequested(x) => (op == CreateEvent or op == ChangeEvent) and x.foundEtag != ""
  | FoundUnchanged => op == ChangeEvent or op == RemoveEvent
  | FoundNothing => op == CreateEvent or op == RemoveEvent
}
pure def lookupResultOf(op: WriteOp, lookup: CalendarLookup): D::LookupResult = match lookup {
  | FoundAsRequested(x) => D::EffectSeen
  | FoundUnchanged => D::NothingSeen
  | FoundNothing => if (op == RemoveEvent) D::EffectSeen else D::NothingSeen
}
pure def foundEtagOf(lookup: CalendarLookup): str = match lookup { | FoundAsRequested(x) => x.foundEtag | _ => "" }
pure def canResolve(w: Write, lookup: CalendarLookup): bool = lookupFits(w.op, lookup) and D::canResolve(w.receipt, lookupResultOf(w.op, lookup))
pure def resolve(w: Write, lookup: CalendarLookup): Write = { ...w, receipt: D::resolve(w.receipt, lookupResultOf(w.op, lookup)), resultEtag: foundEtagOf(lookup) }
pure val lookupValues = Set(FoundAsRequested({ foundEtag: "etag2" }), FoundUnchanged, FoundNothing)
pure def alwaysReceiptIsSound(w: Write): bool =
  D::alwaysPreparedIsBound(w.receipt) and D::alwaysSessionIsSound(w.receipt) and D::alwaysSentBeforeStale(w.receipt) and D::alwaysOutcomeFollowsTheSession(w.receipt)
pure def stepReceiptKeepsItsRules(before: Write, via: str, after: Write): bool =
  D::stepBindingIsFixed(before.receipt, after.receipt) and D::stepCommitNeverReopens(before.receipt, after.receipt) and D::stepStaleTimeIsFixed(before.receipt, after.receipt)
  and D::stepSettledIsFinal(before.receipt, after.receipt) and D::stepUnknownSettlesOnlyByLookup(before.receipt, via, after.receipt)
pure def sometimesDuplicateIdReadBack(w: Write): bool = w.op == CreateEvent and w.receipt.settlement == D::Succeeded and not(w.receipt.session.executorAlive)
pure def sometimesOutcomeUnknown(w: Write): bool = w.op != NoWrite and D::isUnknown(w.receipt)
pure def sometimesNotAppliedAfterReadBack(w: Write): bool = w.receipt.settlement == D::NotApplied and w.receipt.session.effects == 1
```

### An applied create or change returns the event's new revision, and an applied deletion none

A create answers `201 {event}`, a change `200 {event}` with the revision
also as `ETag`, a deletion `{ok: true}`.

```quint
pure def alwaysAppliedWriteHasItsRevision(w: Write): bool =
  (w.resultEtag != "") iff (w.receipt.settlement == D::Succeeded and w.op != RemoveEvent)
```

### Every answer of a write row says whether Google may have applied it

A refused or not applied write is `not_accepted`; a running or unknown one
is `unknown`, and a running one says to retry at its stale time. Google's
missing event is `404 not_found`, lost access `409 google_reauth_required`,
a newer revision `412 precondition_failed`, not applied or unknown `502
provider_invalid_response`. A repeat of the same Idempotency-Key with other
content is `409 idempotency_conflict` and changes nothing; with the same
content it gets the row's answer as it stands.

```quint
type WireOutcome = NotAccepted | OutcomeUnknown
type WriteAnswer = AnswerApplied | AnswerRefused({ refusal: Refusal, outcome: WireOutcome })
pure def refusalOfCause(cause: D::RefusalCause): Refusal =
  if (cause == D::NotFoundAtProvider) refuse(NotFound) else if (cause == D::AuthorizationLost) refuse(GoogleReauthRequired) else refuse(PreconditionFailed)
pure def writeAnswer(w: Write): WriteAnswer = {
  val r = w.receipt
  if (r.settlement == D::Succeeded) AnswerApplied
  else if (r.settlement == D::Refused) AnswerRefused({ refusal: refusalOfCause(r.refusal), outcome: NotAccepted })
  else if (r.settlement == D::NotApplied) AnswerRefused({ refusal: refuse(ProviderInvalidResponse), outcome: NotAccepted })
  else if (D::isUnknown(r)) AnswerRefused({ refusal: refuse(ProviderInvalidResponse), outcome: OutcomeUnknown })
  else AnswerRefused({ refusal: refuseUntil(ProviderUnavailable, D::staleAt(r)), outcome: OutcomeUnknown })
}
pure def replayAnswer(w: Write, by: S::SessionOwner, digest: str): WriteAnswer =
  if (D::isConflict(w.receipt, by, digest)) AnswerRefused({ refusal: refuse(IdempotencyConflict), outcome: NotAccepted }) else writeAnswer(w)
pure def alwaysAnswerIsWellFormed(w: Write): bool = {
  val a = writeAnswer(w)
  match a { | AnswerRefused(x) => wellFormed(x.refusal) and ((x.outcome == NotAccepted) iff (w.receipt.settlement == D::Refused or w.receipt.settlement == D::NotApplied)) | AnswerApplied => w.receipt.settlement == D::Succeeded }
}
```
