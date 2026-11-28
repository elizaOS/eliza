# Contacts

The owner's address book on an Android phone: bounded reads of the current
profile's Contacts while the app's Contacts view is open, the owner's own
saves and removals from that view (a removal waits in the
[deletion journal](./deferredDeletion.md) so that it can be undone),
display-only names for the numbers the owner is looking at in Phone and
Messages, and the caller's name on the call screen.
It models the native `AddressBookPlugin`, `ContactsCatalog` and
`ContactsEditor` of `plugins/plugin-native-contacts`, the renderer adapter
around them, and the caller lookup of the phone plugin's `TelecomCallService`.
This machine is the registered plugin: [bridge admission](./bridge.md) gives
the device facts, the write outcome and the write gate, and
[keyset paging](./paging.md), imported as `Pg`, gives the page order and the
cursor. The capability name `contacts.write.v1` belongs to the agent's
`deviceActions/capabilities.md`; this spec keeps only the Android check
behind it. The system Contacts editor handoff is a bridge handoff
(`Opened`), never a write.

## Story: Read my contacts only while I am looking at them

> As the owner, I want my contacts read from my own profile only while the
> Contacts view is open on my unlocked phone, so that they never linger where
> I did not look.

### A read starts only in the open view, with the read grant, on an unlocked phone, and with a bounded request

A read needs the phone unlocked for the foreground user with the app resumed
(`WhileUnlocked`) and `READ_CONTACTS` held. A request has a query of at most
128 characters without NUL and a limit from 1 to 200 (the shell's default
is 50). The renderer's request ticket and the native generation are one
counter here: every new read, view change, host pause, resume or screen-off,
and grant change moves it.

```quint
import bridge.* from "./bridge"
import paging as Pg from "./paging"
type ContactGrants = { readGranted: bool, writeGranted: bool }
type PageAsk = { queryLength: int, hasNul: bool, limit: int }
type ContactRead = NoRead | Reading({ ticket: int, kind: ReadKind, afterSettle: bool })
type CallerSlot = NoCall | InCall({ callId: int, nameCached: bool, nameShown: bool })
type LastWrite = NoWriteYet | Wrote({ result: WriteOutcome })
type ContactsState = { viewOpen: bool, generation: int, grants: ContactGrants, read: ContactRead, rowsShown: bool,
  gate: WriteGate, lastWrite: LastWrite, callServiceLive: bool, call: CallerSlot }
pure val initial: ContactsState = { viewOpen: false, generation: 0, grants: { readGranted: false, writeGranted: false }, read: NoRead,
  rowsShown: false, gate: WriteIdle, lastWrite: NoWriteYet, callServiceLive: false, call: NoCall }
pure val readCall: BridgeCall = { need: WhileUnlocked, needsGrant: true, needsFeature: false }
pure def readAdmission(grants: ContactGrants, facts: HostFacts): Admission = admitCall(PluginRegistered, readCall, { ...facts, granted: grants.readGranted })
pure def pageAskAdmitted(ask: PageAsk): bool = ask.queryLength >= 0 and ask.queryLength <= 128 and not(ask.hasNul) and ask.limit >= 1 and ask.limit <= 200
pure val askValues = Set({ queryLength: 4, hasNul: false, limit: 50 }, { queryLength: 129, hasNul: false, limit: 50 }, { queryLength: 4, hasNul: true, limit: 200 }, { queryLength: 0, hasNul: false, limit: 0 })
pure def canOpenView(s: ContactsState): bool = not(s.viewOpen)
pure def openView(s: ContactsState): ContactsState = { ...s, viewOpen: true, generation: s.generation + 1 }
pure def canCloseView(s: ContactsState): bool = s.viewOpen
pure def closeView(s: ContactsState): ContactsState = { ...s, viewOpen: false, generation: s.generation + 1, read: NoRead, rowsShown: false }
pure def retireReads(s: ContactsState): ContactsState = { ...s, generation: s.generation + 1, read: NoRead }
pure def canBeginRead(s: ContactsState, kind: ReadKind, facts: HostFacts, ask: PageAsk): bool =
  s.viewOpen and readAdmission(s.grants, facts) == CallAdmitted and pageAskAdmitted(ask)
pure def beginRead(s: ContactsState, kind: ReadKind, facts: HostFacts, ask: PageAsk): ContactsState =
  { ...s, generation: s.generation + 1, read: Reading({ ticket: s.generation + 1, kind: kind, afterSettle: s.gate != WriteInFlight }) }
```

