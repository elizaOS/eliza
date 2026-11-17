# Contacts

The owner's address book on an Android phone: bounded reads of the current
profile's Contacts while the app's Contacts view is open, the owner's own
saves and removals from that view, and the caller's name on the call screen.
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
type LastWrite = NoWriteYet | Wrote({ outcome: WriteOutcome })
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
pure def pagePublishes(start: Pg::PageStart, providerOk: bool): bool = match start { | Pg::Refused(_) => false | _ => providerOk }
pure val startValues = Set(Pg::FromFirst, Pg::AfterRow({ last: { major: 0, minor: 0, rowId: 1 } }), Pg::Refused({ reason: Pg::MovedBoundary }))
pure def canCompleteRead(s: ContactsState, ticket: int): bool = readTicketIs(s.read, ticket)
pure def completeRead(s: ContactsState, ticket: int, facts: HostFacts, start: Pg::PageStart, providerOk: bool): ContactsState = {
  val published = readAdmission(s.grants, facts) == CallAdmitted and pagePublishes(start, providerOk)
  val evidence = match s.read {
    | Reading(r) => { kind: r.kind, startedAfterSettle: r.afterSettle, succeeded: published }
    | NoRead => { kind: AutomaticRead, startedAfterSettle: false, succeeded: false }
  }
  { ...s, read: NoRead, rowsShown: published, gate: gateOnRead(s.gate, evidence) }
}
pure def alwaysAReadBelongsToTheCurrentGenerationOfTheOpenView(s: ContactsState): bool =
  match s.read { | Reading(r) => s.viewOpen and r.ticket == s.generation | NoRead => true }
pure def alwaysRowsOnlyInTheOpenViewWithTheReadGrant(s: ContactsState): bool = s.rowsShown implies (s.viewOpen and s.grants.readGranted)
pure def stepRowsAppearOnlyFromTheCurrentRead(before: ContactsState, via: str, after: ContactsState): bool =
  (after.rowsShown and not(before.rowsShown)) implies via == "completeRead"
pure def sometimesRowsShown(s: ContactsState): bool = s.rowsShown
```

### A grant change retires every read and hides what the withdrawn grant allowed

Contacts rows and a caller's cached name both disappear when `READ_CONTACTS`
is withdrawn; the cached name stays cached for a later refresh.

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
capability. The device names `contacts.write.v1` only while it could admit a
write.

```quint
type ContactsInstall = ReadOnlyInstall | WritingInstall
pure val writeCall: BridgeCall = { need: WithFocus, needsGrant: true, needsFeature: false }
pure def advertisesContactWrite(install: ContactsInstall, presence: PluginPresence, grants: ContactGrants): bool =
  install == WritingInstall and presence == PluginRegistered and grants.readGranted and grants.writeGranted
pure def writeAdmission(install: ContactsInstall, grants: ContactGrants, facts: HostFacts): Admission =
  if (install != WritingInstall) BridgeUnavailable
  else if (readAdmission(grants, facts) != CallAdmitted) readAdmission(grants, facts)
  else admitCall(PluginRegistered, writeCall, { ...facts, granted: grants.writeGranted })
pure val grantsValues = Set({ readGranted: true, writeGranted: true }, { readGranted: true, writeGranted: false }, { readGranted: false, writeGranted: true })
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
  { ...s, gate: gateOnOutcome(s.gate, writeOutcome(reply)), lastWrite: Wrote({ outcome: writeOutcome(reply) }) }
pure def alwaysAnUnsettledGateFollowsAnUncertainWrite(s: ContactsState): bool =
  s.gate == WriteUnsettled implies s.lastWrite == Wrote({ outcome: Uncertain })
pure def stepOnlyACompletedReadSettlesAnUncertainWrite(before: ContactsState, via: str, after: ContactsState): bool =
  (before.gate == WriteUnsettled and after.gate != WriteUnsettled) implies (via == "completeRead" and after.gate == WriteIdle)
pure def sometimesAppliedWrite(s: ContactsState): bool = s.lastWrite == Wrote({ outcome: Applied })
pure def sometimesUncertainWriteOutlivesTheView(s: ContactsState): bool = s.gate == WriteUnsettled and not(s.viewOpen)
pure def sometimesUncertainWriteSettledByAnExplicitRead(s: ContactsState): bool = s.lastWrite == Wrote({ outcome: Uncertain }) and s.gate == WriteIdle
```

## Story: See who is calling from my contacts

> As the owner, I want an incoming or outgoing call to show the caller's
> name from my contacts, and never a name for a call that has ended or that
> my contacts grant no longer allows.

### A caller's name is shown only while the call service, the call and the read grant are all current

When Telecom names nobody (a name equal to the number names nobody), the
call service looks the number up in Contacts off the main thread, once per
call and number. The answer is cached and shown only if the service is still
live, the call is still registered and `READ_CONTACTS` is still held; a later
refresh from the cache checks the grant again. Removing the call or
destroying the service drops the cached name.

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
  { ...s, call: match slot { | InCall(c) => InCall({ callId: c.callId, nameCached: c.nameCached, nameShown: c.nameCached and s.grants.readGranted }) | NoCall => NoCall } }
}
pure val callIdValues = Set(1, 2)
pure def alwaysACallBelongsToTheLiveCallService(s: ContactsState): bool = match s.call { | InCall(_) => s.callServiceLive | NoCall => true }
pure def alwaysAShownCallerNameIsCachedAndGranted(s: ContactsState): bool =
  match s.call { | InCall(c) => c.nameShown implies (c.nameCached and s.grants.readGranted) | NoCall => true }
pure def sometimesCallerNamed(s: ContactsState): bool = match s.call { | InCall(c) => c.nameShown | NoCall => false }
pure def sometimesCachedNameHiddenWithoutGrant(s: ContactsState): bool = match s.call { | InCall(c) => c.nameCached and not(c.nameShown) | NoCall => false }
```
