# Canonical Calendar read and saved visibility

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` consumes the
Eliza `c518127a025ab173874af9c7d304f26b25213b0d` Calendar
feed, source summaries and next-event interfaces through
`apps/app/src/runtime/{agent-calendar,agent-calendar-client,agent-calendar-view}.ts`.
The pinned Alpha precedents are `AgentCalendarRefresh.qnt` and
`SavedServiceRead.qnt`. The resident Calendar service owns app records.
The [native Calendar read](./calendarAvailabilityData.md) and
[Calendar mutations](./calendarDraft.md) have separate authority.

## Story: See my previous Calendar while my resident connection starts

### A retained snapshot is read-only and belongs to this credential, owner and window

The last verified owner record is scoped inside the credential's
read cache. Its version is one. The encoded owner is a three-part
tuple of exact origin, owner and agent. Its origin is canonical
HTTP or HTTPS without credentials. The nonempty tuple strings
each have at most 1,024 UTF-16 units. Owner encoding and scope
have at most 4,096. The feed key additionally includes the
serialized request. Its row version, owner, agent and query agree
with the capture. Any supplied window endpoints match by timestamp.
A refusal timestamp hides same-owner and scope entries whose save
timestamp is equal or older. In-process refusal still hides old
entries when writing the refusal to storage fails.

The retained snapshot passes schema and source binding. Each
source needs the expected string, nullable string, boolean and
nonnegative safe selection version fields. The source identity is
provider, side, grant, connector account and calendar. It appears
once. The feed's stated coverage and source are recognized, its
window is strictly ordered, and its synchronization time is null
or a parsed time. Rows have typed event identity, textual data,
a positive time range, typed attendees and optional recurrence.
Every row must name this agent and exactly one selected feed
source with owner, writer or reader access. Parser, nested field
validation and digest equality are checked inputs to the model.

Before boot presentation, preserve the legacy local records. A
failed or pending preservation read refuses the restore. Existing
legacy records need an owner receipt for the exact retained
fingerprint. Recheck current credentials, no resident and
no running resident read. Verify the captured credential again
after asynchronously computing source revisions. A later owner
change or resident connection preempts saved publication. Saved
rows may inform presentation only. They contribute no selected
event revision and no verified next event.

```quint
type CalendarFeedState = CompleteCalendarFeed | PartialCalendarFeed | UnavailableCalendarFeed
type SavedCalendarIdentity = { credentialKey: int, ownerId: int, agentId: int, scopeKey: int, queryKey: int }
type SavedCalendarEvidence = { ownerCodecValid: bool, payloadCodecValid: bool, sourcesUnique: bool,
  eventRowsOwnAgentAndSource: bool, requestedWindowMatches: bool, legacyReadable: bool, legacyPending: bool,
  legacyPresent: bool, retainedLegacy: bool, currentCredential: bool, verifiedCredential: bool,
  residentReady: bool, residentReading: bool, locallyRefused: bool, refusalExists: bool, savedAt: int, refusedAt: int }
pure def mayShowSavedCalendar(captured: SavedCalendarIdentity, expected: SavedCalendarIdentity, evidence: SavedCalendarEvidence): bool =
  captured == expected and evidence.ownerCodecValid and evidence.payloadCodecValid and evidence.sourcesUnique and
  evidence.eventRowsOwnAgentAndSource and evidence.requestedWindowMatches and evidence.legacyReadable and
  not(evidence.legacyPending) and (not(evidence.legacyPresent) or evidence.retainedLegacy) and
  evidence.currentCredential and evidence.verifiedCredential and not(evidence.residentReady or evidence.residentReading) and
  not(evidence.locallyRefused or (evidence.refusalExists and evidence.savedAt <= evidence.refusedAt))
pure def savedCalendarCanSelect(hasSavedTimestamp: bool, present: bool, exactSource: bool, etagPresent: bool, grantPresent: bool): bool =
  not(hasSavedTimestamp) and present and exactSource and etagPresent and grantPresent
pure def lawNoSavedCalendarSelection(present: bool, exactSource: bool, etagPresent: bool, grantPresent: bool): bool =
  not(savedCalendarCanSelect(true,present,exactSource,etagPresent,grantPresent))
pure def lawShowOnlyCurrentCalendarCredential(captured: SavedCalendarIdentity, expected: SavedCalendarIdentity,
  evidence: SavedCalendarEvidence): bool =
  mayShowSavedCalendar(captured,expected,evidence) implies captured == expected and evidence.currentCredential and evidence.verifiedCredential
pure def lawOlderSnapshotCannotOutliveRefusal(captured: SavedCalendarIdentity, expected: SavedCalendarIdentity,
  evidence: SavedCalendarEvidence): bool =
  (evidence.locallyRefused or (evidence.refusalExists and evidence.savedAt <= evidence.refusedAt)) implies
  not(mayShowSavedCalendar(captured,expected,evidence))
