# Notifications

The owner's notice list and read mark, served by the optional
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

> As the owner, I want my client to list only the notices I ask for, page
> the native inbox without gaps and mark exactly the notice I read, so that
> what my device shows matches what my agent keeps.

### A list query is refused unless each parameter is given once and well formed

The shell decodes each repeated query parameter into a list, a decimal
digit string into a number and a UUID-shaped `nativeEpoch` into the inbox
epoch it names. A query is refused (400) when any parameter is repeated,
`nativeTransport` or `unreadOnly` is not empty, `true` or `false`, a
number is not decimal, a category is not one of the nine known ones, or an
owner limit is outside 1 to 100. An absent owner limit lists every
matching notice. A limit is never silently lowered.

```quint
import notifications as N from "../core/notifications"
import cursor as NC from "../core/notifications/cursor"
type DecimalText = Decimal({ value: int }) | NotDecimal
type EpochText = KnownEpoch({ epoch: int }) | NotUuid
type ListParams = { category: List[str], unreadOnly: List[str], limit: List[DecimalText], nativeTransport: List[str], nativeEpoch: List[EpochText], afterSequence: List[DecimalText], throughSequence: List[DecimalText] }
type PageSize = AllRows | AtMost({ rows: int })
type ListRequest = BadQuery | OwnerList({ category: str, unreadOnly: bool, pageSize: PageSize }) | NativePage({ query: NC::Cursor, limit: int })
pure val ownerLimitMax = 100
pure val nativeLimitMax = 128
pure val knownCategories = Set("reminder", "task", "workflow", "agent", "approval", "message", "health", "system", "general")
pure def decimalValid(t: DecimalText): bool = match t { | Decimal(d) => d.value >= 0 | NotDecimal => false }
pure def epochValid(t: EpochText): bool = match t { | KnownEpoch(e) => e.epoch >= 0 | NotUuid => false }
pure def decimalOr(given: List[DecimalText], fallback: int): int = { val first = given.nthOr(0, NotDecimal)
  match first { | Decimal(d) => d.value | NotDecimal => fallback } }
pure def epochOr(given: List[EpochText], fallback: int): int = { val first = given.nthOr(0, NotUuid)
  match first { | KnownEpoch(e) => e.epoch | NotUuid => fallback } }
pure def flagValid(given: List[str]): bool = given.every(v => v == "" or v == "true" or v == "false")
pure def wellFormed(asked: ListParams): bool =
  asked.category.length() <= 1 and asked.unreadOnly.length() <= 1 and asked.limit.length() <= 1 and asked.nativeTransport.length() <= 1 and asked.nativeEpoch.length() <= 1 and asked.afterSequence.length() <= 1 and asked.throughSequence.length() <= 1 and
  flagValid(asked.nativeTransport) and flagValid(asked.unreadOnly) and asked.limit.every(t => decimalValid(t)) and asked.afterSequence.every(t => decimalValid(t)) and asked.throughSequence.every(t => decimalValid(t)) and asked.nativeEpoch.every(t => epochValid(t))
pure def ownerRequest(asked: ListParams): ListRequest = {
  val limit = decimalOr(asked.limit, 0)
  val cursorGiven = asked.nativeEpoch.length() > 0 or asked.afterSequence.length() > 0 or asked.throughSequence.length() > 0
  if (cursorGiven or asked.category.some(c => not(knownCategories.contains(c))) or (asked.limit.length() > 0 and (limit < 1 or limit > ownerLimitMax))) BadQuery
  else OwnerList({ category: asked.category.nthOr(0, ""), unreadOnly: asked.unreadOnly.includes("true"), pageSize: if (asked.limit.length() == 0) AllRows else AtMost({ rows: limit }) })
}
pure def listRequest(asked: ListParams, epoch: int, sequence: int): ListRequest = {
  val limit = decimalOr(asked.limit, nativeLimitMax)
  val after = decimalOr(asked.afterSequence, 0)
  if (not(wellFormed(asked))) BadQuery
  else if (not(asked.nativeTransport.includes("true"))) ownerRequest(asked)
  else if (asked.category.length() > 0 or asked.unreadOnly.length() > 0 or limit < 1 or limit > nativeLimitMax) BadQuery
  else if (asked.nativeEpoch.length() == 0 and (after > 0 or asked.throughSequence.length() > 0)) BadQuery
  else NativePage({ query: { epoch: epochOr(asked.nativeEpoch, epoch), after: after, through: decimalOr(asked.throughSequence, sequence) }, limit: limit })
}
pure val noParams: ListParams = { category: List(), unreadOnly: List(), limit: List(), nativeTransport: List(), nativeEpoch: List(), afterSequence: List(), throughSequence: List() }
pure val askedValues = Set(
  noParams, { ...noParams, category: List("reminder"), unreadOnly: List("true"), limit: List(Decimal({ value: 20 })) },
  { ...noParams, category: List("remindr") }, { ...noParams, unreadOnly: List("true", "false") }, { ...noParams, unreadOnly: List("yes") },
  { ...noParams, limit: List(Decimal({ value: 101 })) }, { ...noParams, limit: List(NotDecimal) }, { ...noParams, afterSequence: List(Decimal({ value: 2 })) },
  { ...noParams, nativeTransport: List("true"), afterSequence: List(Decimal({ value: 0 })), limit: List(Decimal({ value: 128 })) },
  { ...noParams, nativeTransport: List("true"), nativeEpoch: List(KnownEpoch({ epoch: 0 })), afterSequence: List(Decimal({ value: 1 })), throughSequence: List(Decimal({ value: 3 })) },
  { ...noParams, nativeTransport: List("true"), afterSequence: List(Decimal({ value: 1 })) }, { ...noParams, nativeTransport: List("true"), category: List("reminder") },
  { ...noParams, nativeTransport: List("true"), limit: List(Decimal({ value: 129 })) }, { ...noParams, nativeTransport: List("1") })
pure def lawRepeatedParameterIsRefused(asked: ListParams, epoch: int, sequence: int): bool =
  (asked.unreadOnly.length() > 1 or asked.limit.length() > 1) implies listRequest(asked, epoch, sequence) == BadQuery
pure def lawUnknownCategoryIsRefused(asked: ListParams, epoch: int, sequence: int): bool =
  asked.category.some(c => not(knownCategories.contains(c))) implies listRequest(asked, epoch, sequence) == BadQuery
pure def lawOwnerLimitIsNeverLowered(asked: ListParams, epoch: int, sequence: int): bool = {
  val r = listRequest(asked, epoch, sequence)
  match r { | OwnerList(q) => (q.pageSize == AllRows and asked.limit.length() == 0) or q.pageSize == AtMost({ rows: decimalOr(asked.limit, 0) }) | _ => true }
}
```

