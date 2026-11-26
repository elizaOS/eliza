# Conversations

The owner's conversations on the device. A conversation's record is the
only holder of its room id; every message and model-call log row belongs to
one conversation, and turns add them (`conversation/turns.md`). No rename,
delete, truncate, restore or import. Every route is Root; an unknown
conversation is 404; `before`, `limit` and `offset` are core
[canonical integers](../../core/numbers.md).

## Story: Create and find my conversations

> As the owner, I want to start a conversation and find it again later, so
> that I can go back to what I said.

### Creating a conversation gives it a fresh id and room, and a default title when blank

`POST /api/conversations {title?}` answers `{conversation: {id, roomId,
title, createdAt, updatedAt}}`, its times ISO-8601 strings in UTC, as every
conversation route answers a conversation. The trimmed title has at most
200 UTF-16 units (else 400); a blank one becomes `New Chat`. Ids are never
reused.

```quint
import numbers.* from "../../core/numbers"
type Author = User | Agent
type Body = Said({ text: str }) | Redacted
type Origin = Original | Copied({ fromId: int })
type Message = { id: int, conversationId: int, at: int, author: Author, body: Body, origin: Origin }
type LogRow = { conversationId: int, body: Body }
type Publication = Published | ForkPending
type Title = { text: str, edits: int }
type Conversation = { id: int, title: Title, createdAt: int, updatedAt: int, publication: Publication }
type Fork = { forkId: int, source: int, requestId: str, boundary: int, boundaryAt: int, textDigest: int }
type Conversations = { conversations: List[Conversation], messages: List[Message], log: List[LogRow], forks: List[Fork], nextConversation: int, nextMessage: int, now: int }
pure val initial: Conversations = { conversations: List(), messages: List(), log: List(), forks: List(), nextConversation: 1, nextMessage: 1, now: 0 }
pure val maxTitleUnits = 200
pure val defaultTitle = "New Chat"
pure val titleValues = Set("", "Plans")
pure val titleUnitsValues = Set(0, 5, 201)
pure def canCreate(s: Conversations, title: str, titleUnits: int): bool = titleUnits >= 0 and titleUnits <= maxTitleUnits
pure def create(s: Conversations, title: str, titleUnits: int): Conversations =
  { ...s, conversations: s.conversations.append({ id: s.nextConversation, title: { text: if (title == "") defaultTitle else title, edits: 0 }, createdAt: s.now, updatedAt: s.now, publication: Published }), nextConversation: s.nextConversation + 1 }
pure def alwaysIdsAreFresh(s: Conversations): bool =
  s.nextConversation >= 1 and s.nextMessage >= 1 and s.now >= 0 and
  s.conversations.every(c => c.id >= 1 and c.id < s.nextConversation and c.createdAt <= c.updatedAt and c.updatedAt <= s.now) and
  s.messages.every(m => m.id >= 1 and m.id < s.nextMessage and m.at <= s.now and m.conversationId >= 1 and m.conversationId < s.nextConversation) and
  s.forks.every(f => f.source >= 1 and f.source < f.forkId and f.forkId < s.nextConversation and f.boundary < s.nextMessage and f.boundaryAt <= s.now)
pure def alwaysOneRecordPerConversation(s: Conversations): bool = s.conversations.every(c => s.conversations.select(d => d.id == c.id).length() == 1)
```

### Messages and model-call log rows arrive only in a published conversation

A turn stores a message with a subject (typed text, images, or an accepted
reviewed email or voice-note transcript context; [turn context](./turnContext.md)),
no earlier than the last one, which marks its conversation updated, and
model-call log rows holding its text.

