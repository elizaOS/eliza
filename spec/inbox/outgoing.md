# Outgoing mail and its review

What the composer hands to a provider review, and what the review must
answer before [drafts](./drafts.md) reserve its one dispatch: attachments
within the account's policy, the retained recovery copy of an email being
edited, the binding of a review to the email in the composer, and the
request identity a send keeps. [Managed Gmail
operations](../cloud/services/google/mailOperations.md) review the
proposal again on the server.

## Story: Attach files and send exactly the email I reviewed

> As the owner, I want my attachments checked before anything leaves the
> phone, and a send to go out only as the email I reviewed, from the
> composer I reviewed it in.

### Outgoing attachments fit both the account's policy and the shared limits

At most ten files go with one email, fewer when the account's policy says
so; an older server that allows one names that. No two attachments,
including the originals a forward carries, share a name ignoring case. The
combined bytes, the forwarded originals' included, are at most five MiB or
the account's smaller total. A file's size is read from its base64 length
and padding.

```quint
type OutgoingCheck = OutgoingFits | TooManyFiles | DuplicateNames | TooManyBytes
pure val maximumFiles: int = 10
pure val maximumTotalBytes: int = 5242880
pure def smaller(a: int, b: int): int = if (a < b) a else b
pure def outgoingCheck(files: int, distinctNames: bool, totalBytes: int, policyFiles: int, policyBytes: int): OutgoingCheck =
  if (files > smaller(policyFiles, maximumFiles)) TooManyFiles
  else if (not(distinctNames)) DuplicateNames
  else if (totalBytes > smaller(policyBytes, maximumTotalBytes)) TooManyBytes
  else OutgoingFits
pure def encodedBytes(encodedLength: int, padding: int): int = {
  val decodedBytes = encodedLength * 3 / 4 - padding
  if (decodedBytes < 0) 0 else decodedBytes
}
pure val filesValues = Set(0, 1, 2, 10, 11)
pure val totalBytesValues = Set(0, 5242880, 5242881)
pure val policyFilesValues = Set(1, 10, 20)
pure val policyBytesValues = Set(1048576, 5242880, 26214400)
pure def lawFittingAttachmentsStayWithinSharedLimits(files: int, distinctNames: bool, totalBytes: int, policyFiles: int, policyBytes: int): bool =
  outgoingCheck(files, distinctNames, totalBytes, policyFiles, policyBytes) == OutgoingFits implies
    files <= maximumFiles and files <= policyFiles and distinctNames and totalBytes <= maximumTotalBytes and totalBytes <= policyBytes
pure def lawEncodedSizeIsNeverNegative(encodedLength: int, padding: int): bool = encodedLength >= 0 implies encodedBytes(encodedLength, padding) >= 0
```

### A saved attachment of any type is a checked byte copy, never opened

An attachment saved as an opaque copy has a name of 1 to 120 characters
other than `.` and `..`, with no slash, backslash or control character; its
encoding is canonical base64 of at most seven MiB, and its bytes at most
five MiB. Its media type is kept when well formed and is otherwise
`application/octet-stream`. The client decodes the transport base64 to
hash the file bytes and keeps the file opaque. It opens no preview or
viewer. A check the client makes of a downloaded attachment,
or Cloud's answer that it is too large, refuses that file; any other failure
of the download stays what it was.

```quint
type OpaqueFacts = { nameLength: int, nameSafe: bool, canonical: bool, encodedLength: int, decodedBytes: int }
pure def opaqueAdmitted(facts: OpaqueFacts): bool =
  facts.nameLength >= 1 and facts.nameLength <= 120 and facts.nameSafe and facts.canonical and
  facts.encodedLength >= 0 and facts.encodedLength <= 7340032 and facts.decodedBytes >= 0 and facts.decodedBytes <= 5242880
pure val okFacts: OpaqueFacts = { nameLength: 8, nameSafe: true, canonical: true, encodedLength: 12, decodedBytes: 9 }
pure val factsValues = Set(okFacts, { ...okFacts, nameLength: 121 }, { ...okFacts, nameSafe: false },
  { ...okFacts, canonical: false }, { ...okFacts, decodedBytes: 5242881 })
pure def lawUnsafeNameIsRefused(facts: OpaqueFacts): bool = not(facts.nameSafe) implies not(opaqueAdmitted(facts))
pure def lawOversizeCopyIsRefused(facts: OpaqueFacts): bool = facts.decodedBytes > 5242880 implies not(opaqueAdmitted(facts))
```

### The retained recovery copy is read only whole, for its owner, within its bound

Edits being made are kept apart from the saved draft as a recovery copy
that never reaches the provider. It is read only when it is at most 8 MiB
less 16 KiB, its version is one, it belongs to the owner reading it, every
field is one it may hold, the subject is at most 4,096 units, the body at
most 64,000, each recipient list at most 20 entries of at most 4,096 units,
at most 20 attachments, and the recipient search at most 4,096 units. A
copy that fails any of these is refused as needing recovery, never
repaired, and an encoded copy is checked by reading it back.

