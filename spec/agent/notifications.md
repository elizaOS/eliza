# Notifications

The device's native notice page and the owner's read mark, served by the optional
`@elizaos/agent/notifications` module over core's
[notification inbox](../core/notifications/). Core owns the rows, their
groups and expiry, the durable write and the live fan-out: an acknowledged
change is published on the agent's `notification` event stream, which a
client reads through the transport's event subscription. Core's
[cursor](../core/notifications/cursor.md) owns native paging. This spec
owns only the two routes a client calls, `GET /api/notifications` and
`POST /api/notifications/:id/read`: which queries they accept, what they
answer and when they refuse. There is no push token, no create, delete or
read-all route, and no owner session: the only caller is Root.

## Story: Read my notices and mark them read from my own client

> As the owner, I want my device to page the native inbox without gaps and
> mark exactly the notice I read, so that what my device shows matches what
> my agent keeps.

### A list query asks for the native page, with each parameter given once and well formed

The list is core's native page, oldest first: the device's own inbox is
its only reader. A query is refused (400) unless `nativeTransport` is
`true`, no parameter is repeated, `limit`, `afterSequence` and
`throughSequence` are decimal digit strings and `nativeEpoch` is
UUID-shaped. Core's cursor then decides everything else about the page:
its limit, its fence, a continuation without its epoch and an epoch that
changed, each refused with core's own code.

```quint
import notifications as N from "../core/notifications"
type DecimalText = Decimal({ value: int }) | NotDecimal
type EpochText = EpochUuid | NotUuid
type ListParams = { nativeTransport: List[str], nativeEpoch: List[EpochText], limit: List[DecimalText], afterSequence: List[DecimalText], throughSequence: List[DecimalText] }
type ListRequest = BadQuery | NativePage
pure def decimalValid(t: DecimalText): bool = match t { | Decimal(d) => d.value >= 0 | NotDecimal => false }
pure def repeated(asked: ListParams): bool =
  asked.nativeTransport.length() > 1 or asked.nativeEpoch.length() > 1 or asked.limit.length() > 1 or asked.afterSequence.length() > 1 or asked.throughSequence.length() > 1
pure def wellFormed(asked: ListParams): bool =
  not(repeated(asked)) and asked.nativeTransport == List("true") and asked.nativeEpoch.every(t => t == EpochUuid)
    and asked.limit.every(t => decimalValid(t)) and asked.afterSequence.every(t => decimalValid(t)) and asked.throughSequence.every(t => decimalValid(t))
pure def listRequest(asked: ListParams): ListRequest = if (wellFormed(asked)) NativePage else BadQuery
pure val noParams: ListParams = { nativeTransport: List("true"), nativeEpoch: List(), limit: List(), afterSequence: List(), throughSequence: List() }
pure val askedValues = Set(
  noParams, { ...noParams, nativeTransport: List() }, { ...noParams, nativeTransport: List("1") }, { ...noParams, nativeTransport: List("true", "true") },
  { ...noParams, limit: List(Decimal({ value: 128 })) }, { ...noParams, limit: List(NotDecimal) }, { ...noParams, nativeEpoch: List(NotUuid) },
  { ...noParams, nativeEpoch: List(EpochUuid), afterSequence: List(Decimal({ value: 1 })), throughSequence: List(Decimal({ value: 3 })) })
pure def lawRepeatedParameterIsRefused(asked: ListParams): bool = repeated(asked) implies listRequest(asked) == BadQuery
pure def lawOnlyTheNativePageIsListed(asked: ListParams): bool = not(asked.nativeTransport == List("true")) implies listRequest(asked) == BadQuery
```

### An inbox that is not durably available answers 503, never an empty list

A well-formed request to an inbox that is still starting, has failed or
is closed is answered 503 with `Retry-After`, and only a failed inbox asks
core to recover it. It never answers an empty list or `ok: false` in
its place. A malformed request is refused first, whatever the inbox's
state.

```quint
type InboxStatus = InboxReady | InboxStarting | InboxFailed | InboxClosed
type ListAnswer = Refused | Unavailable({ recover: bool }) | PagedByCursor
pure def recovers(availability: InboxStatus): bool = availability == InboxFailed
pure def listAnswer(request: ListRequest, availability: InboxStatus): ListAnswer =
  if (request == BadQuery) Refused else if (availability != InboxReady) Unavailable({ recover: recovers(availability) }) else PagedByCursor
pure val requestValues = Set(BadQuery, NativePage)
pure def lawUnavailableInboxListsNothing(request: ListRequest, availability: InboxStatus): bool =
  (availability != InboxReady and request != BadQuery) implies listAnswer(request, availability) == Unavailable({ recover: recovers(availability) })
pure def lawOnlyAFailedInboxIsRecovered(request: ListRequest, availability: InboxStatus): bool =
  listAnswer(request, availability) == Unavailable({ recover: true }) iff (availability == InboxFailed and request != BadQuery)
```

### Marking a notice read answers ok only when this call durably marked an unread notice

`POST /api/notifications/:id/read` takes a UUID; any other id is refused
(400). The reply is exactly `{ok}`. `ok` is true only when a notice with
that id was unread and core acknowledged the write that marked it, so a
lost acknowledgement is never reported as done: it answers 503 and the
client reads the notice back. A missing or already read notice answers
`ok: false` and writes nothing. Core marks only that notice.

```quint
type NoticeIdText = NoticeUuid({ id: str }) | NotNoticeUuid
type MarkReadAnswer = BadNoticeId | MarkedRead({ ok: bool }) | MarkUnavailable({ recover: bool })
pure def requestedId(requested: NoticeIdText): str = match requested { | NoticeUuid(x) => x.id | NotNoticeUuid => "" }
pure def unreadNotice(notices: List[N::Notice], id: str): bool = notices.some(notice => notice.id == id and not(notice.read))
pure def markReadAnswer(requested: NoticeIdText, availability: InboxStatus, notices: List[N::Notice], writeOutcome: N::WriteOutcome): MarkReadAnswer =
  if (requested == NotNoticeUuid) BadNoticeId
  else if (availability != InboxReady) MarkUnavailable({ recover: recovers(availability) })
  else if (not(unreadNotice(notices, requestedId(requested)))) MarkedRead({ ok: false })
  else if (writeOutcome == N::Acknowledged) MarkedRead({ ok: true })
  else MarkUnavailable({ recover: false })
pure val requestedValues = Set(NoticeUuid({ id: "n1" }), NoticeUuid({ id: "n2" }), NoticeUuid({ id: "n9" }), NotNoticeUuid)
pure val noticesValues = Set(List(), List({ ...N::emptyNotice, id: "n1", sequence: 1 }), List({ ...N::emptyNotice, id: "n1", sequence: 1 }, { ...N::emptyNotice, id: "n2", sequence: 2, read: true }))
pure def lawOkMeansThisCallMarkedAnUnreadNotice(requested: NoticeIdText, availability: InboxStatus, notices: List[N::Notice], writeOutcome: N::WriteOutcome): bool =
  markReadAnswer(requested, availability, notices, writeOutcome) == MarkedRead({ ok: true }) implies (availability == InboxReady and unreadNotice(notices, requestedId(requested)) and writeOutcome == N::Acknowledged)
pure def lawUnconfirmedWriteIsNeverAnswered(requested: NoticeIdText, notices: List[N::Notice], writeOutcome: N::WriteOutcome): bool =
  (requested != NotNoticeUuid and unreadNotice(notices, requestedId(requested)) and writeOutcome != N::Acknowledged) implies markReadAnswer(requested, InboxReady, notices, writeOutcome) == MarkUnavailable({ recover: false })
```