```quint
pure def isPublished(s: Conversations, conversationId: int): bool = s.conversations.some(c => c.id == conversationId and c.publication == Published)
pure val conversationIdValues = Set(1, 2)
pure val textValues = Set("hi", "secret")
pure val atValues = Set(0, 1, 2)
pure def canReceive(s: Conversations, conversationId: int, author: Author, text: str, at: int): bool = isPublished(s, conversationId) and text != "" and at >= s.now
pure def receive(s: Conversations, conversationId: int, author: Author, text: str, at: int): Conversations =
  { ...s, conversations: s.conversations.listMap(c => if (c.id == conversationId) { ...c, updatedAt: at } else c),
    messages: s.messages.append({ id: s.nextMessage, conversationId: conversationId, at: at, author: author, body: Said({ text: text }), origin: Original }), nextMessage: s.nextMessage + 1, now: at }
pure def canLogModelCall(s: Conversations, conversationId: int, text: str): bool = isPublished(s, conversationId) and text != ""
pure def logModelCall(s: Conversations, conversationId: int, text: str): Conversations = { ...s, log: s.log.append({ conversationId: conversationId, body: Said({ text: text }) }) }
```

### The list shows only published conversations, most recently updated first

`GET /api/conversations` orders by `updatedAt`, then the newer id, first.
A fork still being copied is not listed, read or searched.

```quint
pure def listedBefore(first: Conversation, second: Conversation): bool = first.updatedAt > second.updatedAt or (first.updatedAt == second.updatedAt and first.id > second.id)
type Ranking = { rank: int, ranked: List[Conversation] }
pure def ranked(shown: List[Conversation]): List[Conversation] = shown.foldl({ rank: 0, ranked: List() }, (w, c) => { rank: w.rank + 1, ranked: w.ranked.concat(shown.select(d => shown.select(e => listedBefore(e, d)).length() == w.rank)) }).ranked
pure def listing(s: Conversations): List[Conversation] = ranked(s.conversations.select(c => c.publication == Published))
pure val noConversation: Conversation = { id: 0, title: { text: "", edits: 0 }, createdAt: 0, updatedAt: 0, publication: ForkPending }
pure def sometimesOlderConversationListedFirst(s: Conversations): bool = listing(s).nthOr(0, noConversation).id < listing(s).nthOr(1, noConversation).id
pure def sometimesPendingForkUnlisted(s: Conversations): bool = s.conversations.some(c => c.publication == ForkPending) and listing(s).length() >= 1
```

## Story: Read history a page at a time

> As the owner, I want to read a long conversation from its newest
> messages back, so that it opens fast and I can still scroll to the start.

### The first page is the newest 200 messages

History is ordered by `at`, then message id. A read without a cursor
answers the newest 200, and `hasMore` exactly when older messages exist.
A message shows its whole stored text: a text too long to keep inline is
read back whole from its stored segments, and a segment that is missing,
belongs to another room or message, or does not match the text's digest
fails the read rather than showing part of it.

```quint
type Row = { id: int, at: int }
type Page = { rows: List[Row], hasMore: bool }
pure val recentWindow = 200
pure def precedes(a: Row, b: Row): bool = a.at < b.at or (a.at == b.at and a.id < b.id)
pure def newest(rows: List[Row], n: int): List[Row] = rows.select(r => rows.select(x => precedes(r, x)).length() < n)
pure def recentPage(rows: List[Row]): Page = { rows: newest(rows, recentWindow), hasMore: rows.length() > recentWindow }
pure val rowsValues = Set(List(), List({ id: 1, at: 1 }, { id: 2, at: 2 }, { id: 3, at: 2 }), List({ id: 1, at: 1 }, { id: 4, at: 3 }, { id: 5, at: 3 }, { id: 6, at: 4 }))
pure val nValues = Set(0, 1, 2, 50)
pure def lawPageIsTheNewest(rows: List[Row], n: int): bool = rows.every(r => newest(rows, n).includes(r) or newest(rows, n).every(q => precedes(r, q)))
```

### A history row carries its send key only on the owner's message, and a failure kind, what ended its turn and Cloud's funds code only on the agent's reply

