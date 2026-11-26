# Managed Gmail reads

The owner's mail, read through the grant of [the connection](./connection.md)
(develop `agent-google-connector/{gmail.ts,inbox-provider.ts}`). Routes, by
device key or session, `side` only `owner`, grant chosen by `connection`'s
selection rule: `GET /api/v1/eliza/google/gmail/{triage,search,read}` and
`GET …/gmail/inbox-v1/{capabilities,thread,attachment,drafts,draft}`. This
library decides what a read may answer; the shell calls Google and renders
the wire. [The reviewed operations](./mailOperations.md) reuse its revision
check, mail cap and operation kinds.

## Story: Read my mail through the grant I chose

> As an owner, I want my assistant to triage, search and read my mail through
> the Google grant I chose, each answer whole or refused, so that it never
> acts on a message it saw only in part or at another revision.

### A read needs a usable connection that holds the Gmail scope of its surface

Triage reads headers, so `gmail.metadata` is enough; search, message,
thread and attachment reads need the body (`gmail.readonly` or
`gmail.modify`); the drafts surfaces need `gmail.compose` or `gmail.modify`;
capabilities need only the connection. A refused read answers
`connection`'s use refusal, after its refresh.

```quint
import types.* from "../../shared/types"
import connection as C from "./connection"
type MailSurface = TriageSurface | SearchSurface | MessageSurface | ThreadSurface | AttachmentSurface | DraftsSurface | DraftSurface | CapabilitiesSurface
pure val allSurfaces: List[MailSurface] = List(TriageSurface, SearchSurface, MessageSurface, ThreadSurface, AttachmentSurface, DraftsSurface, DraftSurface, CapabilitiesSurface)
pure def surfaceScopes(surface: MailSurface): List[C::GoogleScope] =
  if (surface == TriageSurface) List(C::ScopeGmailMetadata, C::ScopeGmailReadonly, C::ScopeGmailModify)
  else if (surface == DraftsSurface or surface == DraftSurface) List(C::ScopeGmailCompose, C::ScopeGmailModify)
  else List(C::ScopeGmailReadonly, C::ScopeGmailModify)
pure def surfaceHeld(surface: MailSurface, scopes: List[C::GoogleScope]): bool =
  surface == CapabilitiesSurface or surfaceScopes(surface).some(x => scopes.includes(x))
pure def readAllowed(surface: MailSurface, status: C::ConnectionStatus, access: C::AccessState, scopes: List[C::GoogleScope]): bool =
  C::useAllowed(status, access, surfaceHeld(surface, scopes))
pure def readRefusal(surface: MailSurface, status: C::ConnectionStatus, access: C::AccessState, scopes: List[C::GoogleScope]): Refusal =
  C::useRefusal(status, access, surfaceHeld(surface, scopes))
pure val scopesValues = Set(List(), List(C::ScopeGmailMetadata), List(C::ScopeGmailReadonly), List(C::ScopeGmailCompose), List(C::ScopeGmailModify), List(C::ScopeGmailSend, C::ScopeCalendarEvents))
pure def lawAReadNeedsTheCapabilityTheStatusReports(surface: MailSurface, scopes: List[C::GoogleScope]): bool =
  (surface != CapabilitiesSurface and surfaceHeld(surface, scopes)) implies
    C::capabilitiesOf(scopes).includes(if (surface == DraftsSurface or surface == DraftSurface) C::GmailDrafts else C::GmailTriage)
```

### A list asks for a count within its bounds, and a count outside them is refused rather than clamped

Triage defaults to 12 and allows at most 50; search defaults to 50 and allows
at most 100. A count that is not a canonical positive integer, or is over the
bound, is `400 invalid_request`.

```quint
type MailList = TriageList | SearchList
type RequestedCount = CountOmitted | CountGiven({ count: int })
type CountAnswer = CountAccepted({ accepted: int }) | CountRefused
pure def countBound(list: MailList): int = if (list == TriageList) 50 else 100
pure def countDefault(list: MailList): int = if (list == TriageList) 12 else 50
pure def listCount(list: MailList, requested: RequestedCount): CountAnswer = match requested {
  | CountOmitted => CountAccepted({ accepted: countDefault(list) })
  | CountGiven(r) => if (r.count >= 1 and r.count <= countBound(list)) CountAccepted({ accepted: r.count }) else CountRefused
}
pure val requestedValues = Set(CountOmitted, CountGiven({ count: 0 }), CountGiven({ count: 1 }), CountGiven({ count: 50 }), CountGiven({ count: 51 }), CountGiven({ count: 100 }), CountGiven({ count: 101 }))
pure def lawAnAcceptedCountIsWithinItsBound(list: MailList, requested: RequestedCount): bool = { val answer = listCount(list, requested)
  match answer {
  | CountAccepted(a) => a.accepted >= 1 and a.accepted <= countBound(list)
  | CountRefused => requested != CountOmitted
} }
```