### Only the current read publishes rows, and rows stay only in the open view with the read grant

Provider work checks the generation before I/O and the Activity checks it
again, with the device facts, before publishing; a reply with an older
ticket is dropped. A cursor that `Pg` refuses, or a failed provider query,
publishes nothing. A row too large to send whole is listed by the shell as
an incomplete placeholder with no contact data, in its place in the page.

```quint
pure def readTicketIs(read: ContactRead, ticket: int): bool = match read { | Reading(r) => r.ticket == ticket | NoRead => false }
pure def pagePublishes(start: Pg::PageStart, providerOk: bool): bool = match start { | Refused(_) => false | _ => providerOk }
pure val startValues = Set(Pg::FromFirst, Pg::AfterRow({ last: { major: 0, minor: 0, rowId: 1 } }), Pg::Refused({ reason: Pg::MovedBoundary }))
pure def canCompleteRead(s: ContactsState, ticket: int): bool = readTicketIs(s.read, ticket)
pure def completeRead(s: ContactsState, ticket: int, facts: HostFacts, start: Pg::PageStart, providerOk: bool): ContactsState = {
  val published = readAdmission(s.grants, facts) == CallAdmitted and pagePublishes(start, providerOk)
  val pending = s.read
  val evidence = match pending {
    | Reading(r) => { kind: r.kind, startedAfterSettle: r.afterSettle, succeeded: published }
    | NoRead => { kind: AutomaticRead, startedAfterSettle: false, succeeded: false }
  }
  { ...s, read: NoRead, rowsShown: published, gate: gateOnRead(s.gate, evidence) }
}
pure def alwaysAReadBelongsToTheCurrentGenerationOfTheOpenView(s: ContactsState): bool = {
  val pending = s.read
  match pending { | Reading(r) => s.viewOpen and r.ticket == s.generation | NoRead => true }
}
pure def alwaysRowsOnlyInTheOpenViewWithTheReadGrant(s: ContactsState): bool = s.rowsShown implies (s.viewOpen and s.grants.readGranted)
pure def stepRowsAppearOnlyFromTheCurrentRead(before: ContactsState, via: str, after: ContactsState): bool =
  (after.rowsShown and not(before.rowsShown)) implies via == "completeRead"
pure def sometimesRowsShown(s: ContactsState): bool = s.rowsShown
```

### A grant change retires every read and hides what the withdrawn grant allowed

Contacts rows and a caller's cached name both disappear when `READ_CONTACTS`
is withdrawn; the call screen's next refresh without the grant also forgets
the cached name and photo and cancels every caller read still running.

```quint
pure def grantsChanged(s: ContactsState, readGranted: bool, writeGranted: bool): ContactsState = {
  val slot = s.call
  { ...s, grants: { readGranted: readGranted, writeGranted: writeGranted }, generation: s.generation + 1, read: NoRead,
    rowsShown: s.rowsShown and readGranted,
    call: match slot { | InCall(c) => InCall({ callId: c.callId, nameCached: c.nameCached, nameShown: c.nameShown and readGranted }) | NoCall => NoCall } }
}
```

## Story: Change only the contact I reviewed

> As the owner, I want a save or removal to change only the contact I
> reviewed, at the version I saw, and a lost answer to be checked before I
> write again, so that I never overwrite a change I did not see.

### A contact write runs only on a writing install that can advertise contacts.write.v1, in front with focus

A writing install declares `WRITE_CONTACTS` and only a verified system
image admits it; a read-only install never writes and never names the
capability. A registered writing install names `contacts.write.v1` while
it holds both Contacts grants. Each write still needs the open view and
current foreground, unlock and focus evidence.