Every row is `{id, role, text, timestamp}`, `timestamp` in epoch
milliseconds. The owner's message sent under a `clientMessageId` also
carries that key, so a client finds the row of a turn it stopped
([client turns](../client/turns.md)). An agent reply stored with a failure
kind ([turns](./turns.md)) carries `failureKind`, so a reopened conversation
marks a failed or stopped reply instead of showing it as an answer; one
stored with what ended its turn also carries `abortCause`, and `stopReason`
when it has one. A reply stored with Cloud's own funds code (`cloudCode`,
[turns](./turns.md)) carries it too, and only beside a failure kind, so a
reopened conversation shows an account out of plan allowance and credits
the same way the live reply did. A row never carries the other side's
fields, and carries none when its message has none.

```quint
type RowMarks = { sendKey: str, failed: str, cause: str, cloudCode: str }
pure def rowMarks(author: Author, sendKey: str, failed: str, cause: str, cloudCode: str): RowMarks =
  if (author == User) { sendKey: sendKey, failed: "", cause: "", cloudCode: "" }
  else { sendKey: "", failed: failed, cause: cause, cloudCode: if (failed == "") "" else cloudCode }
pure val sendKeyValues = Set("", "m-1")
pure val failedValues = Set("", "aborted", "insufficient_credits")
pure val causeValues = Set("", "client_left")
pure val cloudCodeValues = Set("", "insufficient_credits", "allowance_exhausted")
pure def lawOnlyTheOwnersRowCarriesASendKey(sendKey: str, failed: str, cause: str, cloudCode: str): bool =
  rowMarks(Agent, sendKey, failed, cause, cloudCode).sendKey == "" and rowMarks(User, sendKey, failed, cause, cloudCode).sendKey == sendKey
pure def lawOnlyTheAgentsRowCarriesAFailureKind(sendKey: str, failed: str, cause: str, cloudCode: str): bool =
  rowMarks(User, sendKey, failed, cause, cloudCode).failed == "" and rowMarks(Agent, sendKey, failed, cause, cloudCode).failed == failed
    and rowMarks(User, sendKey, failed, cause, cloudCode).cause == "" and rowMarks(Agent, sendKey, failed, cause, cloudCode).cause == cause
pure def lawAFundsCodeRidesOnlyWithTheAgentsFailure(sendKey: str, failed: str, cause: str, cloudCode: str): bool =
  rowMarks(User, sendKey, failed, cause, cloudCode).cloudCode == ""
    and rowMarks(Agent, sendKey, failed, cause, cloudCode).cloudCode == (if (failed == "") "" else cloudCode)
```

### An older page holds only messages before its cursor, and hasMore says whether any are left

`?before=<at>&beforeId=<id>&limit=` answers the newest `min(limit, 50)`
messages strictly older than the cursor (50 when `limit` is absent or not
positive); with `beforeId`, messages at the same time with a smaller id are
older too. `beforeId` without `before`, or a `before` that is not a
canonical nonnegative integer, is 400.

```quint
type Cursor = { at: int, keyed: bool, id: int }
type CursorAnswer = NoCursor | AtCursor({ cursor: Cursor }) | BadCursor
pure val olderPageMax = 50
pure def pageSize(limit: int): int = if (limit <= 0 or limit > olderPageMax) olderPageMax else limit
pure def cursorOf(before: IntegerResult, beforeIdGiven: bool, beforeId: int): CursorAnswer = match before {
  | ParsedInteger(b) => if (b.value >= 0) AtCursor({ cursor: { at: b.value, keyed: beforeIdGiven, id: beforeId } }) else BadCursor
  | MissingInteger => if (beforeIdGiven) BadCursor else NoCursor
  | _ => BadCursor
}
pure def olderThan(r: Row, c: Cursor): bool = r.at < c.at or (c.keyed and r.at == c.at and r.id < c.id)
pure def olderPage(rows: List[Row], c: Cursor, limit: int): Page = { rows: newest(rows.select(r => olderThan(r, c)), pageSize(limit)), hasMore: rows.select(r => olderThan(r, c)).length() > pageSize(limit) }
pure val cValues = Set({ at: 2, keyed: true, id: 3 }, { at: 2, keyed: false, id: 3 }, { at: 9, keyed: false, id: 0 })
pure val limitValues = Set(-1, 1, 2, 200)
pure def lawOlderPageIsOlderThanItsCursor(rows: List[Row], c: Cursor, limit: int): bool = olderPage(rows, c, limit).rows.every(r => olderThan(r, c))
pure def lawLastPageHoldsEveryOlderMessage(rows: List[Row], c: Cursor, limit: int): bool =
  not(olderPage(rows, c, limit).hasMore) implies rows.every(r => olderThan(r, c) implies olderPage(rows, c, limit).rows.includes(r))
```

