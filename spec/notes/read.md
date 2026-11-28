# Notes search, selected read and content contracts

The agent searches the owner's canonical Notes through the
`notes.query.v1` operation, and shares only the note the owner selects
and reviews. The [canonical editor](./client.md) owns the save lifecycle
and [Trash](./trash.md) owns deletion.

## Story: Search private notes and share only what I select

> As the owner, I want the agent to find a note by title or recency, but
> to see only the one note I choose to share, as it is now.

### Local title and chronology selection is distinct from sharing

`notes.query.v1` accepts a title-search request, with nonblank text up
to 256 UTF-16 units and no NUL, or latest created or updated. Candidate
selection is local. Title compares NFKC-folded lowercase strings using
substring matching. Latest compares exact date evidence. A finite
nonnegative integer in Date range or a round-tripping UTC timestamp
is accepted. Updated uses modifiedAt then updatedAt. If several notes
exist and a date is missing, all remain candidates and chronology is
unverified. If latest timestamps tie, only the tied latest candidates
remain, with the same unverified basis. One saved note has only-note
basis for a latest query. Even a sole candidate needs review. The sharing machine receives the
identity selected from those local candidates, or zero for no match.

The selected-read target binds collection source, source revision,
note and note revision. The client rechecks its snapshot and the exact
current owner, scope, Notes context, foreground and permission before
selection, after review and after read. Pending or failed Notes storage
and a sensitive screen are ineligible. A foreign, blank or checklist
record cannot pass the share step. A no-match receipt needs a successful current read.
Cancel, source drift, an extra field or a different result identity
refuses the publication. The approved single record is returned only
with the exact original query and correct basis.

Confirmation cannot be reused in a new view or under a newly admitted
query.

```quint
type QueryKind = ByTitle | ByLatest
type CandidateBasis = NoMatch | TitleMatch | OnlyNote | Latest | Uncertain
pure def notesBasis(queryKind: QueryKind, count: int, matches: int, allDatesKnown: bool, ties: int): CandidateBasis =
  if (count <= 0 or (queryKind == ByTitle and matches <= 0)) NoMatch
  else if (queryKind == ByTitle) TitleMatch
  else if (count == 1) OnlyNote
  else if (not(allDatesKnown) or ties != 1) Uncertain
  else Latest
pure def lawUnknownDateCannotAssertLatest(count: int, matches: int, ties: int): bool =
  count > 1 implies notesBasis(ByLatest, count, matches, false, ties) == Uncertain
type NoteReadPhase = Idle | Choosing | Approved | Shared | NoResult | Refused
type NoteRead = { phase: NoteReadPhase, generation: int, candidate: int, selected: int, queryRevision: int, receipt: int }
pure val initial: NoteRead = { phase: Idle, generation: 0, candidate: 0, selected: 0, queryRevision: 0, receipt: 0 }
pure def canStartQuery(s: NoteRead, revision: int, candidateId: int): bool =
  s.phase != Choosing and s.phase != Approved and revision > 0 and candidateId >= 0
pure def startQuery(s: NoteRead, revision: int, candidateId: int): NoteRead =
  { ...initial, generation: s.generation + 1, phase: if (candidateId == 0) NoResult else Choosing, candidate: candidateId, queryRevision: revision }
pure def canApproveShare(s: NoteRead, noteId: int, generationId: int, revision: int): bool =
  s.phase == Choosing and noteId == s.candidate and generationId == s.generation and revision == s.queryRevision
pure def approveShare(s: NoteRead, noteId: int, generationId: int, revision: int): NoteRead =
  { ...s, phase: Approved, selected: noteId }
pure def canFinishShare(s: NoteRead, noteId: int, generationId: int, revision: int, exactFields: bool): bool =
  s.phase == Approved and noteId == s.selected and generationId == s.generation and revision == s.queryRevision and exactFields
pure def finishShare(s: NoteRead, noteId: int, generationId: int, revision: int, exactFields: bool): NoteRead =
  { ...s, phase: Shared, receipt: noteId }
pure def canRetireQuery(s: NoteRead): bool = s.phase == Choosing or s.phase == Approved
pure def retireQuery(s: NoteRead): NoteRead = { ...initial, phase: Refused, generation: s.generation + 1 }
pure def alwaysSelectionsHaveCandidate(s: NoteRead): bool =
  (s.phase == Choosing or s.phase == Approved or s.phase == Shared) implies s.candidate > 0 and s.queryRevision > 0
pure def alwaysApprovedIdentity(s: NoteRead): bool =
  (s.phase == Approved or s.phase == Shared) implies s.selected == s.candidate
pure def alwaysOnlySharedCarriesReceipt(s: NoteRead): bool =
  if (s.phase == Shared) s.receipt == s.selected and s.receipt > 0 else s.receipt == 0
pure def alwaysGenerationNonnegative(s: NoteRead): bool = s.generation >= 0
pure def stepPublishFromReviewedSelection(before: NoteRead, via: str, after: NoteRead): bool =
  via == "finishShare" implies before.phase == Approved and after.receipt == before.candidate
pure def lawOldQueryCannotPublish(s: NoteRead, noteId: int, generationId: int, revision: int, exactFields: bool): bool =
  generationId != s.generation or revision != s.queryRevision implies not(canFinishShare(s, noteId, generationId, revision, exactFields))
pure def sometimesSharesReviewedNote(s: NoteRead): bool = s.phase == Shared
pure def sometimesFindsNoMatch(s: NoteRead): bool = s.phase == NoResult and s.receipt == 0
pure val candidateIdValues = Set(0, 1, 2)
pure val generationIdValues = Set(1, 2, 3, 4)
pure val revisionValues = Set(1, 2)
pure val noteIdValues = Set(1, 2)
pure val weight_startQuery = 4
pure val weight_approveShare = 8
pure val weight_finishShare = 8
```

