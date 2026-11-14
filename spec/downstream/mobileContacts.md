# Native address book reads and reviewed contact writes

Grace `48b43b9c` uses `apps/app/native/java/technology/graceful/grace/DeviceContactsPlugin.java`
and `apps/app/src/device-services.ts` at Eliza `7743504b`. AlphaPhone
`8d44dfe5` uses `android/app/src/main/java/ai/alphacompute/alphaphone/AlphaContactsPlugin.java`
and `apps/app/src/prototype/contacts-adapter.ts` at Eliza `c518127a`.
Both consume `AddressBookPlugin.java` and `ContactsCatalog.java` from
`plugins/plugin-native-contacts/android/src/main/java/ai/eliza/plugins/contacts/`.
Alpha additionally consumes `ContactsEditor.java` and imports the staged
`packages/contracts/src/native-address-book.ts` draft and detail/write
decoders. The existing Alpha `ContactsBook.qnt` and `ContactsSession.qnt`
exercise the renderer contract. [Native bridge composition](./mobileBridge.md)
owns plugin registration. [Phone and Messages](./alpha/telephony.md) own
the consequences of an explicit handoff, including dialing or sending.

## Story: Read only the current Android profile's Contacts while the view is open

### Native and renderer generations fence private read results

The host declares the `contacts` permission alias. Every Grace install
can ask for `READ_CONTACTS` while its Contacts view is open. Grace stages
the producer classes without the library manifest's write grant. Alpha's
native gate requires its verified image and declares read and write
permissions. Native read admission checks resumed host, available lock
and user services, unlocked device and user, foreground Android user on
API 31+, and granted read permission. Permission requests and editor
launch also require a current focused Activity. `status` reports host
admission separately from current readability. Alpha additionally reports
writability only while readable and granted write permission.

Pause, resume, screen-off, permission result and destroy retire the native
generation and cancel in-flight reads. Provider work checks before I/O,
and the Activity checks again before publishing. The renderer also fences
the view, selected contact and request ticket. On hide or departure it
clears private contact rows and editor contents. Values stay local to the
active view, outside persistent prototype state and agent context. The
model represents one display owner and read at a time. A replacement
retains only its new read ticket.

```quint
type Host = GraceContacts | AlphaContacts
type AccessFacts = { host: Host, nativeAvailable: bool, imageVerified: bool, resumed: bool, unlocked: bool, userAllowed: bool, readGranted: bool, writeGranted: bool, focused: bool }
type ContactsState = { active: bool, visit: int, epoch: int, readTicket: int, rowsVisible: bool,
  writeEpoch: int, writeVisit: int, writePending: bool, uncertain: bool, lastWrite: WriteResult, writeShown: bool }
type WriteResult = NoWriteResult | SavedContact | SavedWithoutReadback | DeletedContact | StaleContact | MissingContact | RefusedContact | UnknownContactWrite
pure val initial: ContactsState = { active: false, visit: 0, epoch: 0, readTicket: 0, rowsVisible: false,
  writeEpoch: 0, writeVisit: 0, writePending: false, uncertain: false, lastWrite: NoWriteResult, writeShown: false }
pure def admitsHost(facts: AccessFacts): bool = facts.nativeAvailable and (facts.host == GraceContacts or facts.imageVerified)
pure def readable(facts: AccessFacts): bool = admitsHost(facts) and facts.resumed and facts.unlocked and facts.userAllowed and facts.readGranted
pure def mayRequestPermissions(facts: AccessFacts): bool = admitsHost(facts) and facts.resumed and facts.unlocked and facts.userAllowed and facts.focused
pure def writable(facts: AccessFacts): bool = facts.host == AlphaContacts and readable(facts) and facts.writeGranted
pure def canOpenContacts(s: ContactsState): bool = not(s.active)
pure def openContacts(s: ContactsState): ContactsState = { ...s, active: true, visit: s.visit + 1, epoch: s.epoch + 1 }
pure def canRetireContacts(s: ContactsState): bool = s.active
pure def retireContacts(s: ContactsState): ContactsState = { ...s, active: false, epoch: s.epoch + 1, rowsVisible: false, writeShown: false, readTicket: 0 }
pure def canBeginContactRead(s: ContactsState, facts: AccessFacts): bool = s.active and readable(facts)
pure def beginContactRead(s: ContactsState, facts: AccessFacts): ContactsState = { ...s, epoch: s.epoch + 1, readTicket: s.epoch + 1 }
pure def canCompleteContactRead(s: ContactsState, ticket: int): bool = s.active and ticket > 0 and s.readTicket == ticket
pure def completeContactRead(s: ContactsState, ticket: int, facts: AccessFacts, sameGeneration: bool, providerComplete: bool): ContactsState =
  { ...s, readTicket: 0, rowsVisible: readable(facts) and sameGeneration and providerComplete }
pure val ticketValues = Set(0, 1, 2, 3, 4, 5, 6, 7, 8)
pure val factsValues = Set(
  { host: GraceContacts, nativeAvailable: true, imageVerified: false, resumed: true, unlocked: true, userAllowed: true, readGranted: true, writeGranted: false, focused: true },
  { host: AlphaContacts, nativeAvailable: true, imageVerified: true, resumed: true, unlocked: true, userAllowed: true, readGranted: true, writeGranted: true, focused: true },
  { host: AlphaContacts, nativeAvailable: true, imageVerified: false, resumed: true, unlocked: true, userAllowed: true, readGranted: true, writeGranted: true, focused: true },
  { host: AlphaContacts, nativeAvailable: true, imageVerified: true, resumed: false, unlocked: true, userAllowed: true, readGranted: true, writeGranted: true, focused: false }
)
pure val weight_beginContactRead = 4
pure val weight_completeContactRead = 10
pure def alwaysReadVisibilityRequiresActiveView(s: ContactsState): bool = (s.rowsVisible or s.readTicket > 0) implies s.active
pure def lawGraceReadGrantCannotWrite(facts: AccessFacts): bool = (facts.host == GraceContacts) implies not(writable(facts))
pure def lawReadRequiresUnlockedProfile(facts: AccessFacts): bool = readable(facts) implies facts.unlocked and facts.userAllowed and facts.readGranted
pure def sometimesActiveReadPublishes(s: ContactsState): bool = s.rowsVisible
```