pure val savedIdentity: SavedCalendarIdentity = { credentialKey: 1, ownerId: 1, agentId: 1, scopeKey: 1, queryKey: 1 }
pure val capturedValues = Set(savedIdentity, { ...savedIdentity, ownerId: 2 }, { ...savedIdentity, credentialKey: 2 },
  { ...savedIdentity, queryKey: 2 }, { ...savedIdentity, scopeKey: 2 })
pure val expectedValues = capturedValues
pure val savedEvidence: SavedCalendarEvidence = { ownerCodecValid: true, payloadCodecValid: true, sourcesUnique: true,
  eventRowsOwnAgentAndSource: true, requestedWindowMatches: true, legacyReadable: true, legacyPending: false,
  legacyPresent: false, retainedLegacy: false, currentCredential: true, verifiedCredential: true,
  residentReady: false, residentReading: false, locallyRefused: false, refusalExists: false, savedAt: 12, refusedAt: 0 }
pure val evidenceValues = Set(savedEvidence, { ...savedEvidence, residentReady: true }, { ...savedEvidence, locallyRefused: true },
  { ...savedEvidence, refusalExists: true, refusedAt: 12 }, { ...savedEvidence, refusalExists: true, refusedAt: 11 },
  { ...savedEvidence, eventRowsOwnAgentAndSource: false }, { ...savedEvidence, legacyPresent: true },
  { ...savedEvidence, legacyPresent: true, retainedLegacy: true }, { ...savedEvidence, verifiedCredential: false })
```

## Story: Refresh my current Calendar without showing a false next-event confirmation

### Refresh shares the current read and preserves accepted writes

Binding is the resident origin, owner and agent, plus session and
scope. A repeated same-binding, same-query read coalesces to one
trailing refresh and invalidates next-event freshness. During an
accepted mutation, the latest refresh also waits. A changed query
or owner cancels outstanding reads and must prepare its own
capture. Completion of an obsolete read cannot publish or drain
the current read's trailing request. A new port must be current.

```quint
type RefreshDecision = WaitForCalendarWrite | QueueTrailingCalendarRead | BeginCalendarRead | ClearCalendarView
pure def decideCalendarRefresh(mutating: bool, reading: bool, portCurrent: bool, bindingMatches: bool, queryMatches: bool): RefreshDecision =
  if (mutating) WaitForCalendarWrite
  else if (reading and portCurrent and bindingMatches and queryMatches) QueueTrailingCalendarRead
  else if (portCurrent) BeginCalendarRead else ClearCalendarView
pure def trailingCalendarReadAdmitted(readIsCurrent: bool, generationMatches: bool, trailingRequested: bool): bool =
  readIsCurrent and generationMatches and trailingRequested
pure def lawCalendarReadDoesNotPreemptWrite(reading: bool, portCurrent: bool, bindingMatches: bool, queryMatches: bool): bool =
  decideCalendarRefresh(true,reading,portCurrent,bindingMatches,queryMatches) == WaitForCalendarWrite
pure def lawObsoleteCalendarReadCannotDrain(generationMatches: bool, trailingRequested: bool): bool =
  not(trailingCalendarReadAdmitted(false,generationMatches,trailingRequested))
```

### Verified presentation needs the current feed and an owned, unexpired next result

Legacy capture happens before the resident reads. Its unreadable or
pending state clears the view to legacy recovery. A readable but
unretained snapshot opens transition review. Otherwise the controller
starts feed, source and next reads together; a valid saved read can
fill the current presentation before the live result settles.
A late saved read cannot replace that result.

A 401 or 403 from feed or source immediately clears feed, sources and
next, sets a same-credential owner and scope refusal, and attempts
to clear the current saved entry and retain the refusal time.
A next-only HTTP error follows the failed-next path. A successful
sources read withdraws an earlier saved feed containing a row whose
included authorized source disappeared. The live feed's requested
dates and each event's agent must match. Integrity errors clear live
and saved presentation. Ordinary failures while revalidating can
retain the current shown feed but drop verified next. A rejected next
read may keep a still-owned unexpired prior next event unverified.
The source list and deployed service are still responsible for
authoritative live feed rows. The renderer does not validate every
live row against source membership the way its saved decoder does.

The next event's source must be included and have owner, writer or
reader access, even on a visible feed that includes hidden calendars.
A nonempty connector account on the event must also match. Its
event agent must be this resident. An event ending at or before the
phone clock is dropped. A next result can report a verified empty
window when both feed and next coverage are complete. A rejected,
ended or partial result cannot claim this. A complete fresh feed
clears the in-process refusal; a newer stored row can supersede the
retained cutoff for its own query. Writes, transport and timestamp
conversion remain effects.

```quint
type CalendarReadResult = { currentBinding: bool, legacyReadable: bool, legacyPending: bool,
  legacyPresent: bool, retainedLegacy: bool, admissionRefused: bool, integrityFault: bool,
  sourceFailed: bool, feedFailed: bool, revalidating: bool, savedStillVisible: bool }