### Triage scores each inbox message by fixed signal weights, and a message likely needing a reply outranks all automated mail

Triage uses Inbox by default. The owner's Inbox, Sent, Drafts or Trash may be
selected with a search and provider continuation. The response names the
authorized Cloud account, selected folder and trimmed search. Every message
retains its provider ID, including the ID used by Grace to reopen it. The
default triage lists the newest Inbox messages that are not in Trash, each
`{id, threadId, subject, from, to, cc, snippet, receivedAt, labels, isUnread,
isImportant, likelyReplyNeeded, triageScore, triageReason, metadata:
{historyId}}`, ordered by score, then newest first. Unread adds 30, the
`IMPORTANT` label 35, being addressed in To or Cc (the grant's address,
trimmed and lower-cased) 15, a likely reply 30; an automated sender
(no-reply, notification or mailer-daemon address, `List-Id`, `Precedence`
bulk, list or junk, or `Auto-Submitted` other than `no`) takes 25 and mail
sent by the owner 60; the score is never below 0. `triageReason` joins the
reasons that applied with `, `, or is `recent inbox message`.

```quint
type TriageSignals = { unread: bool, labelledImportant: bool, addressed: bool, automated: bool, fromSelf: bool }
type TriageReason = TriageUnread | TriageImportantLabel | TriageAddressed | TriageNeedsReply | TriageAutomated | TriageSentBySelf
pure def needsReply(signals: TriageSignals): bool = not(signals.automated) and not(signals.fromSelf) and signals.unread and signals.addressed
pure def triageImportant(signals: TriageSignals): bool = signals.labelledImportant or needsReply(signals)
pure def triageScore(signals: TriageSignals): int = {
  val sum = (if (signals.unread) 30 else 0) + (if (signals.labelledImportant) 35 else 0) + (if (signals.addressed) 15 else 0)
    + (if (needsReply(signals)) 30 else 0) - (if (signals.automated) 25 else 0) - (if (signals.fromSelf) 60 else 0)
  if (sum < 0) 0 else sum
}
pure def reasonApplies(signals: TriageSignals, reason: TriageReason): bool =
  if (reason == TriageUnread) signals.unread else if (reason == TriageImportantLabel) signals.labelledImportant else if (reason == TriageAddressed) signals.addressed
  else if (reason == TriageNeedsReply) needsReply(signals) else if (reason == TriageAutomated) signals.automated else signals.fromSelf
pure def triageReasons(signals: TriageSignals): List[TriageReason] =
  List(TriageUnread, TriageImportantLabel, TriageAddressed, TriageNeedsReply, TriageAutomated, TriageSentBySelf).select(r => reasonApplies(signals, r))
pure val signalsValues: Set[TriageSignals] = {
  val quiet: TriageSignals = { unread: false, labelledImportant: false, addressed: false, automated: false, fromSelf: false }
  Set(quiet, { ...quiet, unread: true, addressed: true }, { ...quiet, unread: true, labelledImportant: true, addressed: true, automated: true },
    { ...quiet, unread: true, addressed: true, fromSelf: true }, { ...quiet, automated: true, fromSelf: true }, { ...quiet, labelledImportant: true })
}
pure val otherValues = signalsValues
pure def lawAReplyNeededOutranksAutomatedMail(signals: TriageSignals, other: TriageSignals): bool =
  (needsReply(signals) and other.automated) implies triageScore(signals) > triageScore(other)
pure def lawAScoreIsWithinItsRange(signals: TriageSignals): bool =
  triageScore(signals) >= 0 and triageScore(signals) <= 110 and (triageReasons(signals) == List() implies triageScore(signals) == 0)
```

### A message row hints at attachments from the outer MIME part

A message row carries `hasAttachments` when the outer Gmail part is
`multipart/mixed` or names a file. The MIME type comes from the part
or, if absent, its already requested `Content-Type` metadata header.
Listing continues to read metadata only. The row hint is approximate.
Opening the message reads its exact attachment descriptors.

```quint
pure def attachmentHint(mixedOuter: bool, namedFile: bool): bool = mixedOuter or namedFile
pure def lawNoOuterHintHasNoPaperclip(mixedOuter: bool, namedFile: bool): bool =
  (not(mixedOuter) and not(namedFile)) implies not(attachmentHint(mixedOuter, namedFile))
```

### A search page names the mailbox revision read before it was listed and never continues at the token it was asked with

The query is non-blank and a page token is 1 to 4,096 characters. The shell
reads the mailbox `historyId` (1 to 20 digits) first, then lists; two pages
of one search with different revisions came from a changed mailbox. A
Google answer without a revision, or whose next token repeats the one asked,
is `502 provider_invalid_response`.

