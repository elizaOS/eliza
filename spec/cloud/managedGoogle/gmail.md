# Managed Gmail

A consumer's mail client reads Gmail through the cloud: it searches with a
cursor, reads one message, and opens its formatting and attachment
metadata. The cloud owns route authorization and Google normalization; the
client decodes what the cloud returns and refuses anything it cannot
account for. It triages the inbox, pages a thread, fetches one attachment's
bytes at the message revision it was read at, and lists provider drafts. A
reviewed star change is sent once, for the owner, scope and message
revision that were reviewed, and every other reviewed mailbox change, draft
change and send goes through the cloud's prepare-then-dispatch receipt
ledger, which performs each prepared request at most once. Paging across replies, saved reads and
cache custody are [the mailbox reads](../../inbox/reads.md); the agent
broker and reviewed sends are [the managed Google connection](./connection.md).

## Story: Read my Gmail results through the connected owner account

> As an owner, I want my mail searched and read through my own connected
> account, with every reply checked before my client shows it.

### A search request and a search response have distinct cursor boundaries

The consumer injects its authenticated cloud request function and typed
`invalid-response` error. The client sends one GET to the configured
Cloud API origin with no request body, using
`/api/v1/eliza/google/gmail/search` or
`/api/v1/eliza/google/gmail/read`. Both use URL search parameters
including `side=owner` and a nonblank grant ID. Search adds a
nonblank query, a requested page size, and the optional request
cursor. Read adds a nonblank message ID. Nonblank uses JavaScript
trim to admit but sends the original string. The client's typed search
size is 10, 25 or 50 with default 25. The renderer does not enforce
that union at runtime. Cloud search parses a canonical positive
integer with default 12 if omitted and clamps to 50 before Google.
Cloud trims grant ID, query and read message ID at the route.
The host's authenticated transport checks cancellation before and
after the request, supplies a bearer credential or a permitted native
credential reference, rejects redirects, and has a 30-second default
timeout. Non-2xx replies keep the HTTP status and decoded error body.

A present input cursor must be a string of 1–4,096 UTF-16 units.
Empty, null, nonstring or oversized input cursor throws before I/O
with the native TypeError for invalid page token. Whitespace strings
pass the cursor rule, which does not trim. For the response, absent
or null cursor means no further page. A present cursor must fit
the same string bound and differ exactly from this request's cursor.
Longer observed cursor cycles are the Inbox pagination contract.

Every search response requires a JSON object, a message array whose
rows all decode, and nonblank string `syncedAt`. It neither parses
that field as a timestamp nor enforces a response count in this
decoder. `mailboxHistoryId` may be absent or null for older
Cloud. If present it is an exact string of 1–20 ASCII decimal
digits, including leading zeros. Preserve the string without
numeric coercion. The Cloud producer reads and validates Gmail's
profile history ID before listing each page. Cloud rejects a
mismatched batch message and invalid metadata batch. The renderer
requires `supportsSpamTrash` to be Boolean when present and
returns false for an omitted value. Cloud's current producer
returns true and enables Google `includeSpamTrash` for a bounded
`in:spam`, `in:trash` or `in:anywhere` search term. No label
catalog parameters are sent on the client's search. The separate
Cloud label API parameters and provider tokens do not become
part of this renderer projection.

The model takes decoded lexical facts, integer unit counts and an
exact-string equality observation for cursors. The numeric history
ID describes its grammar and stays opaque as an identifier.

```quint
type OptionalWire = AbsentWire | NullWire | StringWire | BooleanWire | OtherWire
type CursorFacts = { shape: OptionalWire, units: int, repeatsRequest: bool }
type SearchWire = { objectReply: bool, messageArray: bool, messagesValid: bool, syncedAtNonblank: bool, flagShape: OptionalWire }
pure def usableCursor(cursor: CursorFacts): bool =
  cursor.shape == StringWire and cursor.units >= 1 and cursor.units <= 4096
pure def requestCursorAdmitted(cursor: CursorFacts): bool =
  cursor.shape == AbsentWire or usableCursor(cursor)
pure def responseCursorAdmitted(cursor: CursorFacts): bool =
  cursor.shape == AbsentWire or cursor.shape == NullWire or (usableCursor(cursor) and not(cursor.repeatsRequest))
pure def searchHistoryAdmitted(historyShape: OptionalWire, historyUnits: int, allAsciiDigits: bool): bool =
  historyShape == AbsentWire or historyShape == NullWire or
  (historyShape == StringWire and historyUnits >= 1 and historyUnits <= 20 and allAsciiDigits)
pure def typedPageSize(maxResults: int): bool = maxResults == 10 or maxResults == 25 or maxResults == 50
pure def cloudPageSize(maxResults: int): int = if (maxResults < 1) 1 else if (maxResults > 50) 50 else maxResults
pure def searchAdmitted(searchWire: SearchWire, cursor: CursorFacts, historyShape: OptionalWire, historyUnits: int, allAsciiDigits: bool): bool =
  searchWire.objectReply and searchWire.messageArray and searchWire.messagesValid and searchWire.syncedAtNonblank and
  (searchWire.flagShape == AbsentWire or searchWire.flagShape == BooleanWire) and responseCursorAdmitted(cursor) and
  searchHistoryAdmitted(historyShape, historyUnits, allAsciiDigits)
pure def lawNullCursorOnlyAsResponse(cursor: CursorFacts): bool =
  cursor.shape == NullWire implies not(requestCursorAdmitted(cursor)) and responseCursorAdmitted(cursor)
pure def lawRepeatedCursorRefused(cursor: CursorFacts): bool =
  cursor.shape == StringWire and cursor.repeatsRequest implies not(responseCursorAdmitted(cursor))
pure def lawOversizeCursorRefused(cursor: CursorFacts): bool =
  cursor.shape == StringWire and cursor.units > 4096 implies not(requestCursorAdmitted(cursor) or responseCursorAdmitted(cursor))
pure def lawHistoryStaysAsciiDigits(historyShape: OptionalWire, historyUnits: int, allAsciiDigits: bool): bool =
  historyShape != AbsentWire and historyShape != NullWire and searchHistoryAdmitted(historyShape, historyUnits, allAsciiDigits) implies
  historyShape == StringWire and allAsciiDigits and historyUnits >= 1 and historyUnits <= 20
pure def lawCloudClampsPageSize(maxResults: int): bool =
  cloudPageSize(maxResults) >= 1 and cloudPageSize(maxResults) <= 50
pure val cursorValues = Set(
  { shape: AbsentWire, units: 0, repeatsRequest: false }, { shape: NullWire, units: 0, repeatsRequest: false },
  { shape: StringWire, units: 0, repeatsRequest: false }, { shape: StringWire, units: 4096, repeatsRequest: false },
  { shape: StringWire, units: 4097, repeatsRequest: false }, { shape: StringWire, units: 1, repeatsRequest: true })
pure val historyUnitsValues = Set(0, 1, 20, 21)
pure val maxResultsValues = Set(0, 1, 10, 12, 25, 50, 51)
pure val searchWireValues = Set(
  { objectReply: true, messageArray: true, messagesValid: true, syncedAtNonblank: true, flagShape: AbsentWire },
  { objectReply: true, messageArray: true, messagesValid: true, syncedAtNonblank: true, flagShape: BooleanWire },
  { objectReply: true, messageArray: true, messagesValid: false, syncedAtNonblank: true, flagShape: NullWire })
```