```quint
type ContactsInstall = ReadOnlyInstall | WritingInstall
pure val writeCall: BridgeCall = { need: WithFocus, needsGrant: true, needsFeature: false }
pure def advertisesContactWrite(install: ContactsInstall, presence: PluginPresence, grants: ContactGrants): bool =
  install == WritingInstall and presence == PluginRegistered and grants.readGranted and grants.writeGranted
pure def writeAdmission(install: ContactsInstall, grants: ContactGrants, facts: HostFacts): Admission =
  if (install != WritingInstall) BridgeUnavailable
  else if (readAdmission(grants, facts) != CallAdmitted) readAdmission(grants, facts)
  else admitCall(PluginRegistered, writeCall, { ...facts, granted: grants.writeGranted })
pure val grantsValues = Set({ readGranted: true, writeGranted: true }, { readGranted: true, writeGranted: false }, { readGranted: false, writeGranted: true }, { readGranted: false, writeGranted: false })
pure def lawAWriteRunsOnlyWhereTheCapabilityIsAdvertised(install: ContactsInstall, grants: ContactGrants, facts: HostFacts): bool =
  writeAdmission(install, grants, facts) == CallAdmitted implies (advertisesContactWrite(install, PluginRegistered, grants) and facts.focused)
```

### An edit or removal asserts the reviewed aggregate version inside the provider transaction

The version hashes every live raw contact ID and version of the contact.
Before the batch the editor reads the contact: gone is not-found, another
version (or a contact grown past what the editor reads) is stale. The batch
asserts every raw contact's version, so a change between that read and the
commit rolls it back, and a rollback is stale when the contact changed and
failed otherwise. A save supplying notes for a contact whose notes the read
omitted (several note rows, or text the editor would refuse) writes nothing,
so the stored notes are never flattened. A new contact goes into the
device-local account. A removal confirms itself with a positive delete count,
a save with a readback of the new ID and version. A linked contact's renamed
name row is marked super-primary so the rename shows.

```quint
type ContactWrite = CreateContact | UpdateContact | RemoveContact
type BatchAnswer = BatchCommitted | BatchRolledBack | BatchReplyLost
type ContactTransaction = { write: ContactWrite, found: bool, versionMatches: bool, notesOmitted: bool, batch: BatchAnswer, changedSince: bool, confirmed: bool }
pure def batchReply(transaction: ContactTransaction): ProviderReply =
  if (transaction.batch == BatchReplyLost) NoReply
  else if (transaction.batch == BatchRolledBack) { if (transaction.write != CreateContact and transaction.changedSince) RevisionMismatch else NothingWritten }
  else if (transaction.confirmed) CommittedAndReadBack
  else if (transaction.write == RemoveContact) NothingWritten
  else CommittedNotReadBack
pure def transactionReply(transaction: ContactTransaction): ProviderReply =
  if (transaction.write == CreateContact) batchReply(transaction)
  else if (not(transaction.found)) NothingWritten
  else if (not(transaction.versionMatches)) RevisionMismatch
  else if (transaction.write == UpdateContact and transaction.notesOmitted) NothingWritten
  else batchReply(transaction)
pure val transactionValues = Set(
  { write: UpdateContact, found: true, versionMatches: true, notesOmitted: false, batch: BatchCommitted, changedSince: false, confirmed: true },
  { write: UpdateContact, found: true, versionMatches: false, notesOmitted: false, batch: BatchCommitted, changedSince: true, confirmed: true },
  { write: UpdateContact, found: true, versionMatches: true, notesOmitted: true, batch: BatchCommitted, changedSince: false, confirmed: true },
  { write: UpdateContact, found: true, versionMatches: true, notesOmitted: false, batch: BatchRolledBack, changedSince: true, confirmed: false },
  { write: RemoveContact, found: true, versionMatches: true, notesOmitted: false, batch: BatchCommitted, changedSince: false, confirmed: false },
  { write: RemoveContact, found: false, versionMatches: false, notesOmitted: false, batch: BatchReplyLost, changedSince: false, confirmed: false },
  { write: CreateContact, found: false, versionMatches: false, notesOmitted: false, batch: BatchReplyLost, changedSince: false, confirmed: false },
  { write: CreateContact, found: false, versionMatches: false, notesOmitted: true, batch: BatchCommitted, changedSince: false, confirmed: false })
pure def lawAChangedContactIsNeverWritten(transaction: ContactTransaction): bool =
  (transaction.write != CreateContact and not(transaction.versionMatches)) implies
    (writeOutcome(transactionReply(transaction)) == Conflict or writeOutcome(transactionReply(transaction)) == NotWritten)
pure def lawOmittedNotesAreNeverOverwritten(transaction: ContactTransaction): bool =
  (transaction.write == UpdateContact and transaction.notesOmitted) implies
    (writeOutcome(transactionReply(transaction)) == Conflict or writeOutcome(transactionReply(transaction)) == NotWritten)
pure def lawOnlyAConfirmedCommitOfTheReviewedVersionIsApplied(transaction: ContactTransaction): bool =
  writeOutcome(transactionReply(transaction)) == Applied implies
    (transaction.batch == BatchCommitted and transaction.confirmed and (transaction.write == CreateContact or (transaction.found and transaction.versionMatches)))
```

