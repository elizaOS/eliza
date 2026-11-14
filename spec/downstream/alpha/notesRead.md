# Alpha Notes search, selected read and content contracts

`agent-adapter.ts` exposes the pinned `notes.query.v1` operation through
`notes-query-executor.ts`, the shared Notes client and selected-record
receipt validator. It opens device-local candidates from Home or Notes
under the current owner after the user selects Previous Notes and the agent
advertises the capability. Canonical Notes has separate authored-format
and selected-source semantics through
`plugins/plugin-notes/src/{note-format,note-authored}.ts`, imported by
`canonical-notes-ui.ts`. The [canonical editor](./notes.md) owns its save
lifecycle and [Previous Notes Trash](./notesTrash.md) owns deletion.

## Story: Search private notes and share only what I select

### Local title and chronology selection is distinct from sharing

`notes.query.v1` accepts an exact title request, with nonblank text up
to 256 UTF-16 units and no NUL, or latest created or updated. Candidate
selection is local. Title compares NFKC-folded lowercase strings using
substring matching. Latest compares exact date evidence. A finite
nonnegative integer in Date range or a round-tripping UTC timestamp
is accepted. Updated uses modifiedAt then updatedAt. If several notes
exist and a date is missing, all remain candidates and chronology is
unverified. If latest timestamps tie, only the tied latest candidates
remain, with the same unverified basis. One saved note has only-note
basis for a latest query. Even a sole candidate needs review.

The selected-read target binds collection source, source revision,
note and note revision. The client rechecks its stable raw snapshot
and the exact current owner, scope, Home or Notes context, foreground
and permission before selection, after review and after read. Pending
or failed Notes storage and a sensitive screen are ineligible. A
foreign, blank or checklist record cannot pass this legacy query's
share step. A no-match receipt needs a successful current read.
Cancel, source drift, an extra field or a different result identity
refuses the publication. The approved single record is returned only
with the exact original query and correct basis.

The reducer treats owner, query and receipt scope as normalized facts
and tracks the generation and candidate identity. It does not model the
JavaScript NFKC or UTC parser. Confirmation cannot be reused in a new
view or under a newly admitted query.

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

The renderer's local content filter matches title, body, checklist
items, voice lines and transcript, summaries, actions, link domain
and clips. These inputs stay local. The imported source contains an
additional `notes_search` executor for content or titles and a named
mutation helper. The pinned release does not advertise or call those
executor functions. The shared titles contract allows 1–50 entries,
with each reviewed title at most 500 units, an explicit truncated flag
when more titles exist, and no note bodies.

Canonical rich format uses exact kind and data fields. Kinds are text,
list, voice and link. JSON data is copied without coercion, with limits
of 10,000 nodes, depth 24 and 262,144 serialized UTF-16 units.
Only ordinary or null-prototype objects and finite numbers are accepted.
Prototype-changing keys are rejected. Its authored projection keeps only
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