### A message projects its normalized identity and known flags

Every message row must be an object containing nonblank string
`externalId`, thread ID, sender and received-at, plus string
subject and snippet, Boolean unread and an array of nonblank
recipient strings. `externalId` becomes `id` unchanged.
Blank subjects and snippets are valid. Runtime admission checks
received-at as nonblank text. An absent or null sender email
or reply-to yields null; otherwise it must be nonblank text.
An array CC validates each string and retains order; all other
CC input yields an empty array. An absent attachment hint is
omitted, and a present hint must be Boolean. If labels is an
array, only membership of the exact string `STARRED` is used.
A nonarray labels value omits starred, and an array without
`STARRED` emits false. Other labels and arbitrary extra fields
are not carried into the renderer message. The parser does not
validate every member of the labels array.

A read requires an object, string `bodyText` and exactly the
requested message ID in the parsed message. It keeps empty plain
text. The optional message metadata is absent, null or an object.
Its `historyId` is any string, including blank, or returns null
for any other value. This field binds later reviewed requests.
It is distinct from the page-level numeric-string revision.
Provider read checks the same message ID and a trailing current
connection with body-read scope. Cloud normalizes plain text or
uses the snippet when no normalized text is available.

```quint
type OptionalFlag = OmitFlag | FalseFlag | TrueFlag
type MailMessageWire = { objectRow: bool, idPresent: bool, threadPresent: bool, senderPresent: bool, receivedPresent: bool, subjectString: bool, snippetString: bool, unreadBoolean: bool, toValid: bool, ccValidWhenArray: bool, emailValidWhenPresent: bool, replyValidWhenPresent: bool, attachmentHintShape: OptionalWire }
type MessageReadWire = { objectReply: bool, plainString: bool, acceptedMessage: bool, sameMessageId: bool, metadataValid: bool, attachmentsValid: bool, linksValid: bool, htmlValid: bool }
pure def messageAdmitted(messageWire: MailMessageWire): bool =
  messageWire.objectRow and messageWire.idPresent and messageWire.threadPresent and messageWire.senderPresent and messageWire.receivedPresent and
  messageWire.subjectString and messageWire.snippetString and messageWire.unreadBoolean and messageWire.toValid and messageWire.ccValidWhenArray and
  messageWire.emailValidWhenPresent and messageWire.replyValidWhenPresent and
  (messageWire.attachmentHintShape == AbsentWire or messageWire.attachmentHintShape == BooleanWire)
pure def displayStar(labelsArray: bool, hasExactStar: bool): OptionalFlag =
  if (not(labelsArray)) OmitFlag else if (hasExactStar) TrueFlag else FalseFlag
pure def messageHistoryPresent(historyShape: OptionalWire): bool = historyShape == StringWire
pure def messageReadAdmitted(readWire: MessageReadWire): bool =
  readWire.objectReply and readWire.plainString and readWire.acceptedMessage and readWire.sameMessageId and readWire.metadataValid and
  readWire.attachmentsValid and readWire.linksValid and readWire.htmlValid
pure def lawForeignMessageRefused(readWire: MessageReadWire): bool =
  not(readWire.sameMessageId) implies not(messageReadAdmitted(readWire))
pure def lawStarRequiresExactLabel(labelsArray: bool, hasExactStar: bool): bool =
  displayStar(labelsArray, hasExactStar) == TrueFlag implies labelsArray and hasExactStar
pure def lawAbsentLabelsOmitStar(hasExactStar: bool): bool =
  displayStar(false, hasExactStar) == OmitFlag
pure def lawUnreadMustBeBoolean(messageWire: MailMessageWire): bool =
  not(messageWire.unreadBoolean) implies not(messageAdmitted(messageWire))
pure val messageWireValues = Set(
  { objectRow: true, idPresent: true, threadPresent: true, senderPresent: true, receivedPresent: true, subjectString: true, snippetString: true, unreadBoolean: true, toValid: true, ccValidWhenArray: true, emailValidWhenPresent: true, replyValidWhenPresent: true, attachmentHintShape: AbsentWire },
  { objectRow: true, idPresent: true, threadPresent: true, senderPresent: true, receivedPresent: true, subjectString: true, snippetString: true, unreadBoolean: true, toValid: true, ccValidWhenArray: true, emailValidWhenPresent: true, replyValidWhenPresent: true, attachmentHintShape: NullWire },
  { objectRow: true, idPresent: true, threadPresent: true, senderPresent: true, receivedPresent: true, subjectString: true, snippetString: true, unreadBoolean: false, toValid: true, ccValidWhenArray: true, emailValidWhenPresent: true, replyValidWhenPresent: true, attachmentHintShape: BooleanWire })
pure val readWireValues = Set(
  { objectReply: true, plainString: true, acceptedMessage: true, sameMessageId: true, metadataValid: true, attachmentsValid: true, linksValid: true, htmlValid: true },
  { objectReply: true, plainString: true, acceptedMessage: true, sameMessageId: false, metadataValid: true, attachmentsValid: true, linksValid: true, htmlValid: true })
```