```quint
type Continuation = NoContinuation | ContinueAt({ pageToken: str })
type SearchOutcome = SearchServed({ mailboxRevision: str }) | SearchRefused({ refusal: Refusal })
pure def searchOutcome(asked: Continuation, answered: Continuation, mailboxRevision: str): SearchOutcome =
  if (mailboxRevision == "" or (answered != NoContinuation and answered == asked)) SearchRefused({ refusal: refuse(ProviderInvalidResponse) })
  else SearchServed({ mailboxRevision: mailboxRevision })
pure val askedValues = Set(NoContinuation, ContinueAt({ pageToken: "p1" }), ContinueAt({ pageToken: "p2" }))
pure val answeredValues = askedValues
pure val mailboxRevisionValues = Set("", "41", "42")
pure def lawASearchPageNeverLoops(asked: Continuation, answered: Continuation, mailboxRevision: str): bool = { val result = searchOutcome(asked, answered, mailboxRevision)
  match result {
  | SearchServed(p) => p.mailboxRevision != "" and (answered == NoContinuation or answered != asked)
  | SearchRefused(r) => wellFormed(r.refusal) and not(retryableOf(r.refusal))
} }
```

### A message read answers the message whole, with inert HTML whole or absent, or is refused as too large

`read(messageId)` answers the triage row of the message, `bodyText` (the
plain part, else the HTML part as text, else the snippet), `bodyHtml` and
`bodyHtmlStatus` (`available`, `none`, `too_large`), its links, its
attachment descriptors and `authenticationResults`: the Authentication-Results
header Google's receiving server wrote, or null when the read cannot tell it
from one a sender wrote. That header is the first one, it names
`mx.google.com`, and it sits below the topmost Received header that says
where the message came from, which says `mx.google.com` took the message by
SMTP, with no other Received header between them. Mail that Gmail fetched by
POP carries a receipt of another kind on top and answers null; mail the
owner imported keeps the trace it came with. The cloud vouches for nothing
in the header; it only says which one Google wrote.
The HTML is served as text and never fetched or run by the cloud; over
512 KiB, or past 200 MIME parts, it is left out with `too_large` while the
text stays whole. Text over the 8 MiB mail cap is
`413 content_too_large`, never cut. Google answering another message is
`502`; a connection that changed during the read is `409 stale_revision`.

```quint
type HtmlView = HtmlAvailable | HtmlAbsent | HtmlTooLarge
type MessageFetch = { sameMessage: bool, grantUnchanged: bool, textBytes: int, htmlBytes: int, partsWithinLimit: bool }
type ReadOutcome = MessageServed({ html: HtmlView }) | ReadRefused({ refusal: Refusal })
pure val mebibyte: int = 1048576
pure val mailMaxBytes: int = 8 * mebibyte
pure val htmlMaxBytes: int = 512 * 1024
pure def htmlViewOf(htmlBytes: int, partsWithinLimit: bool): HtmlView =
  if (not(partsWithinLimit) or htmlBytes > htmlMaxBytes) HtmlTooLarge else if (htmlBytes <= 0) HtmlAbsent else HtmlAvailable
pure def readOutcome(got: MessageFetch): ReadOutcome =
  if (not(got.sameMessage)) ReadRefused({ refusal: refuse(ProviderInvalidResponse) })
  else if (not(got.grantUnchanged)) ReadRefused({ refusal: refuse(StaleRevision) })
  else if (got.textBytes > mailMaxBytes) ReadRefused({ refusal: refuse(ContentTooLarge) })
  else MessageServed({ html: htmlViewOf(got.htmlBytes, got.partsWithinLimit) })
pure val gotValues: Set[MessageFetch] = {
  val ok: MessageFetch = { sameMessage: true, grantUnchanged: true, textBytes: 10, htmlBytes: 0, partsWithinLimit: true }
  Set(ok, { ...ok, htmlBytes: 524288 }, { ...ok, htmlBytes: 524289 }, { ...ok, partsWithinLimit: false, htmlBytes: 5 }, { ...ok, textBytes: 8388609 }, { ...ok, sameMessage: false }, { ...ok, grantUnchanged: false })
}
pure def lawAServedMessageIsWhole(got: MessageFetch): bool = { val result = readOutcome(got)
  match result {
  | MessageServed(m) => got.sameMessage and got.grantUnchanged and got.textBytes <= mailMaxBytes and (m.html == HtmlAvailable implies (got.htmlBytes > 0 and got.htmlBytes <= htmlMaxBytes))
  | ReadRefused(r) => wellFormed(r.refusal) and not(retryableOf(r.refusal))
} }
```

### Reading a message reports the Reply-To mailbox when one was set

The reply address is separate from the sender displayed on the message.
The full message and its thread page omit the address when there is no
Reply-To header, return the single address when the composer accepts it,
and return null when the header cannot be used to reply.

```quint
type ReplyAddress = NoReplyOverride | ReplyOverrideUnavailable | ReplyOverride
pure def replyAddressOf(headerCount: int, usableMailbox: bool): ReplyAddress =
  if (headerCount <= 0) NoReplyOverride
  else if (headerCount == 1 and usableMailbox) ReplyOverride
  else ReplyOverrideUnavailable
pure val headerCountValues = Set(0, 1, 2)
pure def lawAnOverrideIsOneUsableMailbox(headerCount: int, usableMailbox: bool): bool =
  (replyAddressOf(headerCount, usableMailbox) == ReplyOverride) iff (headerCount == 1 and usableMailbox)
```