```quint
type RetainedFacts = { bytes: int, versionOne: bool, sameOwner: bool, knownFields: bool, subjectUnits: int, bodyUnits: int,
  longestList: int, longestRecipient: int, attachmentCount: int, searchUnits: int }
pure val retainedLimit: int = 8372224
pure def retainedAdmitted(retained: RetainedFacts): bool =
  retained.bytes >= 0 and retained.bytes <= retainedLimit and retained.versionOne and retained.sameOwner and retained.knownFields and
  retained.subjectUnits <= 4096 and retained.bodyUnits <= 64000 and retained.longestList <= 20 and retained.longestRecipient <= 4096 and
  retained.attachmentCount <= 20 and retained.searchUnits <= 4096
pure val okRetained: RetainedFacts = { bytes: 100, versionOne: true, sameOwner: true, knownFields: true, subjectUnits: 4, bodyUnits: 10,
  longestList: 1, longestRecipient: 12, attachmentCount: 0, searchUnits: 0 }
pure val retainedValues = Set(okRetained, { ...okRetained, sameOwner: false }, { ...okRetained, bytes: 8372225 },
  { ...okRetained, bodyUnits: 64001 }, { ...okRetained, knownFields: false })
pure def lawForeignCopyIsRefused(retained: RetainedFacts): bool = not(retained.sameOwner) implies not(retainedAdmitted(retained))
pure def lawCopyFitsTheSecureSlot(retained: RetainedFacts): bool = retainedAdmitted(retained) implies retained.bytes <= 8388608 - 16384
```

### A review is confirmed only for the same email in the composer with exactly its reviewed content

A send or draft review remembers the local draft it was made from. At the
tap, the email in the composer is compared with it: none open is absent,
another draft (or a review saved without its draft's identity) is other,
the same draft with different mode, recipients, subject, body,
attachments, forwarded originals or reply source is edited, and only the
same draft with the same content is bound. Only a bound review may reserve
its dispatch; an edited or other review is discarded unsent, and an absent
composer blocks confirmation while the review stays saved.

```quint
type ReviewBinding = BoundReview | EditedReview | OtherReview | AbsentReview
type ComposerView = { open: bool, draftId: str, content: str }
pure def reviewBinding(reviewedDraft: str, reviewedContent: str, composer: ComposerView): ReviewBinding =
  if (not(composer.open)) AbsentReview
  else if (reviewedDraft == "" or composer.draftId == "" or reviewedDraft != composer.draftId) OtherReview
  else if (reviewedContent == composer.content) BoundReview
  else EditedReview
pure val composerValues = Set({ open: false, draftId: "", content: "" }, { open: true, draftId: "d1", content: "c1" },
  { open: true, draftId: "d1", content: "c2" }, { open: true, draftId: "d2", content: "c1" }, { open: true, draftId: "", content: "c1" })
pure val reviewedDraftValues = Set("", "d1")
pure val reviewedContentValues = Set("c1")
pure def lawOnlyTheReviewedEmailConfirms(reviewedDraft: str, reviewedContent: str, composer: ComposerView): bool =
  reviewBinding(reviewedDraft, reviewedContent, composer) == BoundReview implies
    composer.open and reviewedDraft != "" and composer.draftId == reviewedDraft and composer.content == reviewedContent
pure def lawClosedComposerIsAbsent(reviewedDraft: str, reviewedContent: str, composer: ComposerView): bool =
  not(composer.open) implies reviewBinding(reviewedDraft, reviewedContent, composer) == AbsentReview
```

### A send keeps the request identity of the owner turn that asked for it

A send started from an owner's request in conversation carries that
request's identity, so a retry of the same request reaches the same
provider operation and its receipt rather than a second send. The identity
is a canonical UUID and is accepted only for a send from a named local
draft; anything else supplying one is refused before anything is saved.
Without one, a fresh identity is made. The operation's request identity is
then the supplied one, exactly.

```quint
type SourceRequest = NoSourceRequest | SuppliedRequest({ canonicalUuid: bool })
type RequestChoice = FreshRequest | OwnerRequest | RequestRefused
pure def requestChoice(isSend: bool, hasDraft: bool, supplied: SourceRequest): RequestChoice = match supplied {
  | NoSourceRequest => FreshRequest
  | SuppliedRequest(r) => if (isSend and hasDraft and r.canonicalUuid) OwnerRequest else RequestRefused
}
pure val suppliedValues = Set(NoSourceRequest, SuppliedRequest({ canonicalUuid: true }), SuppliedRequest({ canonicalUuid: false }))
pure def lawOwnerIdentityOnlyForADraftSend(isSend: bool, hasDraft: bool, supplied: SourceRequest): bool =
  requestChoice(isSend, hasDraft, supplied) == OwnerRequest implies isSend and hasDraft
pure def lawNoSuppliedIdentityIsFresh(isSend: bool, hasDraft: bool): bool = requestChoice(isSend, hasDraft, NoSourceRequest) == FreshRequest
```

### The server's review must answer exactly the proposal before it can be confirmed

A prepared review is kept only when its receipt names the same request
and kind with a well-formed digest, the review echoes every proposed
field, recipients and subject and body among them, names a sender, lists
exactly the attachment reviews the phone made of the same files, more than
one attachment only from a server that reviews several, and, for a forward,
exactly the requested original parts of the same message and history
within the combined limits. Otherwise nothing is saved as reviewed.

```quint
type ReviewEcho = { receiptMatches: bool, fieldsEchoed: bool, senderNamed: bool, attachmentsMatch: bool, forwardMatches: bool, withinLimits: bool }
pure def reviewAccepted(echo: ReviewEcho): bool =
  echo.receiptMatches and echo.fieldsEchoed and echo.senderNamed and echo.attachmentsMatch and echo.forwardMatches and echo.withinLimits
pure val exactEcho: ReviewEcho = { receiptMatches: true, fieldsEchoed: true, senderNamed: true, attachmentsMatch: true, forwardMatches: true, withinLimits: true }
pure val echoValues = Set(exactEcho, { ...exactEcho, fieldsEchoed: false }, { ...exactEcho, attachmentsMatch: false }, { ...exactEcho, forwardMatches: false })
pure def lawChangedRecipientsAreNeverReviewed(echo: ReviewEcho): bool = not(echo.fieldsEchoed) implies not(reviewAccepted(echo))
```