### A lost or malformed reply blocks another write until an explicit read that began after it settled

The shell parses the native answer; a missing, malformed or `unknown` answer
is `NoReply`. The gate outlives the view and is never cleared by an
automatic refresh, a read already running when the write was dispatched, or
a failed read; nothing retries the write on its own.

```quint
pure def canDispatchWrite(s: ContactsState, install: ContactsInstall, facts: HostFacts): bool =
  s.viewOpen and gateAllowsWrite(s.gate) and writeAdmission(install, s.grants, facts) == CallAdmitted
pure def dispatchWrite(s: ContactsState, install: ContactsInstall, facts: HostFacts): ContactsState = {
  val pending = s.read
  { ...s, gate: gateOnDispatch(s.gate),
    read: match pending { | Reading(r) => Reading({ ticket: r.ticket, kind: r.kind, afterSettle: false }) | NoRead => NoRead } }
}
pure def canSettleWrite(s: ContactsState): bool = s.gate == WriteInFlight
pure def settleWrite(s: ContactsState, reply: ProviderReply): ContactsState =
  { ...s, gate: gateOnOutcome(s.gate, writeOutcome(reply)), lastWrite: Wrote({ result: writeOutcome(reply) }) }
pure def alwaysAnUnsettledGateFollowsAnUncertainWrite(s: ContactsState): bool =
  s.gate == WriteUnsettled implies s.lastWrite == Wrote({ result: Uncertain })
pure def stepOnlyACompletedReadSettlesAnUncertainWrite(before: ContactsState, via: str, after: ContactsState): bool =
  (before.gate == WriteUnsettled and after.gate != WriteUnsettled) implies (via == "completeRead" and after.gate == WriteIdle)
pure def sometimesAppliedWrite(s: ContactsState): bool = s.lastWrite == Wrote({ result: Applied })
pure def sometimesUncertainWriteOutlivesTheView(s: ContactsState): bool = s.gate == WriteUnsettled and not(s.viewOpen)
pure def sometimesUncertainWriteSettledByAnExplicitRead(s: ContactsState): bool = s.lastWrite == Wrote({ result: Uncertain }) and s.gate == WriteIdle
```

### A removal the owner confirmed waits in the deletion window, and only its expiry runs the editor's removal

A removal is staged as a contact record exactly where a write could be
dispatched now: the view open, the gate idle and a writing install admitted
in front with focus. Before staging, the editor reads the contact without
changing it; a contact that is gone, or at another version than the one
reviewed, is not staged and answers not-found or stale. Staging writes
nothing to Contacts and leaves the gate as it is; the list leaves the
contact out while its window is queued. When the window expires, the
journal's provider call runs the removal above, which asserts the reviewed
version again inside its transaction, and its answer settles the journal row
rather than the gate. Undo before then leaves the contact untouched.

```quint
pure def canStageRemoval(s: ContactsState, install: ContactsInstall, facts: HostFacts): bool = canDispatchWrite(s, install, facts)
pure def stageRemoval(s: ContactsState, install: ContactsInstall, facts: HostFacts): ContactsState = s
pure def stepStagingARemovalWritesNothing(before: ContactsState, via: str, after: ContactsState): bool = via == "stageRemoval" implies after == before
```

## Story: See who is calling from my contacts

> As the owner, I want an incoming or outgoing call to show the caller's
> name from my contacts, and never a name for a call that has ended or that
> my contacts grant no longer allows.

### A caller's name is shown only while the call service, the call and the read grant are all current