### A thread page is served only at the revision of its first page and covers the thread without a gap

A page starts at the offset asked for and holds at most 25 messages, oldest
first, as many as fit 1.5 MiB; `nextOffset` is its end while messages remain.
Each message carries its own `historyId`, `bodyText` and inert HTML as a
message read does. A page after the first must name the thread `historyId`
of the first: none is `400`, another is `409 stale_revision`. An offset
outside the thread is `400`; a thread over 2,000 messages, a message over
the mail cap, or one that alone does not fit a page is `413`.

```quint
type Revision = AnyRevision | AtRevision({ historyId: str })
type NextOffset = ThreadEnd | NextAt({ nextOffset: int })
type ThreadAsk = { offset: int, asked: Revision }
type ThreadSnapshot = { threadRevision: str, total: int, fitting: int, oversized: bool }
type ThreadOutcome = ThreadServed({ first: int, count: int, rest: NextOffset }) | ThreadRefused({ refusal: Refusal })
pure val threadPageMax: int = 25
pure val threadMaxMessages: int = 2000
pure def minOf(x: int, y: int): int = if (x < y) x else y
pure def threadOutcome(ask: ThreadAsk, snapshot: ThreadSnapshot): ThreadOutcome = {
  val asked = ask.asked
  val stale = match asked { | AtRevision(r) => r.historyId != snapshot.threadRevision | AnyRevision => false }
  val fit = minOf(minOf(threadPageMax, snapshot.total - ask.offset), snapshot.fitting)
  val count = if (fit < 0) 0 else fit
  if (ask.offset < 0 or ask.offset > snapshot.total or (ask.offset > 0 and ask.asked == AnyRevision)) ThreadRefused({ refusal: refuse(InvalidRequest) })
  else if (stale) ThreadRefused({ refusal: refuse(StaleRevision) })
  else if (snapshot.total > threadMaxMessages or snapshot.oversized or (ask.offset < snapshot.total and count < 1)) ThreadRefused({ refusal: refuse(ContentTooLarge) })
  else ThreadServed({ first: ask.offset, count: count, rest: if (ask.offset + count < snapshot.total) NextAt({ nextOffset: ask.offset + count }) else ThreadEnd })
}
pure val askValues = Set({ offset: 0, asked: AnyRevision }, { offset: 25, asked: AnyRevision }, { offset: 25, asked: AtRevision({ historyId: "7" }) }, { offset: 25, asked: AtRevision({ historyId: "8" }) }, { offset: 31, asked: AtRevision({ historyId: "7" }) })
pure val snapshotValues = Set({ threadRevision: "7", total: 30, fitting: 25, oversized: false }, { threadRevision: "7", total: 30, fitting: 3, oversized: false }, { threadRevision: "7", total: 30, fitting: 0, oversized: false },
  { threadRevision: "7", total: 2001, fitting: 25, oversized: false }, { threadRevision: "7", total: 30, fitting: 25, oversized: true }, { threadRevision: "7", total: 0, fitting: 0, oversized: false })
pure def lawAThreadPageLiesInsideTheThreadAndEndsWhereTheNextBegins(ask: ThreadAsk, snapshot: ThreadSnapshot): bool = { val result = threadOutcome(ask, snapshot)
  match result {
  | ThreadServed(p) => p.first >= 0 and p.count >= 0 and p.count <= threadPageMax and p.first + p.count <= snapshot.total
      and (p.rest == ThreadEnd iff p.first + p.count == snapshot.total) and (p.rest != ThreadEnd implies (p.count >= 1 and p.rest == NextAt({ nextOffset: p.first + p.count })))
  | ThreadRefused(r) => wellFormed(r.refusal) and not(retryableOf(r.refusal))
} }
pure def lawALaterPageIsServedOnlyAtTheFirstPagesRevision(ask: ThreadAsk, snapshot: ThreadSnapshot): bool = { val result = threadOutcome(ask, snapshot)
  match result {
  | ThreadServed(p) => p.first > 0 implies ask.asked == AtRevision({ historyId: snapshot.threadRevision })
  | ThreadRefused(r) => true
} }
```

### An attachment is served only at the message revision it was read at, as the exact bytes Google declared, within the mail cap

`GET attachment {messageId, partId, historyId}` answers `{version: 1,
messageId, partId, historyId, name, mimeType, size, dataBase64, sha256}`, the
SHA-256 of the decoded bytes in hex, for a part of any type. A message
changed since that read is `409 stale_revision`; no single part with that
id is `404 not_found`; a part over 8 MiB is `413`; bytes that do not count
to the declared size are `502`. A reviewed forward binds its attachments the
same way.