### A native page takes no filter and names its epoch to continue

`nativeTransport=true` asks for core's native page, oldest first. It is
refused with a category, an unread filter or a limit outside 1 to 128
(default 128). A cursor parameter without `nativeTransport=true` is
refused. A page after sequence 0, or with a fixed upper sequence, must
name the epoch it was fenced in; with neither, it begins core's scan of
the current inbox. Core's cursor then decides the page, its fence and an
epoch that changed.

```quint
pure def lawNativePageTakesNoFilter(asked: ListParams, epoch: int, sequence: int): bool =
  (asked.nativeTransport.includes("true") and (asked.category.length() > 0 or asked.unreadOnly.length() > 0)) implies listRequest(asked, epoch, sequence) == BadQuery
pure def lawCursorNeedsNativeTransport(asked: ListParams, epoch: int, sequence: int): bool =
  (not(asked.nativeTransport.includes("true")) and asked.afterSequence.length() > 0) implies listRequest(asked, epoch, sequence) == BadQuery
pure def lawContinuationNamesItsEpoch(asked: ListParams, epoch: int, sequence: int): bool =
  (asked.nativeEpoch.length() == 0 and decimalOr(asked.afterSequence, 0) > 0) implies listRequest(asked, epoch, sequence) == BadQuery
pure def lawFirstNativePageBeginsCoreScan(asked: ListParams, epoch: int, sequence: int): bool = {
  val r = listRequest(asked, epoch, sequence)
  match r { | NativePage(n) => asked.nativeEpoch.length() > 0 or n.query == NC::begin(NC::initial, List(), epoch, sequence, 0, n.limit).pageQuery | _ => true }
}
```

### An owner list holds only visible notices that match its filter, newest first

The list holds the notices core still shows (not past their expiry), only
unread ones with `unreadOnly=true`, only the asked category, and at most
the limit, the newest first. Its `unreadCount` is core's badge count over
the whole inbox, whatever the filter. The reply is
`{notifications, unreadCount, serviceStatus: "ready"}`.