type CalendarPublication = DiscardCalendarResult | RecoverLegacyCalendar | ReviewCalendarTransition |
  RefuseCalendarAccess | DropUntrustedCalendar | RetainUnverifiedFeed | CalendarReadFailed | PublishCalendarFeed
pure def calendarPublication(result: CalendarReadResult): CalendarPublication =
  if (not(result.currentBinding)) DiscardCalendarResult
  else if (not(result.legacyReadable) or result.legacyPending) RecoverLegacyCalendar
  else if (result.legacyPresent and not(result.retainedLegacy)) ReviewCalendarTransition
  else if (result.admissionRefused) RefuseCalendarAccess
  else if (result.integrityFault) DropUntrustedCalendar
  else if (result.sourceFailed or result.feedFailed)
    (if (result.revalidating or result.savedStillVisible) RetainUnverifiedFeed else CalendarReadFailed)
  else PublishCalendarFeed
type NextCalendarEvidence = { currentBinding: bool, nextSettled: bool, nextPresent: bool, nextHasEvent: bool,
  sameAgent: bool, includedAuthorizedSource: bool, expired: bool, feedState: CalendarFeedState, nextState: CalendarFeedState }
pure def verifiesNextCalendar(nextEvidence: NextCalendarEvidence): bool =
  nextEvidence.currentBinding and nextEvidence.nextSettled and nextEvidence.nextPresent and
  (not(nextEvidence.nextHasEvent) or (nextEvidence.sameAgent and nextEvidence.includedAuthorizedSource and not(nextEvidence.expired))) and
  nextEvidence.feedState == CompleteCalendarFeed and nextEvidence.nextState == CompleteCalendarFeed
pure def savedCalendarCanRace(eligible: bool, currentBinding: bool, liveSettled: bool, alreadyPresenting: bool): bool =
  eligible and currentBinding and not(liveSettled or alreadyPresenting)
pure def lawLiveCalendarWinsSavedRace(eligible: bool, currentBinding: bool, alreadyPresenting: bool): bool =
  not(savedCalendarCanRace(eligible,currentBinding,true,alreadyPresenting))
pure def lawCalendarRefusalCannotKeepData(result: CalendarReadResult): bool =
  result.admissionRefused implies calendarPublication(result) != RetainUnverifiedFeed and calendarPublication(result) != PublishCalendarFeed
pure def lawCalendarIntegrityCannotKeepData(result: CalendarReadResult): bool =
  result.integrityFault implies calendarPublication(result) != RetainUnverifiedFeed and calendarPublication(result) != PublishCalendarFeed
pure def lawVerifiedCalendarRequiresFullCoverage(nextEvidence: NextCalendarEvidence): bool =
  verifiesNextCalendar(nextEvidence) implies nextEvidence.nextSettled and
    nextEvidence.feedState == CompleteCalendarFeed and nextEvidence.nextState == CompleteCalendarFeed
pure def lawVerifiedCalendarEventKeepsSource(nextEvidence: NextCalendarEvidence): bool =
  verifiesNextCalendar(nextEvidence) and nextEvidence.nextHasEvent implies
  nextEvidence.sameAgent and nextEvidence.includedAuthorizedSource and not(nextEvidence.expired)
pure val goodRead: CalendarReadResult = { currentBinding: true, legacyReadable: true, legacyPending: false,
  legacyPresent: false, retainedLegacy: false, admissionRefused: false, integrityFault: false,
  sourceFailed: false, feedFailed: false, revalidating: false, savedStillVisible: false }
pure val resultValues = Set(goodRead, { ...goodRead, currentBinding: false }, { ...goodRead, legacyPending: true },
  { ...goodRead, legacyPresent: true }, { ...goodRead, admissionRefused: true, savedStillVisible: true },
  { ...goodRead, integrityFault: true }, { ...goodRead, feedFailed: true, revalidating: true }, { ...goodRead, sourceFailed: true })
pure val currentNext: NextCalendarEvidence = { currentBinding: true, nextSettled: true, nextPresent: true, nextHasEvent: true,
  sameAgent: true, includedAuthorizedSource: true, expired: false, feedState: CompleteCalendarFeed, nextState: CompleteCalendarFeed }
pure val nextEvidenceValues = Set(currentNext, { ...currentNext, nextHasEvent: false }, { ...currentNext, nextPresent: false },
  { ...currentNext, nextSettled: false }, { ...currentNext, includedAuthorizedSource: false }, { ...currentNext, sameAgent: false },
  { ...currentNext, expired: true }, { ...currentNext, feedState: PartialCalendarFeed }, { ...currentNext, nextState: PartialCalendarFeed })