```quint
type PartFetch = { readAt: str, currentRevision: str, matchingParts: int, declaredBytes: int, fetchedBytes: int }
type AttachmentOutcome = AttachmentServed({ bytes: int }) | AttachmentRefused({ refusal: Refusal })
pure def revisionHeld(readAt: str, currentRevision: str): bool = readAt != "" and readAt == currentRevision
pure def withinMailCap(bytes: int): bool = bytes >= 0 and bytes <= mailMaxBytes
pure def attachmentOutcome(part: PartFetch): AttachmentOutcome =
  if (not(revisionHeld(part.readAt, part.currentRevision))) AttachmentRefused({ refusal: refuse(StaleRevision) })
  else if (part.matchingParts != 1) AttachmentRefused({ refusal: refuse(NotFound) })
  else if (not(withinMailCap(part.declaredBytes))) AttachmentRefused({ refusal: refuse(ContentTooLarge) })
  else if (part.fetchedBytes != part.declaredBytes) AttachmentRefused({ refusal: refuse(ProviderInvalidResponse) })
  else AttachmentServed({ bytes: part.fetchedBytes })
pure val partValues: Set[PartFetch] = {
  val ok: PartFetch = { readAt: "9", currentRevision: "9", matchingParts: 1, declaredBytes: 100, fetchedBytes: 100 }
  Set(ok, { ...ok, currentRevision: "10" }, { ...ok, readAt: "", currentRevision: "" }, { ...ok, matchingParts: 0 }, { ...ok, matchingParts: 2 }, { ...ok, declaredBytes: 8388609, fetchedBytes: 8388609 }, { ...ok, fetchedBytes: 99 })
}
pure def lawAServedAttachmentIsTheDeclaredPartAtItsRevision(part: PartFetch): bool = { val result = attachmentOutcome(part)
  match result {
  | AttachmentServed(a) => revisionHeld(part.readAt, part.currentRevision) and part.matchingParts == 1 and withinMailCap(a.bytes) and a.bytes == part.declaredBytes
  | AttachmentRefused(r) => wellFormed(r.refusal) and not(retryableOf(r.refusal))
} }
```

### A draft is opened from one snapshot with the digest of its raw message, or refused

A drafts page holds at most 25 drafts `{draftId, messageId, subject, to,
snippet, updatedAt}` without bodies (a longer Google page is `502`). A draft
answers `{id, messageId, providerDigest, content}`, the digest of the raw
message read in the snapshot of the content; raw and full reads of
different messages are `409 stale_revision`. A draft the cloud cannot
reproduce exactly (encoded subject, body not decodable losslessly or held
as a part) is `400 invalid_request`; a body over the mail cap is `413`.

```quint
type DraftSnapshot = { rawMessageId: str, fullMessageId: str, reproducible: bool, bodyBytes: int }
type DraftOutcome = DraftServed({ messageId: str }) | DraftRefused({ refusal: Refusal })
pure val draftsPageMax: int = 25
pure def draftOutcome(draft: DraftSnapshot): DraftOutcome =
  if (draft.rawMessageId == "" or draft.rawMessageId != draft.fullMessageId) DraftRefused({ refusal: refuse(StaleRevision) })
  else if (not(draft.reproducible)) DraftRefused({ refusal: refuse(InvalidRequest) })
  else if (not(withinMailCap(draft.bodyBytes))) DraftRefused({ refusal: refuse(ContentTooLarge) })
  else DraftServed({ messageId: draft.rawMessageId })
pure val draftValues = Set({ rawMessageId: "m1", fullMessageId: "m1", reproducible: true, bodyBytes: 10 }, { rawMessageId: "m1", fullMessageId: "m2", reproducible: true, bodyBytes: 10 },
  { rawMessageId: "m1", fullMessageId: "m1", reproducible: false, bodyBytes: 10 }, { rawMessageId: "m1", fullMessageId: "m1", reproducible: true, bodyBytes: 8388609 })
pure def lawADraftIsServedFromOneSnapshot(draft: DraftSnapshot): bool = { val result = draftOutcome(draft)
  match result {
  | DraftServed(d) => d.messageId == draft.rawMessageId and d.messageId == draft.fullMessageId and draft.reproducible and withinMailCap(draft.bodyBytes)
  | DraftRefused(r) => wellFormed(r.refusal) and not(retryableOf(r.refusal))
} }
```

### Capabilities offer exactly the reads and changes the grant allows, and each change comes with the read its review needs

`GET capabilities` answers `{version: 1, from, reads, kinds,
attachmentPolicy: {mimeTypes, maxBytes}, providerExactlyOnce: false}`:
`reads` are the surfaces the scopes hold, `kinds` the operation kinds whose
capability the grant holds (send needs `google.gmail.send`, the draft kinds
`google.gmail.drafts`, the others `google.gmail.manage`), `mimeTypes` PDF,
PNG, JPEG, WebP and plain text, `maxBytes` the mail cap.