### A query receipt carries the original query, an allowed basis and a record only on a match

The device answers a `notes.query.v1` operation with a receipt that repeats
the query exactly as asked. A title query's receipt is a title match or no
match; a latest query's receipt is latest, only note, the owner's uncertain
choice, or no match. A no-match receipt carries no note and no record; every
other receipt carries the one selected note and its record. The basis the
device computes is always one its query allows.

```quint
type QueryReceipt = { sameQuery: bool, basis: CandidateBasis, carriesRecord: bool }
pure def receiptBasisAllowed(queryKind: QueryKind, basis: CandidateBasis): bool =
  basis == NoMatch or (if (queryKind == ByTitle) basis == TitleMatch else (basis == Latest or basis == OnlyNote or basis == Uncertain))
pure def queryReceiptAdmitted(queryKind: QueryKind, receipt: QueryReceipt): bool =
  receipt.sameQuery and receiptBasisAllowed(queryKind, receipt.basis) and receipt.carriesRecord == (receipt.basis != NoMatch)
pure val receiptValues = Set({ sameQuery: true, basis: TitleMatch, carriesRecord: true }, { sameQuery: true, basis: NoMatch, carriesRecord: true }, { sameQuery: false, basis: Latest, carriesRecord: true }, { sameQuery: true, basis: Uncertain, carriesRecord: true })
pure val countValues = Set(0, 1, 3)
pure val matchesValues = Set(0, 2)
pure val tiesValues = Set(1, 2)
pure def lawTitleReceiptIsATitleMatch(receipt: QueryReceipt): bool =
  queryReceiptAdmitted(ByTitle, receipt) implies (receipt.basis == TitleMatch or receipt.basis == NoMatch)
pure def lawNoMatchCarriesNoRecord(queryKind: QueryKind, receipt: QueryReceipt): bool =
  (queryReceiptAdmitted(queryKind, receipt) and receipt.basis == NoMatch) implies not(receipt.carriesRecord)
pure def lawComputedBasisIsAllowed(queryKind: QueryKind, count: int, matches: int, allDatesKnown: bool, ties: int): bool =
  receiptBasisAllowed(queryKind, notesBasis(queryKind, count, matches, allDatesKnown, ties))
```

### Wire and authored content have different boundaries

Selected device reads return exactly title and body under the reviewed
record identity. The limit is 256 UTF-16 units for title, 32,000 for body
and 60,000 bytes for the JSON of those two fields. NUL is invalid.
An oversized record fails explicitly. It cannot return silently shortened
body data. The selected result shape includes version, kind, source,
note, revision and those two fields. The source revision binds admission
but is not repeated in the result. Update or delete receipts carry no
fields. Delete and selected read retain the exact reviewed note revision.
An update returns its newly stored revision.