The call service looks the number up in Contacts off the main thread, once
per call and number, for the contact's name and its Contacts thumbnail; a
name Telecom gives is shown over the contact's (a name equal to the number
names nobody), and a caller with neither a name nor a photo shows a person
icon. The answer is cached and shown only if the service is still live, the
call screen is still started, the call is still the same registered call
with the same number and `READ_CONTACTS` is still held; a later refresh from
the cache checks the grant again, and one without it forgets the cache.
Stopping the call screen cancels its running reads. Removing the call or
destroying the service drops the cached name and photo. A host may leave Hold
out of its call controls without changing what Telecom allows.

```quint
pure def canStartCallService(s: ContactsState): bool = not(s.callServiceLive)
pure def startCallService(s: ContactsState): ContactsState = { ...s, callServiceLive: true }
pure def stopCallService(s: ContactsState): ContactsState = { ...s, callServiceLive: false, call: NoCall }
pure def canCallAdded(s: ContactsState, callId: int): bool = s.callServiceLive and s.call == NoCall
pure def callAdded(s: ContactsState, callId: int): ContactsState = { ...s, call: InCall({ callId: callId, nameCached: false, nameShown: false }) }
pure def isCurrentCall(slot: CallerSlot, callId: int): bool = match slot { | InCall(c) => c.callId == callId | NoCall => false }
pure def canCallRemoved(s: ContactsState, callId: int): bool = isCurrentCall(s.call, callId)
pure def callRemoved(s: ContactsState, callId: int): ContactsState = { ...s, call: NoCall }
pure def canCallerNameFound(s: ContactsState, callId: int): bool = s.callServiceLive and isCurrentCall(s.call, callId) and s.grants.readGranted
pure def callerNameFound(s: ContactsState, callId: int): ContactsState = { ...s, call: InCall({ callId: callId, nameCached: true, nameShown: true }) }
pure def refreshCaller(s: ContactsState): ContactsState = {
  val slot = s.call
  { ...s, call: match slot { | InCall(c) => InCall({ callId: c.callId, nameCached: c.nameCached and s.grants.readGranted, nameShown: c.nameCached and s.grants.readGranted }) | NoCall => NoCall } }
}
pure def stepARefreshWithoutTheGrantForgetsTheCaller(before: ContactsState, via: str, after: ContactsState): bool =
  (via == "refreshCaller" and not(before.grants.readGranted)) implies not(nameCachedIn(after.call))
pure val callIdValues = Set(1, 2)
pure def nameCachedIn(slot: CallerSlot): bool = match slot { | InCall(c) => c.nameCached | NoCall => false }
pure def nameShownIn(slot: CallerSlot): bool = match slot { | InCall(c) => c.nameShown | NoCall => false }
pure def alwaysACallBelongsToTheLiveCallService(s: ContactsState): bool = s.call != NoCall implies s.callServiceLive
pure def alwaysAShownCallerNameIsCachedAndGranted(s: ContactsState): bool =
  nameShownIn(s.call) implies (nameCachedIn(s.call) and s.grants.readGranted)
pure def sometimesCallerNamed(s: ContactsState): bool = nameShownIn(s.call)
pure def sometimesCachedNameHiddenWithoutGrant(s: ContactsState): bool = nameCachedIn(s.call) and not(nameShownIn(s.call))
```

## Story: Name the numbers I am already looking at

> As the owner, I want my recent calls, my conversations and my call screen
> to show the names and photos my contacts give the numbers on them, without
> the phone reading my address book for anything else or handing those
> names to the assistant.

### A name lookup runs only for the numbers on an open Phone, Messages or call screen, on an unlocked phone with the read grant