```quint
type MailOperationKind = SendKind | DraftCreateKind | DraftReplaceKind | DraftDeleteKind | ArchiveKind | UnarchiveKind | TrashKind | UntrashKind | MarkReadKind | MarkUnreadKind | StarKind | UnstarKind
type AttachmentMime = MimePdf | MimePng | MimeJpeg | MimeWebp | MimeText
pure val allOperationKinds: List[MailOperationKind] = List(SendKind, DraftCreateKind, DraftReplaceKind, DraftDeleteKind, ArchiveKind, UnarchiveKind, TrashKind, UntrashKind, MarkReadKind, MarkUnreadKind, StarKind, UnstarKind)
pure val attachmentMimes: List[AttachmentMime] = List(MimePdf, MimePng, MimeJpeg, MimeWebp, MimeText)
pure def isDraftKind(kind: MailOperationKind): bool = kind == DraftCreateKind or kind == DraftReplaceKind or kind == DraftDeleteKind
pure def kindNeeds(kind: MailOperationKind): C::GoogleCapability = if (kind == SendKind) C::GmailSend else if (isDraftKind(kind)) C::GmailDrafts else C::GmailManage
pure def offeredKinds(scopes: List[C::GoogleScope]): List[MailOperationKind] = allOperationKinds.select(k => C::capabilitiesOf(scopes).includes(kindNeeds(k)))
pure def offeredReads(scopes: List[C::GoogleScope]): List[MailSurface] = allSurfaces.select(s => surfaceHeld(s, scopes))
pure def lawEveryOfferedChangeComesWithTheReadItsReviewNeeds(kind: MailOperationKind, scopes: List[C::GoogleScope]): bool =
  offeredKinds(scopes).includes(kind) implies
    (if (kind == SendKind) true else if (isDraftKind(kind)) offeredReads(scopes).includes(DraftSurface) else offeredReads(scopes).includes(MessageSurface) and offeredReads(scopes).includes(ThreadSurface))
```

## Story: Notice new mail while I sign in privately

> As an owner signing in on a website, I can start a short watch for new
> mail in my connected inbox. If mail arrives, I can open my inbox and
> return to the website to finish signing in myself.

### A watch uses one current Gmail grant and one five-minute baseline

An authenticated client calls `GET …/gmail/inbox-v1/arrival`. The browser
must name a usable Gmail read grant. An authenticated device may omit the
grant and use the owner's active Gmail connection. Starting a watch
answers `arrived: false` and a sealed cursor for the provider's current
history position. The cursor binds the deployment, owner, organization,
grant and exact device key or browser access credential. Invalid or
expired cursors stop before provider access. Polling returns the same
cursor and does not advance the baseline or extend the original deadline.
There is no server-side watch to update or recover. Concurrent polls and
retries can observe different provider snapshots against the same baseline.

```quint
type InboxWatch = { historyId: str, expiresAt: int }
type InboxWatchCaller = BrowserWatch | DeviceWatch
pure val inboxWatchWindowMs = 300000
pure def inboxWatchSelectionAllowed(caller: InboxWatchCaller, selected: bool): bool =
  selected or caller == DeviceWatch
pure def startInboxWatch(historyId: str, startedAt: int): InboxWatch =
  { historyId: historyId, expiresAt: startedAt + inboxWatchWindowMs }
pure def inboxWatchCurrent(watch: InboxWatch, nowAt: int): bool =
  nowAt >= watch.expiresAt - inboxWatchWindowMs and nowAt < watch.expiresAt
pure val historyIdValues = Set("1", "10000000000000000001")
pure val startedAtValues = Set(0, 1000)
pure val nowAtValues = Set(0, 999, 1000, 299999, 300000, 301000)
pure val watchValues = Set(startInboxWatch("1", 0), startInboxWatch("10000000000000000001", 1000))
pure def lawBrowserWatchRequiresSelection(selected: bool): bool =
  inboxWatchSelectionAllowed(BrowserWatch, selected) iff selected
pure def lawWatchHasOneWindow(historyId: str, startedAt: int, nowAt: int): bool = {
  val opened = startInboxWatch(historyId, startedAt)
  opened.historyId == historyId and
    (inboxWatchCurrent(opened, nowAt) iff (nowAt >= startedAt and nowAt - startedAt < inboxWatchWindowMs))
}
```

### A poll reports only Inbox message additions under current authorization

The provider request asks for Inbox message-added history after the baseline
and only requests history and message identifiers. The caller gets only the
sealed cursor and the arrival flag. A valid page with a message addition
can answer true. An empty page answers false only at the end of the history.
Continue through at most eight pages using fresh tokens. An invalid page,
repeated continuation or exhausted page budget refuses instead of reporting
false. Each provider request and body read has a timeout, so progress does
not require another client poll or an unlimited provider response.

