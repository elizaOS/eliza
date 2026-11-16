# Managed Gmail

A consumer's mail client reads Gmail through the cloud: it searches with a
cursor, reads one message, and opens its formatting and attachment
metadata. The cloud owns route authorization and Google normalization; the
client decodes what the cloud returns and refuses anything it cannot
account for. A reviewed star change is sent once, for the owner, scope and
message revision that were reviewed. Paging across replies, saved reads and
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