### A bounded page continues only from its exact query and observed last row

Both native catalogs query the current-profile Contacts provider off the
main thread, with a five-second cancellation signal. Query is at most
128 characters without NUL. The first page uses no cursor. The default
limit is 50 and admitted limits are 1–200. Native sorts by localized name
then ID. A continuation cursor encodes offset, exact last ID and the
original query, and is rejected if its query or the current row at the
saved boundary differs. This is a boundary check, with no snapshot
consistency guarantee for unrelated rows. A page larger than 1 MiB of
serialized UTF-8 records fails; accounting begins at 64 bytes. One
list field may contain at most 1,024 characters and each phone/email
array at most 32 entries. The Grace pin fails the page on an oversized
row. The Alpha pin emits exactly `{id,incomplete:true,reason}` for that
row without any partial contact data and continues the page. Grace's
renderer accumulates pages with the same query up to 500 rows and tells
the user to narrow a limited result. Alpha re-reads the first page with
limits 50, 100, 150 and 200, then leaves search as the way to find more.

The optional shared `parseAddressBookPage` validates cursor consistency,
unique contact IDs, bounds and the exact incomplete placeholder. These
pinned callers do not import that decoder for lists. Its decoder behaves
independently from the catalog port. Alpha imports strict validation for
detail, saves and deletions, described below.

```quint
type PageFacts = { queryLength: int, hasNul: bool, limit: int, bytes: int, hasCursor: bool, cursorShape: bool, queryMatches: bool, boundaryMatches: bool }
type PageDecision = PageAllowed | InvalidPage | StaleContactPage | OversizedContactPage
type RowAdmission = FullContactRow | IncompleteContactRow | RejectContactPage
pure def pageDecision(page: PageFacts): PageDecision =
  if (page.queryLength < 0 or page.queryLength > 128 or page.hasNul or page.limit < 1 or page.limit > 200 or
    (page.hasCursor and not(page.cursorShape and page.queryMatches))) InvalidPage
  else if (page.hasCursor and not(page.boundaryMatches)) StaleContactPage
  else if (page.bytes > 1048576) OversizedContactPage else PageAllowed
pure def rowAdmission(host: Host, fieldsWithinBounds: bool): RowAdmission =
  if (fieldsWithinBounds) FullContactRow else if (host == AlphaContacts) IncompleteContactRow else RejectContactPage
pure val pageValues = Set(
  { queryLength: 4, hasNul: false, limit: 50, bytes: 1024, hasCursor: false, cursorShape: false, queryMatches: false, boundaryMatches: false },
  { queryLength: 128, hasNul: false, limit: 200, bytes: 1048576, hasCursor: true, cursorShape: true, queryMatches: true, boundaryMatches: true },
  { queryLength: 4, hasNul: false, limit: 50, bytes: 1024, hasCursor: true, cursorShape: true, queryMatches: true, boundaryMatches: false },
  { queryLength: 4, hasNul: false, limit: 50, bytes: 1024, hasCursor: true, cursorShape: true, queryMatches: false, boundaryMatches: true },
  { queryLength: 4, hasNul: false, limit: 50, bytes: 1048577, hasCursor: false, cursorShape: false, queryMatches: false, boundaryMatches: false }
)
pure def lawPageCannotUseDifferentQueryOrBoundary(page: PageFacts): bool =
  (page.hasCursor and not(page.queryMatches and page.boundaryMatches)) implies pageDecision(page) != PageAllowed
pure def lawAlphaAndGraceNeverClipContact(host: Host): bool = rowAdmission(host, false) != FullContactRow
```