The local content filter matches title, body, checklist items, voice
lines and transcript, summaries, actions, link domain and clips, and its
inputs stay on the device. The shared titles contract allows 1–50 entries,
with each reviewed title at most 500 units, an explicit truncated flag
when more titles exist, and no note bodies.

Canonical rich format uses exact kind and data fields. Kinds are text,
list, voice and link. JSON data is copied without coercion, with limits
of 10,000 nodes, depth 24 and 262,144 serialized UTF-16 units.
Only plain objects and finite numbers are accepted. Its authored projection keeps only
per-kind authored text arrays, original indexes and valid checklist
state. Speaker IDs, attached audio, source and attachment handles
are excluded. A rich replacement compares the index, expected exact
text, format kind and collection revision. Append adds an unchecked,
nonblank checklist item. Other stored fields remain intact.
For explicitly requested copy, share or export, the selected note's
text is serialized by kind. Voice export shows stored transcript or
lines, stored summary and actions. With no transcript it says so.
The export carries no recording bytes.

```quint
type AuthoredKind = PlainNote | ChecklistNote | VoiceNote | LinkNote
type AuthoredField = ChecklistItem | TranscriptLine | VoiceSummary | VoiceAction | LinkClip | Speaker | Audio | SourceHandle | Attachment
pure def authoredField(kind: AuthoredKind, viewField: AuthoredField): bool =
  (kind == ChecklistNote and viewField == ChecklistItem) or
  (kind == VoiceNote and (viewField == TranscriptLine or viewField == VoiceSummary or viewField == VoiceAction)) or
  (kind == LinkNote and viewField == LinkClip)
pure def transferFieldsAdmitted(titleUnits: int, bodyUnits: int, encodedBytes: int, noNul: bool): bool =
  noNul and titleUnits >= 0 and titleUnits <= 256 and bodyUnits >= 0 and bodyUnits <= 32000 and encodedBytes >= 0 and encodedBytes <= 60000
pure def formatBounds(nodes: int, depth: int, encodedUnits: int, safeShape: bool): bool =
  safeShape and nodes > 0 and nodes <= 10000 and depth >= 0 and depth <= 24 and encodedUnits >= 0 and encodedUnits <= 262144
pure def lawNoInternalHandles(kind: AuthoredKind, viewField: AuthoredField): bool =
  (viewField == Speaker or viewField == Audio or viewField == SourceHandle or viewField == Attachment) implies not(authoredField(kind, viewField))
pure def lawOversizeCannotTransfer(titleUnits: int, bodyUnits: int, encodedBytes: int, noNul: bool): bool =
  (titleUnits > 256 or bodyUnits > 32000 or encodedBytes > 60000) implies not(transferFieldsAdmitted(titleUnits, bodyUnits, encodedBytes, noNul))
pure def lawUnsafeFormatFails(nodes: int, depth: int, encodedUnits: int): bool =
  not(formatBounds(nodes, depth, encodedUnits, false))
```

## Story: Ask about or change a phone note in my own words

> As the owner, I want the agent to propose reading, deleting or changing a
> note on my phone only for the note I named or have open, and to prepare an
> edit only from the note I shared, so that it never touches a note I did not
> mean.

### A phone Notes operation is offered only where the turn's own screen selects the phone's Notes

A turn offers the phone's Notes operations from its own observation.
A lookup the phone resolves itself (a title or latest query, a content or
titles search, a named delete) is offered from Home or the Notes view,
never while a canonical Notes record or source is selected. Sharing,
deleting, moving or editing one exact note is offered only in the Notes
view with a phone note selected whose target reads as a note target. The
canonical list filter is offered only while the canonical Notes list is
shown. Filtering by folder or kind, creating a folder, restoring and
recording are offered by their capabilities alone on a turn with no
observation, and otherwise only where [organizing](./organize.md) admits
them: never on a sensitive screen, recording only in Notes, the rest only
in Home or Notes. With no observation, on a sensitive screen, or in the
Notes view with a phone Notes selection that does not read, nothing else is
offered. Every operation also needs what its device-action need names; a
canonical Notes request uses the agent's own Notes actions.