## Story: Open a message with bounded, inert formatting and attachment metadata

> As an owner opening a message, I want its formatting and links bounded and
> inert, and its attachments described without their bytes, while the plain
> text stays complete.

### Attachment descriptors communicate availability without providing bytes

A nonarray attachments value yields an empty list. Array entries
must be objects with string part ID, string name, string MIME type,
and nonnegative safe integer size. Prefer `filename` whenever it
is string, otherwise use `name`. An explicit Boolean supported
value overrides MIME inference. Without it, infer true for exact
`application/pdf`, `text/plain`, `image/png`,
`image/jpeg` or `image/webp` only. Strings can be empty here.
An invalid member refuses the whole read. Preserve descriptor
order and known fields. Ignore arbitrary fields. This result
has metadata only. Open or save requires separate attachment
retrieval and the associated exact identity and content checks.

```quint
type AttachmentWire = { objectRow: bool, partIdString: bool, filenameString: bool, fallbackNameString: bool, mimeString: bool, safeIntegerSize: bool, byteSize: int, supportShape: OptionalWire }
pure def attachAdmitted(attachmentWire: AttachmentWire): bool =
  attachmentWire.objectRow and attachmentWire.partIdString and (attachmentWire.filenameString or attachmentWire.fallbackNameString) and
  attachmentWire.mimeString and attachmentWire.safeIntegerSize and attachmentWire.byteSize >= 0 and
  (attachmentWire.supportShape == AbsentWire or attachmentWire.supportShape == BooleanWire)
pure def filenameWins(filenameString: bool): bool = filenameString
pure def previewMime(mime: str): bool =
  mime == "application/pdf" or mime == "text/plain" or mime == "image/png" or mime == "image/jpeg" or mime == "image/webp"
pure def attachmentSupported(explicitSupport: bool, supportedValue: bool, mime: str): bool =
  if (explicitSupport) supportedValue else previewMime(mime)
pure def lawExplicitAttachmentSupportWins(supportedValue: bool, mime: str): bool =
  attachmentSupported(true, supportedValue, mime) == supportedValue
pure def lawNegativeAttachmentSizeRefused(attachmentWire: AttachmentWire): bool =
  attachmentWire.byteSize < 0 implies not(attachAdmitted(attachmentWire))
pure val attachmentWireValues = Set(
  { objectRow: true, partIdString: true, filenameString: true, fallbackNameString: false, mimeString: true, safeIntegerSize: true, byteSize: 0, supportShape: AbsentWire },
  { objectRow: true, partIdString: true, filenameString: false, fallbackNameString: true, mimeString: true, safeIntegerSize: true, byteSize: -1, supportShape: BooleanWire },
  { objectRow: true, partIdString: true, filenameString: false, fallbackNameString: false, mimeString: true, safeIntegerSize: true, byteSize: 0, supportShape: OtherWire })
pure val mimeValues = Set("", "text/plain", "image/webp", "Application/PDF", "application/zip")
```

### Oversize presentation data leaves the plain body available

Absent links are an empty list; a present links field is an array of at
most 200 rows, and an invalid row is dropped. A row is kept only with a
string href of at most 2,048 UTF-16 units that parses as an absolute HTTP
or HTTPS URL with a host and no credentials, and a string label, which is
cleaned of control characters, trimmed to 200 units and falls back to the
host name. The first 50 distinct links are shown, and the count of the rest
is reported only when some were left out. Rendering the links makes no
request.

Absent, null or empty HTML leaves only the plain text; any other non-string
is invalid. HTML up to 524,288 UTF-8 bytes is kept whole and larger HTML is
omitted and marked so. The plain text is always returned whole, and the
renderer read has no plain-text cap; the agent's body cap is [the managed
Google connection](./connection.md)'s. The renderer sanitizes the HTML, and
shows remote HTTPS images only with the current display choice or a saved
opt-in.