## Story: Save or remove only the reviewed contact and reconcile an uncertain result

### Device-local edits compare the reviewed aggregate version inside the provider transaction

Alpha's `get` validates the exact requested decimal ID, typed fields and
the opaque lowercase 64-hex `version`. A detail ID has 1–18 positive
decimal digits. The provider version hashes every live raw-contact ID and
version pair, sorted by raw ID, with `contact.v1` domain text. The read
takes that version first. A later change is caught by the write. The
catalog listing's `revision` is instead the native last-updated timestamp.
An edit in Android's system editor checks the exact ID, lookup key and
listing revision, selects an enabled exported system handler outside the
calling app, and returns `returned`. Provider success must come from a
separate read or write receipt. Grace does not call this editor path.

The in-app editor accepts up to 32 phone and email fields each, name up to
256 characters, phones up to 64, emails up to 320 and custom type labels
up to 64. It refuses blank or control-character fields, unknown field
types and empty contacts. The view trims blanks before sending a draft;
the shared native validator consumes the resulting fields as given. The
transaction creates in the device-local account or first checks the
reviewed version. Update and delete assert both live aggregate membership
and the raw row versions atomically in the same provider batch. An edit
keeps unchanged typed rows and their flags, changes the display name only
when needed, and puts additions on the lowest-ID live raw contact. A
reviewed delete has a separate owner confirmation. Foreground/read/write
admission happens before dispatch. The producer distinguishes a rolled
back refusal or stale version from an unknown response after dispatch.

```quint
type WriteKind = CreateContact | UpdateContact | RemoveContact
type TransactionFacts = { kind: WriteKind, contactExists: bool, versionMatches: bool, assertionsMatch: bool,
  committed: bool, providerReply: bool, readbackComplete: bool, deleteCountPositive: bool }
pure def acceptsSystemEditor(focused: bool, systemExported: bool, edit: bool, reviewedRow: bool): bool =
  focused and systemExported and (not(edit) or reviewedRow)
pure def transactionResult(transaction: TransactionFacts): WriteResult =
  if (transaction.kind != CreateContact and not(transaction.contactExists)) MissingContact
  else if (transaction.kind != CreateContact and not(transaction.versionMatches)) StaleContact
  else if (not(transaction.providerReply)) UnknownContactWrite
  else if (transaction.kind != CreateContact and not(transaction.assertionsMatch)) StaleContact
  else if (not(transaction.committed)) RefusedContact
  else if (transaction.kind == RemoveContact) { if (transaction.deleteCountPositive) DeletedContact else MissingContact }
  else if (transaction.readbackComplete) SavedContact else SavedWithoutReadback
pure val transactionValues = Set(
  { kind: UpdateContact, contactExists: true, versionMatches: true, assertionsMatch: true, committed: true, providerReply: true, readbackComplete: true, deleteCountPositive: false },
  { kind: UpdateContact, contactExists: true, versionMatches: true, assertionsMatch: false, committed: false, providerReply: true, readbackComplete: false, deleteCountPositive: false },
  { kind: RemoveContact, contactExists: true, versionMatches: true, assertionsMatch: true, committed: true, providerReply: true, readbackComplete: false, deleteCountPositive: true },
  { kind: CreateContact, contactExists: false, versionMatches: false, assertionsMatch: false, committed: true, providerReply: true, readbackComplete: false, deleteCountPositive: false },
  { kind: CreateContact, contactExists: false, versionMatches: false, assertionsMatch: false, committed: true, providerReply: false, readbackComplete: false, deleteCountPositive: false }
)
pure def lawStaleContactCannotCommitReceipt(transaction: TransactionFacts): bool =
  (transaction.kind != CreateContact and transaction.contactExists and not(transaction.versionMatches or (transaction.providerReply and transaction.assertionsMatch))) implies
  (transactionResult(transaction) == StaleContact or transactionResult(transaction) == UnknownContactWrite)
pure def lawSystemEditRequiresCurrentReview(focus: bool, systemExported: bool): bool = not(acceptsSystemEditor(focus, systemExported, true, false))
```