```quint
type PhoneScreen = PhoneHome | PhoneNotes | PhoneElsewhere
type NotesSelection = NothingSelected | PhoneNoteSelected | PhoneSourceSelected | UnreadablePhoneSelection | CanonicalNotesSelected | OtherRecordSelected
type PhoneNotesReach = ResolvedByPhone | ExactPhoneNote | CanonicalListOnly | ByCapability
pure def phoneNotesReadable(sensitive: bool, screen: PhoneScreen, selection: NotesSelection): bool =
  not(sensitive) and not(screen == PhoneNotes and selection == UnreadablePhoneSelection)
pure def phoneNotesOffered(reach: PhoneNotesReach, observed: bool, sensitive: bool, screen: PhoneScreen, selection: NotesSelection, canonicalList: bool, organizeAdmitted: bool): bool =
  if (reach == ByCapability) not(observed) or organizeAdmitted
  else if (not(observed) or not(phoneNotesReadable(sensitive, screen, selection))) false
  else if (reach == ExactPhoneNote) screen == PhoneNotes and selection == PhoneNoteSelected
  else if (reach == CanonicalListOnly) screen == PhoneNotes and canonicalList
  else (screen == PhoneHome or screen == PhoneNotes) and selection != CanonicalNotesSelected
pure def lawAnExactNoteIsTheOpenPhoneNote(observed: bool, sensitive: bool, screen: PhoneScreen, selection: NotesSelection, canonicalList: bool, organizeAdmitted: bool): bool =
  phoneNotesOffered(ExactPhoneNote, observed, sensitive, screen, selection, canonicalList, organizeAdmitted) implies
    (observed and not(sensitive) and screen == PhoneNotes and selection == PhoneNoteSelected)
pure def lawASensitiveScreenOffersNoPhoneRecord(reach: PhoneNotesReach, observed: bool, screen: PhoneScreen, selection: NotesSelection, canonicalList: bool, organizeAdmitted: bool): bool =
  reach != ByCapability implies not(phoneNotesOffered(reach, observed, true, screen, selection, canonicalList, organizeAdmitted))
pure def lawAnObservedScreenGatesOrganizing(sensitive: bool, screen: PhoneScreen, selection: NotesSelection, canonicalList: bool): bool =
  not(phoneNotesOffered(ByCapability, true, sensitive, screen, selection, canonicalList, false))
pure def lawACanonicalSelectionKeepsPhoneLookupsOff(observed: bool, sensitive: bool, screen: PhoneScreen, canonicalList: bool, organizeAdmitted: bool): bool =
  not(phoneNotesOffered(ResolvedByPhone, observed, sensitive, screen, CanonicalNotesSelected, canonicalList, organizeAdmitted))
pure def lawALookupWorksFromHome(selection: NotesSelection, organizeAdmitted: bool): bool =
  selection != CanonicalNotesSelected implies phoneNotesOffered(ResolvedByPhone, true, false, PhoneHome, selection, false, organizeAdmitted)
```

### A phone note proposal names only words the owner said and only the note the owner has open

A title query, a content search and a named delete or edit carry text
that appears as a whole phrase, case and spacing aside, in the owner's own
words in this message; anything else proposes nothing, and the owner is
asked which note. A latest query and a titles list carry no text. Sharing,
deleting, moving or editing an exact note targets exactly the phone note
open in Notes: another target is refused. The model asks for a named edit
as a named update with the name and empty fields, offered wherever a named
delete is, and for an edit of the open note as its update with empty
fields. A title or latest lookup carries the model's intent for it, read,
edit or delete, which the agent keeps with the lookup and never sends to the
phone; an edit or delete intent the agent cannot keep proposes nothing, and
the owner hears that the lookup cannot be made. A lookup with the edit or
delete intent needs words of the owner's own in this message: one whose
text is all an external envelope proposes nothing, and the owner is asked
which note. A named edit is proposed as the title lookup of that name with the
edit intent, never with the model's replacement fields, and only when the
phone negotiated the lookup; an edit of the open note is proposed as its
selected read with the edit intent, never with replacement fields, and any
other selected read is a read. Either edit, and a lookup with the edit or
delete intent, is proposed only when the launch completes reads, so the
shared note comes back to this conversation; otherwise nothing is proposed,
nothing is read, and the owner hears that the edit, or for a delete intent
the deletion, cannot be prepared. The prompt to share or choose a note tells the
owner that sharing changes nothing and that any change gets its own review.
A restore names only a note an applied deletion of this conversation moved
to Recently deleted; any other note ID proposes nothing.