```quint
type HtmlProjection = NoHtml | CompleteHtml | OmittedHtml | InvalidHtml
type MailLinkWire = { objectRow: bool, hrefString: bool, labelString: bool, hrefUnits: int, absoluteUrl: bool, httpScheme: bool, hasHost: bool, hasCredentials: bool }
pure def htmlProjection(htmlShape: OptionalWire, htmlBytes: int): HtmlProjection =
  if (htmlShape == AbsentWire or htmlShape == NullWire) NoHtml
  else if (htmlShape != StringWire or htmlBytes < 0) InvalidHtml
  else if (htmlBytes == 0) NoHtml
  else if (htmlBytes <= 524288) CompleteHtml
  else OmittedHtml
pure def linksEnvelope(linksAbsent: bool, linksArray: bool, linkCount: int): bool =
  linksAbsent or (linksArray and linkCount >= 0 and linkCount <= 200)
pure def linkAdmitted(linkWire: MailLinkWire): bool =
  linkWire.objectRow and linkWire.hrefString and linkWire.labelString and linkWire.hrefUnits >= 0 and linkWire.hrefUnits <= 2048 and
  linkWire.absoluteUrl and linkWire.httpScheme and linkWire.hasHost and not(linkWire.hasCredentials)
pure def linkDisplayCount(distinctSafeCount: int): int = if (distinctSafeCount > 50) 50 else distinctSafeCount
pure def omittedLinkCount(distinctSafeCount: int): int = if (distinctSafeCount > 50) distinctSafeCount - 50 else 0
pure def lawLargeHtmlUsesOmission(htmlBytes: int): bool =
  htmlBytes > 524288 implies htmlProjection(StringWire, htmlBytes) == OmittedHtml
pure def lawCredentialsRefuseLink(linkWire: MailLinkWire): bool =
  linkWire.hasCredentials implies not(linkAdmitted(linkWire))
pure def lawNonArrayLinksRefuseUnlessAbsent(linksAbsent: bool, linkCount: int): bool =
  linksEnvelope(linksAbsent, false, linkCount) == linksAbsent
pure def lawLinkCountAccountsForOmissions(distinctSafeCount: int): bool =
  linkDisplayCount(distinctSafeCount) + omittedLinkCount(distinctSafeCount) == distinctSafeCount
pure val htmlBytesValues = Set(0, 1, 524288, 524289)
pure val linkCountValues = Set(0, 1, 200, 201)
pure val distinctSafeCountValues = Set(0, 1, 49, 50, 51, 200)
pure val linkWireValues = Set(
  { objectRow: true, hrefString: true, labelString: true, hrefUnits: 2048, absoluteUrl: true, httpScheme: true, hasHost: true, hasCredentials: false },
  { objectRow: true, hrefString: true, labelString: true, hrefUnits: 2049, absoluteUrl: true, httpScheme: true, hasHost: true, hasCredentials: false },
  { objectRow: true, hrefString: true, labelString: true, hrefUnits: 10, absoluteUrl: true, httpScheme: true, hasHost: true, hasCredentials: true })
```

## Story: Star a message only as reviewed

> As an owner, I want a star or unstar my agent proposed sent once, only for
> the message revision I reviewed and only while I still own the grant, and
> nothing else about the message changed.

### A reviewed star change is sent once for the reviewed revision

The owner authorizes the change, and the request is prepared with the
message revision it was reviewed at. It is sent only while the same owner
holds the grant and the message is still at that revision, and at most once;
a lost reply is observed rather than resent. Sending sets only the star:
the message stays in the inbox and keeps its importance.

```quint
type StarPhase = StarIdle | StarReview | StarSent | StarUnknown | StarDone
type StarMutation = { starPhase: StarPhase, ownerCurrent: bool, grant: bool, revision: int, reviewed: int, starTarget: bool, starred: bool, inInbox: bool, important: bool, starCalls: int }
pure val initial: StarMutation = { starPhase: StarIdle, ownerCurrent: true, grant: false, revision: 0, reviewed: -1, starTarget: true, starred: false, inInbox: true, important: true, starCalls: 0 }
pure def canAuthorizeStar(m: StarMutation): bool = m.ownerCurrent and not(m.grant)
pure def authorizeStar(m: StarMutation): StarMutation = { ...m, grant: true }
pure def canPrepareStar(m: StarMutation, starTarget: bool): bool = m.starPhase == StarIdle and m.ownerCurrent and m.grant
pure def prepareStar(m: StarMutation, starTarget: bool): StarMutation = { ...m, starPhase: StarReview, starTarget: starTarget, reviewed: m.revision }
pure def canChangeRevision(m: StarMutation): bool = m.starPhase != StarDone
pure def changeRevision(m: StarMutation): StarMutation = { ...m, revision: m.revision + 1 }
pure def canRevokeGrant(m: StarMutation): bool = m.grant
pure def revokeGrant(m: StarMutation): StarMutation = { ...m, grant: false }
pure def canReplaceOwner(m: StarMutation): bool = m.ownerCurrent
pure def replaceOwner(m: StarMutation): StarMutation = { ...m, ownerCurrent: false }
pure def canDispatchStar(m: StarMutation): bool = m.starPhase == StarReview and m.ownerCurrent and m.grant and m.revision == m.reviewed
pure def dispatchStar(m: StarMutation): StarMutation = { ...m, starPhase: StarSent, starCalls: m.starCalls + 1, starred: m.starTarget }
pure def canLoseStarReply(m: StarMutation): bool = m.starPhase == StarSent
pure def loseStarReply(m: StarMutation): StarMutation = { ...m, starPhase: StarUnknown }
pure def canObserveStar(m: StarMutation): bool = m.starPhase == StarSent or m.starPhase == StarUnknown
pure def observeStar(m: StarMutation): StarMutation = { ...m, starPhase: StarDone }
pure def alwaysStarSentAtMostOnce(m: StarMutation): bool = m.starCalls >= 0 and m.starCalls <= 1 and ((m.starCalls == 1) == (m.starPhase == StarSent or m.starPhase == StarUnknown or m.starPhase == StarDone))
pure def alwaysStarChangesNothingElse(m: StarMutation): bool = m.inInbox and m.important and (m.starCalls == 1 implies m.starred == m.starTarget)
pure def stepStarSentOnlyAsReviewed(before: StarMutation, after: StarMutation): bool =
  after.starCalls > before.starCalls implies (before.ownerCurrent and before.grant and before.revision == before.reviewed and before.starPhase == StarReview)
pure def sometimesStarReplyLost(m: StarMutation): bool = m.starPhase == StarUnknown
pure def sometimesStarObserved(m: StarMutation): bool = m.starPhase == StarDone and m.starred
pure def sometimesChangedRevisionBlocksStar(m: StarMutation): bool = m.starPhase == StarReview and m.revision != m.reviewed
```