### A jump to a message answers it with up to 100 messages on each side, and an unknown one is 404

`?around=<messageId>` wins over a cursor and reports no `hasMore`.

```quint
type AroundAnswer = AroundUnknown | AroundRows({ rows: List[Row] })
pure val aroundRadius = 100
pure def oldest(rows: List[Row], n: int): List[Row] = rows.select(r => rows.select(x => precedes(x, r)).length() < n)
pure def around(rows: List[Row], pivot: Row, n: int): List[Row] =
  newest(rows.select(r => precedes(r, pivot)), n).concat(List(pivot)).concat(oldest(rows.select(r => precedes(pivot, r)), n))
pure val noMessage: Message = { id: 0, conversationId: 0, at: 0, author: User, body: Redacted, origin: Original }
pure def messageAt(s: Conversations, messageId: int): Message = s.messages.select(m => m.id == messageId).nthOr(0, noMessage)
pure def rowOf(m: Message): Row = { id: m.id, at: m.at }
pure def aroundAnswer(s: Conversations, conversationId: int, messageId: int): AroundAnswer =
  if (not(isPublished(s, conversationId)) or messageAt(s, messageId).conversationId != conversationId) AroundUnknown
  else AroundRows({ rows: around(s.messages.select(m => m.conversationId == conversationId).listMap(m => rowOf(m)), rowOf(messageAt(s, messageId)), aroundRadius) })
pure val pivotValues = Set({ id: 2, at: 2 }, { id: 4, at: 3 })
pure def lawAroundHoldsThePivotAndAtMostNEachSide(rows: List[Row], pivot: Row, n: int): bool = {
  val shown = around(rows, pivot, n)
  (n >= 0 and rows.every(r => rows.select(x => x == r).length() == 1)) implies
    (shown.includes(pivot) and shown.select(r => precedes(r, pivot)).length() <= n and shown.select(r => precedes(pivot, r)).length() <= n)
}
```

### A client pages back only while the agent reports more and the last page added a message

A page without `hasMore`, a page that adds nothing, or reaching the
client's bound ends the read as partial; `hasMore: false` ends it complete.

```quint
type PagingStep = PageAgain | PagingComplete | PagingPartial
type PageReply = { reported: bool, more: bool, fresh: int }
pure def pagingStep(reply: PageReply, held: int, bound: int): PagingStep = if (held >= bound or not(reply.reported)) PagingPartial else if (not(reply.more)) PagingComplete else if (reply.fresh <= 0) PagingPartial else PageAgain
pure val replyValues = Set({ reported: true, more: true, fresh: 3 }, { reported: true, more: true, fresh: 0 }, { reported: true, more: false, fresh: 2 }, { reported: false, more: true, fresh: 3 })
pure val heldValues = Set(0, 200, 2000)
pure val boundValues = Set(2000)
pure def lawPagingAgainNeedsReportedProgress(reply: PageReply, held: int, bound: int): bool = pagingStep(reply, held, bound) == PageAgain implies (reply.reported and reply.more and reply.fresh > 0 and held < bound)
```