```quint
type PhoneNotesProposal = TitleLookup | LatestLookup | ContentSearch | TitlesList | NamedDelete | NamedEdit | OpenNoteTarget | OpenNoteEdit | RestoreDeleted | OtherPhoneNotes
type PhoneNotesGrounding = GroundedAsProposed | GroundedAsTitleLookup | GroundedAsSelectedRead | AskWhichNote | NotTheOpenNote | LookupUnavailable | EditUnavailable | RestoreUnknown
pure def carriesOwnerText(proposal: PhoneNotesProposal): bool =
  proposal == TitleLookup or proposal == ContentSearch or proposal == NamedDelete or proposal == NamedEdit
pure def targetsOpenNote(proposal: PhoneNotesProposal): bool = proposal == OpenNoteTarget or proposal == OpenNoteEdit
pure def editsANote(proposal: PhoneNotesProposal): bool = proposal == NamedEdit or proposal == OpenNoteEdit
pure def lookupAsksAChange(proposal: PhoneNotesProposal, changeAsked: bool): bool =
  changeAsked and (proposal == TitleLookup or proposal == LatestLookup)
pure def changesANote(proposal: PhoneNotesProposal, changeAsked: bool): bool =
  editsANote(proposal) or lookupAsksAChange(proposal, changeAsked)
pure def groundPhoneNotes(proposal: PhoneNotesProposal, inOwnerWords: bool, matchesOpenNote: bool, lookupNegotiated: bool, deletedHere: bool, readsComplete: bool, changeAsked: bool): PhoneNotesGrounding =
  if ((carriesOwnerText(proposal) or lookupAsksAChange(proposal, changeAsked)) and not(inOwnerWords)) AskWhichNote
  else if (targetsOpenNote(proposal) and not(matchesOpenNote)) NotTheOpenNote
  else if (changesANote(proposal, changeAsked) and not(readsComplete)) EditUnavailable
  else if (proposal == NamedEdit) (if (lookupNegotiated) GroundedAsTitleLookup else LookupUnavailable)
  else if (proposal == OpenNoteEdit) GroundedAsSelectedRead
  else if (proposal == RestoreDeleted and not(deletedHere)) RestoreUnknown
  else GroundedAsProposed
pure def proposes(grounding: PhoneNotesGrounding): bool =
  grounding == GroundedAsProposed or grounding == GroundedAsTitleLookup or grounding == GroundedAsSelectedRead
pure def lawUnsaidTextIsNeverProposed(proposal: PhoneNotesProposal, matchesOpenNote: bool, lookupNegotiated: bool, deletedHere: bool, readsComplete: bool, changeAsked: bool): bool =
  carriesOwnerText(proposal) implies groundPhoneNotes(proposal, false, matchesOpenNote, lookupNegotiated, deletedHere, readsComplete, changeAsked) == AskWhichNote
pure def lawAChangeLookupNeedsTheOwnersWords(proposal: PhoneNotesProposal, matchesOpenNote: bool, lookupNegotiated: bool, deletedHere: bool, readsComplete: bool): bool =
  lookupAsksAChange(proposal, true) implies groundPhoneNotes(proposal, false, matchesOpenNote, lookupNegotiated, deletedHere, readsComplete, true) == AskWhichNote
pure def lawANamedEditIsALookupFirst(inOwnerWords: bool, matchesOpenNote: bool, lookupNegotiated: bool, deletedHere: bool, readsComplete: bool, changeAsked: bool): bool =
  groundPhoneNotes(NamedEdit, inOwnerWords, matchesOpenNote, lookupNegotiated, deletedHere, readsComplete, changeAsked) != GroundedAsProposed
pure def lawAnOpenNoteEditIsItsReadFirst(inOwnerWords: bool, matchesOpenNote: bool, lookupNegotiated: bool, deletedHere: bool, readsComplete: bool, changeAsked: bool): bool =
  groundPhoneNotes(OpenNoteEdit, inOwnerWords, matchesOpenNote, lookupNegotiated, deletedHere, readsComplete, changeAsked) != GroundedAsProposed
pure def lawAnEditIsReadOnlyWhereItsReadComesBack(proposal: PhoneNotesProposal, inOwnerWords: bool, matchesOpenNote: bool, lookupNegotiated: bool, deletedHere: bool, changeAsked: bool): bool =
  changesANote(proposal, changeAsked) implies not(proposes(groundPhoneNotes(proposal, inOwnerWords, matchesOpenNote, lookupNegotiated, deletedHere, false, changeAsked)))
pure def lawAReadLookupNeedsNoReturnedRead(proposal: PhoneNotesProposal, matchesOpenNote: bool, lookupNegotiated: bool, deletedHere: bool): bool =
  (proposal == TitleLookup or proposal == LatestLookup) implies groundPhoneNotes(proposal, true, matchesOpenNote, lookupNegotiated, deletedHere, false, false) == GroundedAsProposed
pure def lawAnotherNoteIsNotTheOpenOne(proposal: PhoneNotesProposal, inOwnerWords: bool, lookupNegotiated: bool, deletedHere: bool, readsComplete: bool, changeAsked: bool): bool =
  targetsOpenNote(proposal) implies groundPhoneNotes(proposal, inOwnerWords, false, lookupNegotiated, deletedHere, readsComplete, changeAsked) == NotTheOpenNote
pure def lawOnlyADeletedNoteIsRestored(inOwnerWords: bool, matchesOpenNote: bool, lookupNegotiated: bool, readsComplete: bool, changeAsked: bool): bool =
  groundPhoneNotes(RestoreDeleted, inOwnerWords, matchesOpenNote, lookupNegotiated, false, readsComplete, changeAsked) == RestoreUnknown
```