The service rechecks the grant and the caller after the provider returns. It
answers successfully only before the original deadline and while the
request is live. The shell checks the cryptographic binding, provider
payload and authorization. The model represents these checks by their
results and covers the deadline boundaries and the first, last and
out-of-range page counts.

```quint
type InboxContinuation = EndOfHistory | FreshPageToken | InvalidPageToken
type InboxPageOutcome = ArrivalFound | NoArrival | ReadNextPage | RefusePage
pure val inboxWatchPageLimit = 8
pure def inboxPageOutcome(pageCount: int, validPage: bool, hasArrival: bool, continuation: InboxContinuation): InboxPageOutcome =
  if (not(validPage) or pageCount < 1 or pageCount > inboxWatchPageLimit) RefusePage
  else if (hasArrival) ArrivalFound
  else if (continuation == EndOfHistory) NoArrival
  else if (continuation == FreshPageToken and pageCount < inboxWatchPageLimit) ReadNextPage
  else RefusePage
pure def inboxWatchCanAnswer(watch: InboxWatch, nowAt: int, grantCurrent: bool, callerCurrent: bool, requestLive: bool): bool =
  inboxWatchCurrent(watch, nowAt) and grantCurrent and callerCurrent and requestLive
pure val pageCountValues = Set(0, 1, 7, 8, 9)
pure def lawAnEmptyAnswerRequiresCompleteHistory(pageCount: int, validPage: bool, hasArrival: bool, continuation: InboxContinuation): bool =
  inboxPageOutcome(pageCount, validPage, hasArrival, continuation) == NoArrival implies
    (validPage and not(hasArrival) and continuation == EndOfHistory)
pure def lawAnArrivalRequiresProviderEvidence(pageCount: int, validPage: bool, hasArrival: bool, continuation: InboxContinuation): bool =
  inboxPageOutcome(pageCount, validPage, hasArrival, continuation) == ArrivalFound implies (validPage and hasArrival)
pure def lawTheLastPageDoesNotContinue(pageCount: int, validPage: bool, hasArrival: bool, continuation: InboxContinuation): bool =
  inboxPageOutcome(pageCount, validPage, hasArrival, continuation) == ReadNextPage implies
    (validPage and not(hasArrival) and continuation == FreshPageToken and pageCount < inboxWatchPageLimit)
pure def lawNoAnswerAfterAuthorityEnds(watch: InboxWatch, nowAt: int, grantCurrent: bool, callerCurrent: bool, requestLive: bool): bool =
  (not(grantCurrent) or not(callerCurrent) or not(requestLive) or nowAt >= watch.expiresAt) implies
    not(inboxWatchCanAnswer(watch, nowAt, grantCurrent, callerCurrent, requestLive))
```

## Story: Hear about new mail while my phone is idle

> As an owner, I want my phone to check the Gmail account I chose in the
> background and tell me when new inbox mail arrives, from the mailbox's own
> change history, so that a notice never claims mail the phone did not see
> and the cloud keeps no watch for me.

### A background history read names one grant and a count within its bound, and continues only from the start it began at

`GET …/gmail/inbox-v1/history` admits an account session or a device mail
lease. Existing background checks use `GET …/gmail/history` with their
original device credential. Both reads take `grantId`, which they require,
`startHistoryId` (1 to 20 digits, no leading zero), `pageToken` (1 to 4,096
characters, only beside the start it continues), `maxResults` (1 to 100,
50 when omitted) and `side`, only `owner`. Any other parameter, or one given
twice, is `400 invalid_request`. The cloud checks that the named grant
belongs to the current user and organization before contacting Google.
A grant belonging to another owner returns `404 not_found`. Reading history
needs a Gmail triage scope.

```quint
type HistoryAsk = { grantNamed: bool, started: bool, startDigits: bool, continued: bool, tokenWithinBound: bool, eachKnownOnce: bool }
pure val historyCountMax: int = 100
pure val historyCountDefault: int = 50
pure def historyCount(requested: RequestedCount): CountAnswer = match requested {
  | CountOmitted => CountAccepted({ accepted: historyCountDefault })
  | CountGiven(r) => if (r.count >= 1 and r.count <= historyCountMax) CountAccepted({ accepted: r.count }) else CountRefused
}
pure def historyAskAccepted(historyAsk: HistoryAsk, requested: RequestedCount): bool =
  historyAsk.grantNamed and historyAsk.eachKnownOnce and (not(historyAsk.started) or historyAsk.startDigits)
    and (not(historyAsk.continued) or (historyAsk.started and historyAsk.tokenWithinBound)) and historyCount(requested) != CountRefused
pure val historyAskValues: Set[HistoryAsk] = {
  val first: HistoryAsk = { grantNamed: true, started: false, startDigits: false, continued: false, tokenWithinBound: false, eachKnownOnce: true }
  val paged: HistoryAsk = { ...first, started: true, startDigits: true }
  Set(first, paged, { ...paged, continued: true, tokenWithinBound: true }, { ...first, continued: true, tokenWithinBound: true },
    { ...paged, startDigits: false }, { ...paged, continued: true }, { ...paged, grantNamed: false }, { ...paged, eachKnownOnce: false })
}
pure def lawAContinuationIsReadOnlyFromItsStart(historyAsk: HistoryAsk, requested: RequestedCount): bool =
  (historyAskAccepted(historyAsk, requested) and historyAsk.continued) implies (historyAsk.started and historyAsk.startDigits and historyAsk.tokenWithinBound)
pure def lawAnAcceptedHistoryCountIsWithinItsBound(requested: RequestedCount): bool = { val answer = historyCount(requested)
  match answer {
  | CountAccepted(a) => a.accepted >= 1 and a.accepted <= historyCountMax
  | CountRefused => requested != CountOmitted
} }
```