### A search page is a slice of the complete set of visible matches

`GET /api/conversations/messages/search?q&limit&offset` needs a `q` of at
least 2 units once trimmed and its whitespace collapsed, and `offset ≥ 0`,
else 400;
`limit` is 20 when absent or not positive and at most 50. Matches are
messages of published conversations that still hold their text, filtered
before the page is cut, so consecutive pages neither skip nor repeat one.

```quint
pure val searchDefault = 20
pure val searchMax = 50
pure val searchMinUnits = 2
pure def searchAdmitted(queryUnits: int, offset: int): bool = queryUnits >= searchMinUnits and offset >= 0
pure def searchSize(limit: int): int = if (limit <= 0) searchDefault else if (limit > searchMax) searchMax else limit
type Taking = { index: int, taken: List[int] }
pure def pageOf(xs: List[int], offset: int, n: int): List[int] =
  xs.foldl({ index: 0, taken: List() }, (w, x) => { index: w.index + 1, taken: if (w.index >= offset and w.index < offset + n) w.taken.append(x) else w.taken }).taken
pure def searchable(s: Conversations, messageId: int): bool = s.messages.some(m => m.id == messageId and isPublished(s, m.conversationId) and m.body != Redacted)
pure def searchPage(s: Conversations, hits: List[int], offset: int, limit: int): List[int] = pageOf(hits.select(h => searchable(s, h)), offset, searchSize(limit))
pure val xsValues = Set(List(), List(7, 8, 9), List(1, 2, 3, 4, 5))
pure val splitValues = Set(0, 1, 2, 4)
pure val moreValues = Set(0, 1, 3)
pure def lawConsecutivePagesJoin(xs: List[int], split: int, more: int): bool = (split >= 0 and more >= 0) implies pageOf(xs, 0, split).concat(pageOf(xs, split, more)) == pageOf(xs, 0, split + more)
```

## Story: Fork a conversation at a message without changing the original

> As the owner, I want to edit something I said earlier in a copy of the
> conversation, so that the original stays as it was.

### A fork starts only at my own message whose stored text is what I saw

`POST /api/conversations/:id/fork {messageId, requestId, expectedText}`
names a message I sent in that conversation (else 404) whose whole stored
text, read back from its segments when it is too long to keep inline,
equals `expectedText` (else 409). The fork keeps the SHA-256 of
`expectedText`, never the text: the same `requestId` with the same message
and digest answers the same fork; with another message or digest it is 409.

```quint
type ForkAnswer = ForkUnknown | ForkTextChanged | ForkRequestChanged | ForkExisting({ forkId: int }) | ForkNew
pure val noFork: Fork = { forkId: 0, source: 0, requestId: "", boundary: 0, boundaryAt: 0, textDigest: 0 }
pure def forkAnswer(s: Conversations, conversationId: int, messageId: int, requestId: str, expectedText: str, textDigest: int): ForkAnswer = {
  val prior = s.forks.select(f => f.source == conversationId and f.requestId == requestId).nthOr(0, noFork)
  val boundary = messageAt(s, messageId)
  if (not(isPublished(s, conversationId))) ForkUnknown
  else if (prior.forkId != 0) (if (prior.boundary == messageId and prior.textDigest == textDigest) ForkExisting({ forkId: prior.forkId }) else ForkRequestChanged)
  else if (boundary.conversationId != conversationId or boundary.author != User) ForkUnknown else if (boundary.body != Said({ text: expectedText })) ForkTextChanged else ForkNew
}
pure def alwaysOneForkPerRequest(s: Conversations): bool = s.forks.every(f => f.forkId >= 1 and s.forks.select(g => g.source == f.source and g.requestId == f.requestId).length() == 1)
```

### A fork copies every message before the chosen one, and only those, before it is listed