## Story: Triage my inbox and open everything a message carries

> As an owner, I want my inbox triaged without what I trashed, and a
> message's thread, attachments and my provider drafts opened exactly as
> they are at the revision I read, or not at all.

### Triage leaves out trashed mail, and an unknown message is not found

The triage list carries every message of the connected account except those
labelled trash; a read of a message the account does not hold answers 404
`not_found`.

```quint
type MessageReadOutcome = MessageServed | MessageNotFound
pure def triageListed(inTrash: bool): bool = not(inTrash)
pure def messageReadOutcome(messageKnown: bool): MessageReadOutcome = if (messageKnown) MessageServed else MessageNotFound
pure def readStatusCode(readOutcome: MessageReadOutcome): int = if (readOutcome == MessageServed) 200 else 404
pure def lawTriageLeavesOutTrash(inTrash: bool): bool = triageListed(inTrash) iff not(inTrash)
pure def lawUnknownMessageIsNotFound(messageKnown: bool): bool =
  not(messageKnown) implies readStatusCode(messageReadOutcome(messageKnown)) == 404
```

### A thread page and an attachment are served only at the revision they were read at

A thread page names the requested thread, holds at most 25 messages, all of
that thread, starts at the offset asked for, and reports the thread's total
of at most 2,000 messages, which covers the page; its next offset is the end
of the page while messages remain and null at the end. A page after the
first is asked for with the thread's history ID from the first page, and is
refused as `stale_revision` when the thread changed since. An attachment is
fetched by message, part and the message's history ID, and refused as
`stale_revision` when the message changed since that read, and as
`not_found` when no single part has that ID. The reply must echo the
message, part and history ID, and its bytes must hash and count to the
SHA-256 and size it declares; the client refuses any other reply.

```quint
type ThreadPageWire = { versionOne: bool, sameThread: bool, messageCount: int, allInThread: bool, offset: int, askedOffset: int, total: int, nextOffset: int, historyMatchesFirst: bool }
type AttachmentFetch = { messageCurrent: bool, matchingParts: int }
type AttachmentFetchOutcome = AttachmentServed | AttachmentStale | AttachmentMissing
type AttachmentReplyWire = { attachmentVersionOne: bool, echoesMessage: bool, echoesPart: bool, echoesHistory: bool, hashMatches: bool, sizeMatches: bool }
pure def expectedNextOffset(offset: int, messageCount: int, total: int): int = if (offset + messageCount < total) offset + messageCount else -1
pure def threadPageAdmitted(t: ThreadPageWire): bool =
  t.versionOne and t.sameThread and t.allInThread and t.messageCount >= 0 and t.messageCount <= 25 and
  t.offset == t.askedOffset and t.offset >= 0 and t.total >= t.offset + t.messageCount and t.total <= 2000 and
  t.nextOffset == expectedNextOffset(t.offset, t.messageCount, t.total) and (t.offset > 0 implies t.historyMatchesFirst)
pure def attachmentFetchOutcome(f: AttachmentFetch): AttachmentFetchOutcome =
  if (not(f.messageCurrent)) AttachmentStale else if (f.matchingParts != 1) AttachmentMissing else AttachmentServed
pure def attachmentReplyAdmitted(w: AttachmentReplyWire): bool =
  w.attachmentVersionOne and w.echoesMessage and w.echoesPart and w.echoesHistory and w.hashMatches and w.sizeMatches
pure val tValues = Set(
  { versionOne: true, sameThread: true, messageCount: 25, allInThread: true, offset: 0, askedOffset: 0, total: 30, nextOffset: 25, historyMatchesFirst: false },
  { versionOne: true, sameThread: true, messageCount: 5, allInThread: true, offset: 25, askedOffset: 25, total: 30, nextOffset: -1, historyMatchesFirst: true },
  { versionOne: true, sameThread: true, messageCount: 5, allInThread: true, offset: 25, askedOffset: 25, total: 30, nextOffset: -1, historyMatchesFirst: false },
  { versionOne: true, sameThread: true, messageCount: 26, allInThread: true, offset: 0, askedOffset: 0, total: 30, nextOffset: 26, historyMatchesFirst: true })
pure val fValues = Set({ messageCurrent: true, matchingParts: 1 }, { messageCurrent: false, matchingParts: 1 }, { messageCurrent: true, matchingParts: 0 }, { messageCurrent: true, matchingParts: 2 })
pure val wValues = Set(
  { attachmentVersionOne: true, echoesMessage: true, echoesPart: true, echoesHistory: true, hashMatches: true, sizeMatches: true },
  { attachmentVersionOne: true, echoesMessage: true, echoesPart: true, echoesHistory: false, hashMatches: true, sizeMatches: true },
  { attachmentVersionOne: true, echoesMessage: true, echoesPart: true, echoesHistory: true, hashMatches: false, sizeMatches: true })
pure def lawLaterThreadPageNeedsTheFirstHistory(t: ThreadPageWire): bool =
  (t.offset > 0 and not(t.historyMatchesFirst)) implies not(threadPageAdmitted(t))
pure def lawThreadPageIsBounded(t: ThreadPageWire): bool =
  threadPageAdmitted(t) implies (t.messageCount <= 25 and t.total <= 2000 and (t.nextOffset == -1 or t.nextOffset == t.offset + t.messageCount))
pure def lawChangedMessageServesNoAttachment(f: AttachmentFetch): bool =
  not(f.messageCurrent) implies attachmentFetchOutcome(f) == AttachmentStale
pure def lawAttachmentBytesMatchTheirDeclaration(w: AttachmentReplyWire): bool =
  attachmentReplyAdmitted(w) implies (w.hashMatches and w.sizeMatches and w.echoesHistory)
```