### A history answer is a baseline without a start, a reset for a start Google no longer holds, or one ordered page, and nothing once the grant has ended

Without a start the answer is `baseline-required` with the mailbox's current
`historyId`. A start Google answers 404 for is `reset-required` with no
revision. Neither has events, a checkpoint or a continuation, and each says
`backfillRequired: true`: it never claims that mail it skipped was seen.
Otherwise the answer is a `page` of the changes Google listed after the
start (a message added or deleted, labels added or removed), each `{id:
"<historyId>:<type>:<messageId>", historyId, type, messageId, threadId,
labelIds}`, in revision order and none past the mailbox's `historyId`. Each
added message also carries `messageAvailable` and the labels Google holds
for it when the page is read; one Google no longer has is unavailable with
no labels, which never refuses the page. `checkpoint` is the mailbox's
revision only on a page without a continuation, and a continuation never
repeats the token asked with. Rows out of order or past the revision, more
rows than asked for, a change Google did not classify, an added message
read back as another, a repeated token, over 2,000 events or over 100 added
messages are `502 provider_invalid_response`, and the cloud reads no
message for a page it will refuse. After Google answers, the cloud checks the
caller's credential again. It also checks that the grant still belongs to
the same user, organization and Google account and still has Gmail triage
access. A dead credential gets `401 authentication_required`. An ended or
changed grant gets `409 google_reauth_required`. In either case, the cloud
withholds the Google reply. The cloud keeps no checkpoint. The phone commits
one after it has stored the page.

```quint
type HistoryRead = { started: bool, expired: bool, consistent: bool, continues: bool, freshContinuation: bool, events: int, additions: int, grantCurrent: bool }
type HistoryAnswer = HistoryBaseline | HistoryReset | HistoryPage({ checkpointed: bool }) | HistoryRefused({ refusal: Refusal })
pure val historyEventMax: int = 2000
pure val historyAdditionMax: int = 100
pure def historyAnswer(historyRead: HistoryRead): HistoryAnswer =
  if (not(historyRead.grantCurrent)) HistoryRefused({ refusal: refuse(GoogleReauthRequired) })
  else if (not(historyRead.started)) HistoryBaseline
  else if (historyRead.expired) HistoryReset
  else if (not(historyRead.consistent) or (historyRead.continues and not(historyRead.freshContinuation))
    or historyRead.events > historyEventMax or historyRead.additions > historyAdditionMax) HistoryRefused({ refusal: refuse(ProviderInvalidResponse) })
  else HistoryPage({ checkpointed: not(historyRead.continues) })
pure val historyReadValues: Set[HistoryRead] = {
  val page: HistoryRead = { started: true, expired: false, consistent: true, continues: false, freshContinuation: false, events: 3, additions: 1, grantCurrent: true }
  Set(page, { ...page, started: false, events: 0, additions: 0 }, { ...page, expired: true, events: 0, additions: 0 }, { ...page, continues: true, freshContinuation: true },
    { ...page, continues: true }, { ...page, consistent: false }, { ...page, events: 2000, additions: 100 }, { ...page, events: 2001 }, { ...page, additions: 101, events: 101 },
    { ...page, grantCurrent: false }, { ...page, started: false, grantCurrent: false })
}
pure def lawAHistoryPageIsCheckpointedOnlyAtItsEnd(historyRead: HistoryRead): bool = { val answer = historyAnswer(historyRead)
  match answer {
  | HistoryPage(p) => historyRead.grantCurrent and historyRead.started and not(historyRead.expired) and historyRead.consistent
      and historyRead.events <= historyEventMax and historyRead.additions <= historyAdditionMax
      and (p.checkpointed iff not(historyRead.continues)) and (historyRead.continues implies historyRead.freshContinuation)
  | HistoryRefused(r) => wellFormed(r.refusal)
  | HistoryBaseline => not(historyRead.started)
  | HistoryReset => historyRead.started and historyRead.expired
} }
pure def lawNothingIsAnsweredOnceTheGrantHasEnded(historyRead: HistoryRead): bool =
  not(historyRead.grantCurrent) implies historyAnswer(historyRead) == HistoryRefused({ refusal: refuse(GoogleReauthRequired) })
```