### A lost or malformed provider reply blocks another write until an explicit later read

The native write outcome outlives the view. `saved` means the batch
committed, even when the follow-up provider read cannot supply the ID and
version. Alpha's parser requires both fields or both null and refuses
extra fields or unrecognized statuses. For updates, the save decoder
allows a different valid read-back ID, as Android aggregation can change
it. A delete requires a positive returned count for `deleted`; an exact
`not-found` also removes the obsolete selected row from the view.
Replacement, close or lock retire presentation authority. If the reply
is lost, malformed, or reports `unknown`, the write may have committed.
The adapter keeps the pending and uncertain gates across visits and
owner replacement, and does not retry automatically. An explicit refresh
must start after the write has settled, succeed on the active view and
observe the same write epoch at completion. A read already in flight or
the automatic return-to-app refresh cannot clear uncertainty. The model
keeps renderer read tickets independently from the write's renderer visit;
a newer read in the same view does not retire a dispatched write.

```quint
pure def canDispatchContactWrite(s: ContactsState, facts: AccessFacts, reviewed: bool): bool =
  s.active and not(s.writePending or s.uncertain) and writable(facts) and facts.focused and reviewed
pure def dispatchContactWrite(s: ContactsState, facts: AccessFacts, reviewed: bool): ContactsState =
  { ...s, writePending: true, writeEpoch: s.writeEpoch + 1, writeVisit: s.visit, writeShown: false, lastWrite: NoWriteResult }
pure def canSettleContactWrite(s: ContactsState, writeResult: WriteResult): bool = s.writePending and writeResult != NoWriteResult
pure def settleContactWrite(s: ContactsState, writeResult: WriteResult, liveOriginalOwner: bool): ContactsState =
  { ...s, writePending: false, writeEpoch: s.writeEpoch + 1, uncertain: writeResult == UnknownContactWrite,
    lastWrite: writeResult, writeShown: s.active and liveOriginalOwner and s.writeVisit == s.visit }
type RefreshEvidence = { snapshot: int, beganWhilePending: bool, explicit: bool, pageSucceeded: bool }
pure def canReconcileContactWrite(s: ContactsState, refresh: RefreshEvidence): bool =
  s.active and s.uncertain and not(s.writePending or refresh.beganWhilePending) and refresh.explicit and refresh.pageSucceeded and s.writeEpoch == refresh.snapshot
pure def reconcileContactWrite(s: ContactsState, refresh: RefreshEvidence): ContactsState =
  { ...s, uncertain: false }
pure val refreshValues = Set(
  { snapshot: 2, beganWhilePending: false, explicit: true, pageSucceeded: true },
  { snapshot: 4, beganWhilePending: false, explicit: true, pageSucceeded: true },
  { snapshot: 2, beganWhilePending: true, explicit: true, pageSucceeded: true },
  { snapshot: 2, beganWhilePending: false, explicit: false, pageSucceeded: true },
  { snapshot: 2, beganWhilePending: false, explicit: true, pageSucceeded: false }
)
pure val writeResultValues = Set(SavedContact, SavedWithoutReadback, StaleContact, UnknownContactWrite)
pure val weight_dispatchContactWrite = 8
pure val weight_settleContactWrite = 10
pure val weight_reconcileContactWrite = 6
pure def alwaysNoDoubleWriteAuthority(s: ContactsState): bool = not(s.writePending and s.uncertain)
pure def alwaysVisibleWriteRequiresLiveView(s: ContactsState): bool = s.writeShown implies s.active and not(s.writePending)
pure def stepUncertaintySurvivesBackground(before: ContactsState, via: str, after: ContactsState): bool =
  (via == "retireContacts" and before.uncertain) implies after.uncertain
pure def sometimesWriteRemainsUncertainAfterDeparture(s: ContactsState): bool = s.uncertain and not(s.active)
pure def sometimesReconciledUnknownWrite(s: ContactsState): bool = s.lastWrite == UnknownContactWrite and not(s.uncertain)
```