### Provider drafts and the mailbox capabilities are read within fixed bounds

A drafts page holds at most 50 drafts and its next cursor obeys the same
bounds as a search cursor. Opening one draft returns its content and the
digest of its raw message from one snapshot, with at most 50 recipients in
each of To, Cc and Bcc. The capabilities reply is version 1, says the
provider does not apply anything exactly once and does not replace a draft
atomically, and its attachment policy, when present, allows 1 to 20
outgoing attachments (1 by default), each of 1 byte to 25 MiB (5 MiB by
default), and a total of 1 byte to 25 MiB (the per-attachment limit by
default); any value outside those bounds refuses the reply.

```quint
type DraftsPageWire = { draftsVersionOne: bool, draftCount: int }
type PolicyValue = { given: bool, amount: int }
type MailboxCapabilitiesWire = { capabilitiesVersionOne: bool, exactlyOnceClaimed: bool, atomicReplacementClaimed: bool, outgoing: PolicyValue, perAttachment: PolicyValue, total: PolicyValue }
pure val mebibyte = 1048576
pure def policyLimit(v: PolicyValue, fallback: int, most: int): int =
  if (not(v.given)) fallback else if (v.amount >= 1 and v.amount <= most) v.amount else -1
pure def draftsPageAdmitted(page: DraftsPageWire, cursor: CursorFacts): bool =
  page.draftsVersionOne and page.draftCount >= 0 and page.draftCount <= 50 and responseCursorAdmitted(cursor)
pure def draftRecipientsAdmitted(toCount: int, ccCount: int, bccCount: int): bool = toCount >= 0 and toCount <= 50 and ccCount >= 0 and ccCount <= 50 and bccCount >= 0 and bccCount <= 50
pure def capabilitiesAdmitted(c: MailboxCapabilitiesWire): bool = {
  val per = policyLimit(c.perAttachment, 5 * mebibyte, 25 * mebibyte)
  c.capabilitiesVersionOne and not(c.exactlyOnceClaimed) and not(c.atomicReplacementClaimed) and
  policyLimit(c.outgoing, 1, 20) > 0 and per > 0 and policyLimit(c.total, per, 25 * mebibyte) > 0
}
pure val pageValues = Set({ draftsVersionOne: true, draftCount: 50 }, { draftsVersionOne: true, draftCount: 51 }, { draftsVersionOne: false, draftCount: 1 })
pure val absentPolicy: PolicyValue = { given: false, amount: 0 }
pure val cValues = Set(
  { capabilitiesVersionOne: true, exactlyOnceClaimed: false, atomicReplacementClaimed: false, outgoing: absentPolicy, perAttachment: absentPolicy, total: absentPolicy },
  { capabilitiesVersionOne: true, exactlyOnceClaimed: true, atomicReplacementClaimed: false, outgoing: absentPolicy, perAttachment: absentPolicy, total: absentPolicy },
  { capabilitiesVersionOne: true, exactlyOnceClaimed: false, atomicReplacementClaimed: false, outgoing: { given: true, amount: 21 }, perAttachment: absentPolicy, total: absentPolicy },
  { capabilitiesVersionOne: true, exactlyOnceClaimed: false, atomicReplacementClaimed: false, outgoing: { given: true, amount: 20 }, perAttachment: { given: true, amount: 26214400 }, total: absentPolicy })
pure val vValues = Set(absentPolicy, { given: true, amount: 0 }, { given: true, amount: 1 }, { given: true, amount: 20 }, { given: true, amount: 21 })
pure def lawDraftsPageHoldsAtMostFifty(page: DraftsPageWire, cursor: CursorFacts): bool =
  draftsPageAdmitted(page, cursor) implies page.draftCount <= 50
pure def lawNoReplyClaimsExactlyOnce(c: MailboxCapabilitiesWire): bool =
  capabilitiesAdmitted(c) implies not(c.exactlyOnceClaimed or c.atomicReplacementClaimed)
pure def lawPolicyLimitStaysInBounds(v: PolicyValue): bool =
  (policyLimit(v, 1, 20) == -1 or (policyLimit(v, 1, 20) >= 1 and policyLimit(v, 1, 20) <= 20)) and
  (not(v.given) implies policyLimit(v, 1, 20) == 1)
```

## Story: Change my mailbox once, as I reviewed it

> As an owner, I want a trash, untrash, read-state, archive, draft or send
> change my agent proposed applied at most once, only to the message
> revision I reviewed, and its outcome readable afterwards even if the
> connection dropped.

### Preparing a change is idempotent by request ID and binds the reviewed message revision

Preparing a change names the grant, a request ID and the proposal. The
cloud reviews the proposal against the message as it is now: a grant the
owner does not hold, or a message the account does not hold, is
`not_found`; a message whose history ID is not the one the proposal was
reviewed at is `stale_revision`. Otherwise the cloud records a prepared
receipt for the request ID with the proposal's kind and review digest, and
answers it with the review and the statement that the provider does not
apply anything exactly once. Preparing the same request ID again with the
same kind and digest answers the receipt it already holds, in whatever state
it has reached; with another kind or digest it is a conflict, and the
receipt is unchanged. Receipts are scoped to the organization, user, grant
and request ID.

