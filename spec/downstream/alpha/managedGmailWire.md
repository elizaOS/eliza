# Alpha managed Gmail search and message wire

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` uses
`apps/app/src/runtime/cloud-protocol.ts` and
`apps/app/src/prototype/inbox-cloud-adapter.ts` to call Eliza gitlink
`c518127a025ab173874af9c7d304f26b25213b0d`'s
`plugins/plugin-inbox/src/mailbox/{managed-gmail-client,types,links}.ts`.
Cloud owns production route authorization and Google normalization in
`packages/cloud/api/v1/eliza/google/gmail/{search,read}/route.ts`
and `packages/cloud/shared/src/lib/services/agent-google-connector/gmail.ts`.
Inbox owns paging across replies, saved reads and cache custody. The
managed Google contract owns the distinct agent broker and reviewed
mutations.

## Story: Read my Gmail results through the connected owner account

### A search request and a search response have distinct cursor boundaries

Alpha injects its authenticated Cloud request function and typed
`invalid-response` error. The client sends one GET to the configured
Cloud API origin with no request body, using
`/api/v1/eliza/google/gmail/search` or
`/api/v1/eliza/google/gmail/read`. Both use URL search parameters
including `side=owner` and a nonblank grant ID. Search adds a
nonblank query, a requested page size, and the optional request
cursor. Read adds a nonblank message ID. Nonblank uses JavaScript
trim to admit but sends the original string. Alpha's typed search
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
catalog parameters are sent on Alpha's search. The separate
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

Links absent means an empty list. A present field must be an array
with at most 200 entries. Each invalid link row is discarded. An
admitted row has an object, string href of at most 2,048 UTF-16
units and string label. WHATWG URL parsing must produce an absolute
HTTP or HTTPS URL with hostname and no credentials. Keep serialized
canonical hrefs, deduplicating first in order. Replace ASCII
control runs with spaces in labels, collapse whitespace, trim,
and slice to 200 UTF-16 units. Use host name when the label is
empty. Return the first 50 distinct accepted links and include
an omitted count only when at least one additional safe link
was left out. The renderer later exposes HTTPS in reviewed link
controls. Rendering the wire links performs no request.

`bodyHtml` absent, null or empty leaves only plain text. A
nonstring present value is invalid. A nonempty string through
524,288 UTF-8 bytes is kept whole at this boundary, otherwise
omit it and set `bodyHtmlOmitted: true`. Plain text is returned
whole as given by the renderer route, including when HTML is
omitted. Cloud's owner HTML extraction can already return null
with a separate status. The renderer ignores that status when
normalizing the wire. The renderer applies HTML sanitization and
restrictive document policy later in `mail-html.ts`. Remote
HTTPS images require the current display choice or saved opt-in.
That DOM policy and upstream MIME extraction are source fixture
boundaries of this model.

The agent broker's marked partial 32,000 UTF-16 behavior and the
replacement's explicit oversize refusal remain in the managed
Google contract. The renderer read has no such plain-text cap.
Its HTML display limit does not truncate the model-facing body.
UTF-8 byte measurements, URL parse facts and label cleaning are
supplied by the corresponding adapters.

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