### A phone note is edited only from the note the owner shared, in a review of its own

An edit of a phone note is proposed as its read with the edit intent: the
open note's selected read, or a title lookup. Once the owner shares that
note, the owner's original request is read against the shared text, and a
change it asks for is offered for its own review, bound to the original
message and to the shared note's target, with the answer "The note is
ready for update review. Confirm the requested changes; nothing has changed
yet." A read without the edit intent only answers the read and is never
read for an edit. A request that needs more input answers with the
question the reading asked, or "The requested note edit needs
clarification. Nothing was changed."; one that changes nothing answers "No
requested note change was resolved. Nothing was changed." Either way
nothing is offered. A lookup that matched no note, matched by recency or
left the choice uncertain offers no edit. The change keeps every field the
request does not name, appends a list item in the note's own list form,
appends to an empty body from its first new line, and a change that leaves
both fields as they were is no change.

```quint
type SharedRead = OpenNote | TitleMatchedNote | OtherLookupResult
type EditReading = ChangeRequested | NothingToChange | NeedsMoreInput
type EditReply = OffersEditReview | AsksForTheEdit | SaysNothingChanged | AnswersTheRead
pure def editRead(shared: SharedRead, editIntent: bool): bool =
  editIntent and shared != OtherLookupResult
pure def editReply(shared: SharedRead, editIntent: bool, reading: EditReading): EditReply =
  if (not(editRead(shared, editIntent))) AnswersTheRead
  else if (reading == ChangeRequested) OffersEditReview
  else if (reading == NeedsMoreInput) AsksForTheEdit
  else SaysNothingChanged
pure def editOffered(shared: SharedRead, editIntent: bool, reading: EditReading): bool =
  editReply(shared, editIntent, reading) == OffersEditReview
pure def lawOnlyAnEditIntentIsEdited(shared: SharedRead, reading: EditReading): bool =
  not(editRead(shared, false)) and editReply(shared, false, reading) == AnswersTheRead
pure def lawNoEditWithoutAChange(shared: SharedRead, editIntent: bool): bool =
  not(editOffered(shared, editIntent, NothingToChange)) and not(editOffered(shared, editIntent, NeedsMoreInput))
pure def lawAnUnresolvedLookupIsNotEdited(editIntent: bool, reading: EditReading): bool =
  not(editOffered(OtherLookupResult, editIntent, reading))
pure def lawAnAskedEditOfASharedNoteIsAnswered(shared: SharedRead, reading: EditReading): bool =
  shared != OtherLookupResult implies editReply(shared, true, reading) != AnswersTheRead
```