```quint
type MailOpKind = SendOp | DraftCreateOp | DraftReplaceOp | DraftDeleteOp | ArchiveOp | UnarchiveOp | TrashOp | UntrashOp | MarkReadOp | MarkUnreadOp | StarOp | UnstarOp
type OpState = OpAbsent | OpPrepared | OpDispatched | OpSucceeded | OpRejected | OpOutcomeUnknown
type OpReceipt = { opState: OpState, opKind: MailOpKind, opDigest: int, providerResult: bool }
type ProposalReview = { grantHeld: bool, messageHeld: bool, historyCurrent: bool }
type PrepareAnswer = PrepareAnswered | PrepareConflict | PrepareStale | PrepareNotFound
pure val noReceipt: OpReceipt = { opState: OpAbsent, opKind: SendOp, opDigest: 0, providerResult: false }
pure def prepareAnswer(ledger: OpReceipt, kind: MailOpKind, digest: int, review: ProposalReview): PrepareAnswer =
  if (not(review.grantHeld and review.messageHeld)) PrepareNotFound
  else if (not(review.historyCurrent)) PrepareStale
  else if (ledger.opState == OpAbsent or (ledger.opKind == kind and ledger.opDigest == digest)) PrepareAnswered
  else PrepareConflict
pure def preparedLedger(ledger: OpReceipt, kind: MailOpKind, digest: int, review: ProposalReview): OpReceipt =
  if (prepareAnswer(ledger, kind, digest, review) == PrepareAnswered and ledger.opState == OpAbsent)
    { opState: OpPrepared, opKind: kind, opDigest: digest, providerResult: false }
  else ledger
pure val ledgerValues = Set(noReceipt,
  { opState: OpPrepared, opKind: TrashOp, opDigest: 1, providerResult: false },
  { opState: OpDispatched, opKind: TrashOp, opDigest: 1, providerResult: false },
  { opState: OpSucceeded, opKind: TrashOp, opDigest: 1, providerResult: true },
  { opState: OpOutcomeUnknown, opKind: MarkReadOp, opDigest: 2, providerResult: false })
pure val digestValues = Set(1, 2)
pure val kindValues = Set(TrashOp, MarkReadOp, SendOp)
pure val reviewValues = Set({ grantHeld: true, messageHeld: true, historyCurrent: true }, { grantHeld: true, messageHeld: true, historyCurrent: false }, { grantHeld: false, messageHeld: true, historyCurrent: true }, { grantHeld: true, messageHeld: false, historyCurrent: true })
pure def lawRepeatedPrepareKeepsTheReceipt(ledger: OpReceipt, kind: MailOpKind, digest: int, review: ProposalReview): bool =
  ledger.opState != OpAbsent implies preparedLedger(ledger, kind, digest, review) == ledger
pure def lawPrepareNeedsTheReviewedRevision(ledger: OpReceipt, kind: MailOpKind, digest: int, review: ProposalReview): bool =
  prepareAnswer(ledger, kind, digest, review) == PrepareAnswered implies (review.grantHeld and review.messageHeld and review.historyCurrent)
pure def lawPreparedReceiptBindsKindAndDigest(kind: MailOpKind, digest: int, review: ProposalReview): bool =
  preparedLedger(noReceipt, kind, digest, review).opState == OpPrepared implies
    (preparedLedger(noReceipt, kind, digest, review).opKind == kind and preparedLedger(noReceipt, kind, digest, review).opDigest == digest)
```

### A prepared change is dispatched at most once, and a repeat answers its receipt

Dispatching names the grant, the request ID, the review digest and the
proposal. A request ID with no receipt under that grant is `not_found`; a
digest other than the receipt's is `stale_revision`. A receipt that is no
longer prepared is answered as it stands, without asking Google again or
fetching new credentials. A prepared receipt is reviewed once more against
the message as it is now, and a changed message is `stale_revision`;
otherwise the cloud claims the receipt (only one claim can win) and asks
Google once. The receipt then records success only when Google's reply shows
the requested state (trash present after trash, absent after untrash,
unread absent after mark-read, present after mark-unread, inbox absent
after archive, present after unarchive, starred present after star, absent
after unstar); a definite refusal by Google is rejected, and anything else,
including a reply that does not show the requested state, is an unknown
outcome. A receipt reports a provider result exactly when it succeeded. A
lookup only reads the receipt, marking a dispatch older than 90 seconds as
an unknown outcome, and never dispatches; no step returns a receipt to
prepared.