The fork, titled `<source title> · edit`, holds a timed copy of each source
message before the chosen one. It is listed only once the copy is stored
whole; a retry of a pending fork publishes the copy already stored. A copy
carries its source message's whole stored content, the stored segments of
a long text or attachment included, and no idempotency marker, so a copy
never answers or recovers a turn of the source.

```quint
pure def conversationOf(s: Conversations, conversationId: int): Conversation = s.conversations.select(c => c.id == conversationId).nthOr(0, noConversation)
pure def beforeBoundary(m: Message, f: Fork): bool = precedes(rowOf(m), { id: f.boundary, at: f.boundaryAt })
pure def copiedFrom(copy: Message, original: Message): bool = copy.origin == Copied({ fromId: original.id })
pure val messageIdValues = Set(1, 2, 3, 4)
pure val requestIdValues = Set("r1", "r2")
pure val expectedTextValues = Set("hi", "secret")
pure val textDigestValues = Set(1, 2)
pure def canFork(s: Conversations, conversationId: int, messageId: int, requestId: str, expectedText: str, textDigest: int): bool = forkAnswer(s, conversationId, messageId, requestId, expectedText, textDigest) == ForkNew
pure def fork(s: Conversations, conversationId: int, messageId: int, requestId: str, expectedText: str, textDigest: int): Conversations = {
  val boundary = messageAt(s, messageId)
  val forkId = s.nextConversation
  val source = conversationOf(s, conversationId)
  val prefix = s.messages.select(m => m.conversationId == conversationId and precedes(rowOf(m), rowOf(boundary)))
  val copies = prefix.foldl(List(), (acc, m) => acc.append({ ...m, id: s.nextMessage + acc.length(), conversationId: forkId, origin: Copied({ fromId: m.id }) }))
  { ...s, conversations: s.conversations.append({ id: forkId, title: { text: source.title.text, edits: source.title.edits + 1 }, createdAt: s.now, updatedAt: s.now, publication: ForkPending }),
    messages: s.messages.concat(copies), forks: s.forks.append({ forkId: forkId, source: conversationId, requestId: requestId, boundary: messageId, boundaryAt: boundary.at, textDigest: textDigest }),
    nextConversation: s.nextConversation + 1, nextMessage: s.nextMessage + prefix.length() }
}
pure val forkIdValues = Set(2, 3)
pure def canFinishFork(s: Conversations, forkId: int): bool = s.conversations.some(c => c.id == forkId and c.publication == ForkPending)
pure def finishFork(s: Conversations, forkId: int): Conversations = { ...s, conversations: s.conversations.listMap(c => if (c.id == forkId) { ...c, publication: Published } else c) }
pure def alwaysForkHoldsTheWholePrefix(s: Conversations): bool = s.forks.every(f =>
  s.messages.every(m => (m.conversationId == f.source and beforeBoundary(m, f)) implies s.messages.some(c => c.conversationId == f.forkId and copiedFrom(c, m))) and
  s.messages.every(c => (c.conversationId == f.forkId and c.origin != Original) implies s.messages.some(m => m.conversationId == f.source and beforeBoundary(m, f) and copiedFrom(c, m))))
pure def alwaysPendingForkHoldsOnlyCopies(s: Conversations): bool = s.messages.every(m => conversationOf(s, m.conversationId).publication == ForkPending implies m.origin != Original)
pure def sometimesForkPublished(s: Conversations): bool = s.forks.some(f => isPublished(s, f.forkId) and s.messages.some(c => c.conversationId == f.forkId and c.origin != Original))
pure def sometimesForkContinues(s: Conversations): bool = s.forks.some(f => s.messages.some(c => c.conversationId == f.forkId and c.origin == Original))
pure val weight_fork = 5
pure val weight_finishFork = 3
```

### No message is ever removed, and only redaction changes one

Every other step leaves each stored message and log row as it was.