A screen asks for the numbers it shows: the calls of its Phone recents page,
the addresses of its Messages thread page, or the number of the call it
shows, and only while that screen is open. An ask holds 1 to 50 distinct
dial-shaped numbers (an optional `+` and 2 to 20 digits once separators are
removed); a screen showing more asks for its first 50 in screen order, and a
sender that is not dial-shaped stays as Android shows it. The lookup needs what a Contacts read needs (`WhileUnlocked` and
`READ_CONTACTS`) but not the Contacts view, runs off the main thread, and is
cancelled, its answer dropped, on pause, resume, screen-off and grant change
like every Contacts read (`fenceHolds`). A refused or dropped lookup leaves
the numbers shown as they are. The native call screen keeps its own caller
lookup ([above](#a-callers-name-is-shown-only-while-the-call-service-the-call-and-the-read-grant-are-all-current)).

```quint
type NameAsk = { screenOpen: bool, numbers: int, distinct: bool, dialShaped: bool }
type NamesAnswer = NamesRead | NamesNotAdmitted({ refusal: Admission }) | NamesOutOfBounds | NamesStale
pure val maxNamedNumbers = 50
pure def nameAskAdmitted(nameAsk: NameAsk): bool =
  nameAsk.screenOpen and nameAsk.distinct and nameAsk.dialShaped and nameAsk.numbers >= 1 and nameAsk.numbers <= maxNamedNumbers
pure def namesAnswer(grants: ContactGrants, facts: HostFacts, nameAsk: NameAsk, fenceHolds: bool): NamesAnswer =
  if (readAdmission(grants, facts) != CallAdmitted) NamesNotAdmitted({ refusal: readAdmission(grants, facts) })
  else if (not(nameAskAdmitted(nameAsk))) NamesOutOfBounds
  else if (not(fenceHolds)) NamesStale
  else NamesRead
pure val nameAskValues = Set(
  { screenOpen: true, numbers: 3, distinct: true, dialShaped: true }, { screenOpen: false, numbers: 3, distinct: true, dialShaped: true },
  { screenOpen: true, numbers: 51, distinct: true, dialShaped: true }, { screenOpen: true, numbers: 2, distinct: false, dialShaped: true },
  { screenOpen: true, numbers: 1, distinct: true, dialShaped: false }, { screenOpen: true, numbers: 0, distinct: true, dialShaped: true })
pure def lawNamesAreReadOnlyForAnOpenScreenWithTheReadGrant(grants: ContactGrants, facts: HostFacts, nameAsk: NameAsk, fenceHolds: bool): bool =
  namesAnswer(grants, facts, nameAsk, fenceHolds) == NamesRead implies
    (grants.readGranted and facts.foreground and facts.unlocked and nameAsk.screenOpen and nameAsk.numbers >= 1 and nameAsk.numbers <= maxNamedNumbers and fenceHolds)
```

### An answer gives only a name and a photo, for exactly the numbers asked, and never lists contacts

Android's phone lookup matches each number whole, never as a prefix or a
search. The answer holds, for each asked number in its order, the contact's
display name or none, and its Contacts thumbnail as a small JPEG or none;
nothing else of the contact (no ID, lookup key, other numbers, emails or
notes), and no number that was not asked. An answer with another count,
order or number is malformed and shows nothing.

```quint
type NamedNumber = { asked: int, named: bool, photo: bool }
pure def answerMatchesAsk(asked: List[int], answer: List[NamedNumber]): bool =
  answer.length() == asked.length() and answer.listMap(n => n.asked) == asked
pure val askedValues = Set(List(), List(1), List(1, 2))
pure val answerValues = Set(List(), List({ asked: 1, named: true, photo: false }),
  List({ asked: 2, named: false, photo: false }, { asked: 1, named: true, photo: true }),
  List({ asked: 1, named: true, photo: true }, { asked: 2, named: false, photo: false }))
pure def lawAnAnswerNamesOnlyTheNumbersAsked(asked: List[int], answer: List[NamedNumber]): bool =
  answerMatchesAsk(asked, answer) implies (answer.every(n => asked.includes(n.asked)) and answer.length() == asked.length())
```

### Names stay beside the rows of the screen that asked, and never reach the assistant

The renderer keeps one generation per screen; a new ask or closing the
screen moves it, and an answer for an older generation is dropped. Names are
held in memory beside the rows they label, never stored, logged, put in a
device action's result or a turn's context, or sent to the agent; the
assistant sees numbers only as the device actions that read them say.

```quint
type NamesUse = BesideTheRows | InAgentContext | StoredNames
pure def namesShown(names: NamesAnswer, askedGeneration: int, screenGeneration: int, use: NamesUse): bool =
  names == NamesRead and askedGeneration == screenGeneration and use == BesideTheRows
pure val namesValues = Set(NamesRead, NamesStale, NamesOutOfBounds, NamesNotAdmitted({ refusal: PermissionRequired }))
pure def lawNamesNeverLeaveTheScreenThatAsked(names: NamesAnswer, askedGeneration: int, screenGeneration: int, use: NamesUse): bool =
  namesShown(names, askedGeneration, screenGeneration, use) implies (names == NamesRead and use == BesideTheRows and askedGeneration == screenGeneration)
```