```quint
type DispatchAnswer = DispatchPerformed | DispatchAnsweredReceipt | DispatchStale | DispatchNotFound
type ProviderReply = ProviderShowsRequested | ProviderShowsOther | ProviderRefused | ProviderLost
type MailLabels = { trash: bool, unread: bool, inbox: bool, starred: bool }
pure def showsRequested(kind: MailOpKind, labels: MailLabels): bool =
  if (kind == TrashOp) labels.trash else if (kind == UntrashOp) not(labels.trash)
  else if (kind == MarkReadOp) not(labels.unread) else if (kind == MarkUnreadOp) labels.unread
  else if (kind == ArchiveOp) not(labels.inbox) else if (kind == UnarchiveOp) labels.inbox
  else if (kind == StarOp) labels.starred else if (kind == UnstarOp) not(labels.starred) else true
pure def providerReplyOf(kind: MailOpKind, labels: MailLabels, refused: bool, lost: bool): ProviderReply =
  if (refused) ProviderRefused else if (lost) ProviderLost else if (showsRequested(kind, labels)) ProviderShowsRequested else ProviderShowsOther
pure def dispatchAnswer(ledger: OpReceipt, digest: int, grantHeld: bool, messageCurrent: bool): DispatchAnswer =
  if (not(grantHeld) or ledger.opState == OpAbsent) DispatchNotFound
  else if (ledger.opDigest != digest) DispatchStale
  else if (ledger.opState != OpPrepared) DispatchAnsweredReceipt
  else if (not(messageCurrent)) DispatchStale
  else DispatchPerformed
pure def dispatchedLedger(ledger: OpReceipt, digest: int, grantHeld: bool, messageCurrent: bool, reply: ProviderReply): OpReceipt =
  if (dispatchAnswer(ledger, digest, grantHeld, messageCurrent) != DispatchPerformed) ledger
  else { ...ledger,
    opState: if (reply == ProviderShowsRequested) OpSucceeded else if (reply == ProviderRefused) OpRejected else OpOutcomeUnknown,
    providerResult: reply == ProviderShowsRequested }
pure def observedLedger(ledger: OpReceipt, dispatchedSeconds: int): OpReceipt =
  if (ledger.opState == OpDispatched and dispatchedSeconds > 90) { ...ledger, opState: OpOutcomeUnknown } else ledger
pure val replyValues = Set(ProviderShowsRequested, ProviderShowsOther, ProviderRefused, ProviderLost)
pure val dispatchedSecondsValues = Set(0, 90, 91)
pure val labelsValues = Set({ trash: true, unread: false, inbox: false, starred: false }, { trash: false, unread: true, inbox: true, starred: true })
pure def lawOnlyAPreparedReceiptIsDispatched(ledger: OpReceipt, digest: int, grantHeld: bool, messageCurrent: bool): bool =
  dispatchAnswer(ledger, digest, grantHeld, messageCurrent) == DispatchPerformed implies
    (ledger.opState == OpPrepared and ledger.opDigest == digest and grantHeld and messageCurrent)
pure def lawDispatchLeavesPrepared(ledger: OpReceipt, digest: int, grantHeld: bool, messageCurrent: bool, reply: ProviderReply): bool =
  dispatchAnswer(ledger, digest, grantHeld, messageCurrent) == DispatchPerformed implies
    dispatchedLedger(ledger, digest, grantHeld, messageCurrent, reply).opState != OpPrepared
pure def lawRepeatedDispatchAnswersTheReceipt(ledger: OpReceipt, digest: int, grantHeld: bool, messageCurrent: bool, reply: ProviderReply): bool =
  (ledger.opState != OpPrepared) implies dispatchedLedger(ledger, digest, grantHeld, messageCurrent, reply) == ledger
pure def lawSucceededIffProviderResult(ledger: OpReceipt, digest: int, grantHeld: bool, messageCurrent: bool, reply: ProviderReply): bool = {
  val finished = dispatchedLedger(ledger, digest, grantHeld, messageCurrent, reply)
  ((ledger.opState == OpSucceeded) iff ledger.providerResult) implies ((finished.opState == OpSucceeded) iff finished.providerResult)
}
pure def lawSuccessShowsTheRequestedState(kind: MailOpKind, labels: MailLabels, refused: bool, lost: bool): bool =
  providerReplyOf(kind, labels, refused, lost) == ProviderShowsRequested implies showsRequested(kind, labels)
pure def lawLookupNeverPrepares(ledger: OpReceipt, dispatchedSeconds: int): bool =
  (observedLedger(ledger, dispatchedSeconds).opState == OpPrepared) iff (ledger.opState == OpPrepared)
```

### The client accepts a receipt only for its own request, in a known state, with a result exactly when it succeeded

Every prepare, dispatch and lookup reply is version 1 and says the provider
does not apply anything exactly once. Its receipt must echo the request ID
sent, name a known kind and state, and carry a 64-character lowercase hex
review digest, and it carries a provider result exactly when its state is
succeeded; the client refuses anything else. A dispatch is given 45 seconds
before the client stops waiting, and a lost reply is settled only by a
lookup, never by dispatching again.

```quint
type ReceiptWire = { replyVersionOne: bool, exactlyOnceDenied: bool, echoesRequest: bool, knownKind: bool, knownState: bool, digestHexUnits: int, stateSucceeded: bool, resultPresent: bool }
pure val dispatchWaitSeconds = 45
pure def receiptAdmitted(r: ReceiptWire): bool =
  r.replyVersionOne and r.exactlyOnceDenied and r.echoesRequest and r.knownKind and r.knownState and r.digestHexUnits == 64 and (r.stateSucceeded iff r.resultPresent)
pure val rValues = Set(
  { replyVersionOne: true, exactlyOnceDenied: true, echoesRequest: true, knownKind: true, knownState: true, digestHexUnits: 64, stateSucceeded: true, resultPresent: true },
  { replyVersionOne: true, exactlyOnceDenied: true, echoesRequest: true, knownKind: true, knownState: true, digestHexUnits: 64, stateSucceeded: false, resultPresent: true },
  { replyVersionOne: true, exactlyOnceDenied: true, echoesRequest: false, knownKind: true, knownState: true, digestHexUnits: 64, stateSucceeded: false, resultPresent: false },
  { replyVersionOne: true, exactlyOnceDenied: false, echoesRequest: true, knownKind: true, knownState: true, digestHexUnits: 63, stateSucceeded: false, resultPresent: false })
pure def lawForeignReceiptRefused(r: ReceiptWire): bool = not(r.echoesRequest) implies not(receiptAdmitted(r))
pure def lawResultOnlyWithSuccess(r: ReceiptWire): bool = receiptAdmitted(r) implies (r.resultPresent iff r.stateSucceeded)
```