```

### A retained display, live verification and retired generation keep separate state

Retained display can become visible during an active read. It conveys no
freshness. A source or feed refusal clears the current display before the
remaining operation finishes, and that operation cannot publish after
the refusal. A completed live result can verify the next event only with
the checked next-result evidence. Invalidating next does not change the
displayed feed. Rebinding or retiring clears both, and continuations from
the retired generation cannot republish them. This lifecycle projects
current query ownership. Transport abort, clock callbacks and
queue coalescing provide observations to these transitions.

```quint
type CalendarProjection = NoCalendarProjection | RetainedCalendarProjection | LiveCalendarProjection
type CalendarReadAdmission = NoCalendarRead | InFlightCalendarRead | RefusedCalendarRead | FinishedCalendarRead
type CalendarRead = { generation: int, admission: CalendarReadAdmission, projection: CalendarProjection, nextVerified: bool }
pure val initial: CalendarRead = { generation: 0, admission: NoCalendarRead, projection: NoCalendarProjection, nextVerified: false }
pure def rebindCalendar(s: CalendarRead): CalendarRead = { ...initial, generation: s.generation + 1 }
pure def canStartCalendarRead(s: CalendarRead, sameWindow: bool, admittedOwner: bool): bool = admittedOwner
pure def startCalendarRead(s: CalendarRead, sameWindow: bool, admittedOwner: bool): CalendarRead =
  { generation: s.generation + 1, admission: InFlightCalendarRead,
    projection: if (sameWindow) s.projection else NoCalendarProjection, nextVerified: false }
pure def activeCalendarRead(s: CalendarRead, readGeneration: int): bool =
  s.admission == InFlightCalendarRead and s.generation == readGeneration
pure def canRestoreDuringRead(s: CalendarRead, readGeneration: int, savedEligible: bool): bool =
  activeCalendarRead(s,readGeneration) and s.projection == NoCalendarProjection and savedEligible
pure def restoreDuringRead(s: CalendarRead, readGeneration: int, savedEligible: bool): CalendarRead =
  { ...s, projection: RetainedCalendarProjection }
pure def canRefuseCalendarRead(s: CalendarRead, readGeneration: int): bool = activeCalendarRead(s,readGeneration)
pure def refuseCalendarRead(s: CalendarRead, readGeneration: int): CalendarRead =
  { ...s, admission: RefusedCalendarRead, projection: NoCalendarProjection, nextVerified: false }
pure def canCompleteCalendarRead(s: CalendarRead, readGeneration: int, decision: CalendarPublication, nextEvidence: NextCalendarEvidence): bool =
  activeCalendarRead(s,readGeneration) and decision != DiscardCalendarResult and decision != RefuseCalendarAccess
pure def completeCalendarRead(s: CalendarRead, readGeneration: int, decision: CalendarPublication, nextEvidence: NextCalendarEvidence): CalendarRead =
  { ...s, admission: FinishedCalendarRead,
    projection: if (decision == PublishCalendarFeed) LiveCalendarProjection else
      if (decision == RetainUnverifiedFeed) s.projection else NoCalendarProjection,
    nextVerified: decision == PublishCalendarFeed and verifiesNextCalendar(nextEvidence) }
pure def invalidateCalendarVerification(s: CalendarRead): CalendarRead = { ...s, nextVerified: false }
pure def alwaysCalendarReadOwnsVerification(s: CalendarRead): bool =
  (s.nextVerified implies s.admission == FinishedCalendarRead and s.projection == LiveCalendarProjection) and
    ((s.admission == NoCalendarRead or s.admission == RefusedCalendarRead) implies s.projection == NoCalendarProjection)
pure def stepSavedCalendarNeverVerifies(before: CalendarRead, via: str, after: CalendarRead): bool =
  via == "restoreDuringRead" implies after.projection == RetainedCalendarProjection and not(after.nextVerified)
pure def stepRetiredReadCannotRestore(before: CalendarRead, via: str, after: CalendarRead): bool =
  via == "rebindCalendar" implies after.generation > before.generation and after.projection == NoCalendarProjection and not(after.nextVerified)
pure def sometimesReadShowsSavedCalendar(s: CalendarRead): bool =
  s.admission == InFlightCalendarRead and s.projection == RetainedCalendarProjection
pure def sometimesReadVerifiesNextCalendar(s: CalendarRead): bool = s.nextVerified
pure def sometimesReadRefusesCalendar(s: CalendarRead): bool = s.admission == RefusedCalendarRead
pure val readGenerationValues = Set(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12)
pure val weight_startCalendarRead = 8
pure val weight_completeCalendarRead = 8
pure val weight_restoreDuringRead = 8
```