```quint
type Row = { notice: N::Notice, category: str, silent: bool }
pure def matchesList(category: str, unreadOnly: bool, row: Row, now: int): bool =
  N::notificationVisible(row.notice.expiry, now) and not(unreadOnly and row.notice.read) and (category == "" or row.category == category)
pure def withinPage(pageSize: PageSize, newer: int): bool = match pageSize { | AllRows => true | AtMost(p) => newer < p.rows }
pure def ownerRows(notices: List[Row], category: str, unreadOnly: bool, pageSize: PageSize, now: int): List[Row] = {
  val matching = notices.select(row => matchesList(category, unreadOnly, row, now))
  matching.select(row => withinPage(pageSize, matching.select(other => other.notice.sequence > row.notice.sequence).length()))
}
pure def newestFirst(rows: List[Row]): List[Row] = rows.foldl(List(), (acc, row) => List(row).concat(acc))
pure def badgeCount(notices: List[Row], now: int): int = notices.select(row => N::notificationBadge(row.notice.expiry, now, row.notice.read, row.silent)).length()
pure val rowA: Row = { notice: { ...N::emptyNotice, id: "n1", sequence: 1 }, category: "reminder", silent: false }
pure val rowB: Row = { notice: { ...N::emptyNotice, id: "n2", sequence: 2, read: true }, category: "message", silent: false }
pure val rowC: Row = { notice: { ...N::emptyNotice, id: "n3", sequence: 3, expiry: { mode: N::Deadline, at: 1000 } }, category: "reminder", silent: true }
pure val noticesValues = Set(List(), List(rowA), List(rowA, rowB), List(rowA, rowB, rowC))
pure val categoryValues = Set("", "reminder", "message")
pure val pageSizeValues = Set(AllRows, AtMost({ rows: 1 }), AtMost({ rows: 2 }))
pure def lawListedNoticesMatchTheFilter(notices: List[Row], category: str, unreadOnly: bool, pageSize: PageSize, now: int): bool =
  ownerRows(notices, category, unreadOnly, pageSize, now).every(row => matchesList(category, unreadOnly, row, now))
pure def lawListNeverExceedsItsLimit(notices: List[Row], category: str, unreadOnly: bool, rows: int, now: int): bool =
  rows < 1 or ownerRows(notices, category, unreadOnly, AtMost({ rows: rows }), now).length() <= rows
```

### An inbox that is not durably available answers 503, never an empty list

A well-formed request to an inbox that is still starting, has failed or
is closing is answered 503 with `Retry-After`; a failed inbox asks core to
recover it. It never answers an empty list or `ok: false` in its place.
A malformed request is refused first, whatever the inbox's state.

```quint
type InboxStatus = InboxReady | InboxStarting | InboxFailed
type ListAnswer = Refused | Unavailable | Listed({ notices: List[Row], unreadCount: int }) | PagedByCursor
pure def listAnswer(request: ListRequest, availability: InboxStatus, notices: List[Row], now: int): ListAnswer =
  match request {
    | BadQuery => Refused
    | OwnerList(q) => if (availability != InboxReady) Unavailable else Listed({ notices: newestFirst(ownerRows(notices, q.category, q.unreadOnly, q.pageSize, now)), unreadCount: badgeCount(notices, now) })
    | NativePage(n) => if (availability != InboxReady) Unavailable else PagedByCursor
  }
pure val requestValues = Set(BadQuery, OwnerList({ category: "", unreadOnly: false, pageSize: AllRows }), NativePage({ query: { epoch: 0, after: 0, through: 2 }, limit: 128 }))
pure def lawUnavailableInboxListsNothing(request: ListRequest, availability: InboxStatus, notices: List[Row], now: int): bool =
  (availability != InboxReady and request != BadQuery) implies listAnswer(request, availability, notices, now) == Unavailable
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
type MarkReadAnswer = BadNoticeId | MarkedRead({ ok: bool }) | MarkUnavailable
pure def requestedId(requested: NoticeIdText): str = match requested { | NoticeUuid(x) => x.id | NotNoticeUuid => "" }
pure def unreadNotice(notices: List[Row], id: str): bool = notices.some(row => row.notice.id == id and not(row.notice.read))
pure def markReadAnswer(requested: NoticeIdText, availability: InboxStatus, notices: List[Row], writeOutcome: N::WriteOutcome): MarkReadAnswer =
  if (requested == NotNoticeUuid) BadNoticeId
  else if (availability != InboxReady) MarkUnavailable
  else if (not(unreadNotice(notices, requestedId(requested)))) MarkedRead({ ok: false })
  else if (writeOutcome == N::Acknowledged) MarkedRead({ ok: true })
  else MarkUnavailable
pure val requestedValues = Set(NoticeUuid({ id: "n1" }), NoticeUuid({ id: "n2" }), NoticeUuid({ id: "n9" }), NotNoticeUuid)
pure def lawOkMeansThisCallMarkedAnUnreadNotice(requested: NoticeIdText, availability: InboxStatus, notices: List[Row], writeOutcome: N::WriteOutcome): bool =
  markReadAnswer(requested, availability, notices, writeOutcome) == MarkedRead({ ok: true }) implies (availability == InboxReady and unreadNotice(notices, requestedId(requested)) and writeOutcome == N::Acknowledged)
pure def lawUnconfirmedWriteIsNeverAnswered(requested: NoticeIdText, notices: List[Row], writeOutcome: N::WriteOutcome): bool =
  (requested != NotNoticeUuid and unreadNotice(notices, requestedId(requested)) and writeOutcome != N::Acknowledged) implies markReadAnswer(requested, InboxReady, notices, writeOutcome) == MarkUnavailable
pure def lawMalformedIdIsRefused(availability: InboxStatus, notices: List[Row], writeOutcome: N::WriteOutcome): bool =
  markReadAnswer(NotNoticeUuid, availability, notices, writeOutcome) == BadNoticeId
```