```quint
pure def sameExceptBody(a: Message, b: Message): bool = a.id == b.id and a.conversationId == b.conversationId and a.at == b.at and a.author == b.author and a.origin == b.origin
pure def stepOnlyRedactionChangesStoredText(before: Conversations, via: str, after: Conversations): bool =
  before.messages.every(m => after.messages.some(n => sameExceptBody(m, n))) and after.log.length() >= before.log.length() and (via != "redact" implies (before.messages.every(m => after.messages.includes(m)) and before.log.every(r => after.log.includes(r))))
```

## Story: Remove private text I sent by mistake

> As the owner, I want to remove a secret I typed into a conversation, so
> that it is not kept on my device.

### Redacting replaces the message and every exact copy of its text in its conversation with a fixed notice

`POST /api/conversations/:id/messages/:messageId/redact {expectedText}`: a
message of another conversation, or none, is 404; a stored text other than
`expectedText` is 409; a message already redacted answers `unchanged`.
Otherwise the message and every message and model-call log row of that
conversation with exactly its text show `[Private information removed]`.
The whole stored text is compared, and a long text's stored segments are
removed with it. A redacted reply keeps no record of its turn's tools
([planning](./planning.md)), and in any other reply of that conversation
the record's copies of the text show the notice in their place, as in a
log row, a copy the record cut short (the text's first characters and
`…`) included. A number or yes/no argument whose JSON form (`602214`,
`true`) holds the text is a copy too: it is kept as that form written as
text, with the notice in the text's place.

```quint
type RedactAnswer = RedactUnknown | RedactTextChanged | RedactUnchanged | RedactNow
pure val privateNotice = "[Private information removed]"
pure def shownText(b: Body): str = match b { | Said(x) => x.text | Redacted => privateNotice }
pure def redactAnswer(s: Conversations, conversationId: int, messageId: int, expectedText: str): RedactAnswer =
  if (not(isPublished(s, conversationId)) or messageAt(s, messageId).conversationId != conversationId) RedactUnknown
  else if (messageAt(s, messageId).body == Redacted) RedactUnchanged else if (messageAt(s, messageId).body != Said({ text: expectedText })) RedactTextChanged else RedactNow
pure def scrub(messages: List[Message], conversationId: int, text: str): List[Message] =
  messages.listMap(m => if (m.conversationId == conversationId and m.body == Said({ text: text })) { ...m, body: Redacted } else m)
pure def canRedact(s: Conversations, conversationId: int, messageId: int, expectedText: str): bool = redactAnswer(s, conversationId, messageId, expectedText) == RedactNow
pure def redact(s: Conversations, conversationId: int, messageId: int, expectedText: str): Conversations =
  { ...s, messages: scrub(s.messages, conversationId, expectedText), log: s.log.listMap(r => if (r.conversationId == conversationId and r.body == Said({ text: expectedText })) { ...r, body: Redacted } else r) }
pure val messagesValues = Set(List(), List({ id: 1, conversationId: 1, at: 0, author: User, body: Said({ text: "secret" }), origin: Original }, { id: 2, conversationId: 1, at: 1, author: Agent, body: Said({ text: "secret" }), origin: Original }, { id: 3, conversationId: 2, at: 1, author: User, body: Said({ text: "secret" }), origin: Original }))
pure def lawScrubLeavesNoCopyInTheConversation(messages: List[Message], conversationId: int, text: str): bool =
  scrub(messages, conversationId, text).every(m => m.conversationId == conversationId implies m.body != Said({ text: text }))
pure def lawScrubLeavesOtherConversations(messages: List[Message], conversationId: int, text: str): bool =
  scrub(messages, conversationId, text).every(m => m.conversationId != conversationId implies messages.includes(m))
pure def sometimesCopyRedactedWithIt(s: Conversations): bool = s.messages.select(m => m.body == Redacted).length() >= 2 and s.log.some(r => r.body == Redacted)
pure val weight_redact = 3
```
