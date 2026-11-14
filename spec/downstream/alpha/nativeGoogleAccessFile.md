# Native Google access file custody

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43`
publishes its two Google agent permissions with
`AlphaLocalAgentPlugin.java:374–381` and `GoogleAgentAccessFile.java:19–35`.
The same bridge passes the installed path to the agent at line 636.
`scripts/native-google-product-host.ts:12–23` delegates to Eliza
`c518127a025ab173874af9c7d304f26b25213b0d`'s
`packages/app/src/runtime/managed-google-agent/native-google-agent-host.ts:27–59`
and `managed-google-agent-host.ts:125–134,390–444,498–527`.
[Managed Google operations](./managedGoogle.md) owns scoped provider
verification and receipts. [Calendar link publication](./googleCalendarLinkPublication.md)
owns the Settings intent that leads to a preference save.

## Story: My Google change settings are recovered from their private file

### One complete publication owns the canonical path

The bridge takes both booleans and schedules a native write. Invalid
arguments, worker rejection and storage failure have distinct bridge
refusals. `.eliza/alpha-google-agent-access.json` is under Alpha's
private files directory and is removed by product data reset. The
writer creates the private directory with mode 0700 if missing. A
linked immediate directory or linked target is refused. A canonical
directory target cannot be replaced. A FIFO leaf may be replaced by the
atomic writer even though a reader refuses to use it.

The synchronized Java writer stages version-one UTF-8 JSON with both
booleans in a unique 0600 temporary file in the same directory. It
forces the staging file, atomically replaces the canonical path and
attempts to delete the temporary path in cleanup. The model records a
committed rename independently of bridge acknowledgment. A refusal
before the rename keeps the canonical file. The reader uses only that
canonical path. Temporary and backup siblings provide no authority.

```quint
type AccessBits = { gmailChanges: bool, calendarEdits: bool }
type FileKind = AccessMissing | AccessInvalid | AccessLink | AccessLinkedParent | AccessDirectory | AccessSpecial | AccessValid
type AccessOperation = GmailChange | CalendarChange | ReadOrReceipt
type Admission = NeverRequested | ChangesOff | VerifyingRequest | VerificationFinished
type AccessFile = { fileKind: FileKind, bits: AccessBits, sidecars: bool, readerOpen: bool, snapshot: AccessBits,
  lastRead: AccessBits, hostGeneration: int, admission: Admission, admittedOperation: AccessOperation }
pure val switchesOff: AccessBits = { gmailChanges: false, calendarEdits: false }
pure val initial: AccessFile = { fileKind: AccessMissing, bits: switchesOff, sidecars: false, readerOpen: false,
  snapshot: switchesOff, lastRead: switchesOff, hostGeneration: 1, admission: NeverRequested, admittedOperation: ReadOrReceipt }
pure def canonicalAccess(s: AccessFile): AccessBits =
  if (s.fileKind == AccessValid) s.bits else switchesOff
pure def writerTargetAdmissible(fileKind: FileKind): bool =
  fileKind == AccessMissing or fileKind == AccessInvalid or fileKind == AccessSpecial or fileKind == AccessValid
pure def canObserveAccessPath(s: AccessFile, fileKind: FileKind): bool = fileKind != AccessValid and s.fileKind != fileKind
pure def observeAccessPath(s: AccessFile, fileKind: FileKind): AccessFile = { ...s, fileKind: fileKind, bits: switchesOff }
pure def canObserveSidecars(s: AccessFile): bool = not(s.sidecars)
pure def observeSidecars(s: AccessFile): AccessFile = { ...s, sidecars: true }
type WriteReceipt = RenameRefused | RenameUnacknowledged | RenameAcknowledged
pure def canPublishAccess(s: AccessFile): bool = writerTargetAdmissible(s.fileKind)
pure def publishAccess(s: AccessFile, gmailNext: bool, calendarNext: bool, writeReceipt: WriteReceipt): AccessFile =
  if (writeReceipt == RenameRefused) s
  else { ...s, fileKind: AccessValid, bits: { gmailChanges: gmailNext, calendarEdits: calendarNext } }
pure def alwaysUnavailableAccessIsOff(s: AccessFile): bool =
  s.fileKind != AccessValid implies s.bits == switchesOff
pure def stepSidecarsCannotChangeAccess(before: AccessFile, via: str, after: AccessFile): bool =
  via == "observeSidecars" implies canonicalAccess(after) == canonicalAccess(before)
pure def lawLinksRefuseWrite(fileKind: FileKind): bool =
  (fileKind == AccessLink or fileKind == AccessLinkedParent) implies not(writerTargetAdmissible(fileKind))
pure val weight_publishAccess = 4
```

### A reader owns the descriptor it already opened

The Node reader checks the immediate parent with `lstat`, then opens the
final file with read-only, no-follow and nonblocking flags. It checks
that the resulting descriptor is a regular file, then reads through the
same descriptor and closes it. A missing or unreadable path, link, FIFO,
directory, malformed JSON, wrong version or nonboolean field turns both
switches off. The reader accepts version one and both exact boolean
fields. Additional keys do not change that result. The file names and
booleans are all it needs. An atomic replacement during a read leaves
the opened reader on the complete old record. A new read can see the
new canonical record immediately.

The model takes current path status from the port and retains an
already-open descriptor result separately. Earlier or later filesystem
failures are distinct from a successful modeled snapshot. Product
custody keeps the ancestors private. The pinned code checks the
immediate parent rather than establishing confinement during a
concurrent swap of its ancestors.

```quint
pure def canOpenAccessReader(s: AccessFile): bool = not(s.readerOpen)
pure def openAccessReader(s: AccessFile): AccessFile =
  { ...s, readerOpen: true, snapshot: canonicalAccess(s) }
pure def canFinishAccessReader(s: AccessFile): bool = s.readerOpen
pure def finishAccessReader(s: AccessFile): AccessFile =
  { ...s, readerOpen: false, lastRead: s.snapshot, snapshot: switchesOff }
pure def alwaysClosedReaderHasNoSnapshot(s: AccessFile): bool = not(s.readerOpen) implies s.snapshot == switchesOff
pure def stepPublicationKeepsOpenedSnapshot(before: AccessFile, via: str, after: AccessFile): bool =
  via == "publishAccess" implies after.readerOpen == before.readerOpen and after.snapshot == before.snapshot
pure def sometimesReadSpansReplacement(s: AccessFile): bool =
  s.readerOpen and s.fileKind == AccessValid and canonicalAccess(s) != s.snapshot
pure val weight_openAccessReader = 3
```

## Story: Turning writes off affects the next agent request

### Verification starts only after sampling the appropriate current switch

The managed host reads the corresponding switch before each Gmail
mailbox change, send preparation or dispatch, and before Calendar
write-family calls including capability and target reads. A refused
write-family call reports `changes-off` with HTTP 409 before reaching
Cloud verification. Gmail list, detail and send receipt reads and Calendar
sources and feed do not require the write switch. They still use the
normal credential and provider grant checks. Both switches are independent
and turning either off leaves the connection and existing workflow
receipts intact.

The request samples once at admission. A later replacement cannot undo
an earlier admission to verification. The next request samples current
canonical bits again. A new host starts from the same private path with
fresh request state. The machine follows one held admission and computes
a different request's admission independently. Verification completion
does not claim that a provider effect happened.

```quint
pure def admitsOperation(bits: AccessBits, accessOperation: AccessOperation): bool =
  if (accessOperation == GmailChange) bits.gmailChanges
  else if (accessOperation == CalendarChange) bits.calendarEdits else true
pure def nextAdmission(s: AccessFile, accessOperation: AccessOperation): Admission =
  if (admitsOperation(canonicalAccess(s), accessOperation)) VerifyingRequest else ChangesOff
pure def canStartAccessRequest(s: AccessFile): bool = s.admission != VerifyingRequest
pure def startAccessRequest(s: AccessFile, accessOperation: AccessOperation): AccessFile =
  { ...s, admission: nextAdmission(s, accessOperation), admittedOperation: accessOperation }
pure def canFinishAccessRequest(s: AccessFile): bool = s.admission == VerifyingRequest
pure def finishAccessRequest(s: AccessFile): AccessFile = { ...s, admission: VerificationFinished }
pure def restartAccessHost(s: AccessFile): AccessFile =
  { ...s, readerOpen: false, snapshot: switchesOff, lastRead: switchesOff,
    hostGeneration: s.hostGeneration + 1, admission: NeverRequested, admittedOperation: ReadOrReceipt }
pure def alwaysLookupAvoidsChangesOff(s: AccessFile): bool =
  s.admittedOperation == ReadOrReceipt implies s.admission != ChangesOff
pure def stepPublicationKeepsAdmission(before: AccessFile, via: str, after: AccessFile): bool =
  via == "publishAccess" implies before.admission == after.admission
pure def stepRestartKeepsCanonicalBits(before: AccessFile, via: str, after: AccessFile): bool =
  via == "restartAccessHost" implies before.fileKind == after.fileKind and before.bits == after.bits
pure def lawWriteSwitchNeverBlocksLookup(s: AccessFile): bool =
  nextAdmission(s, ReadOrReceipt) == VerifyingRequest
pure def sometimesHeldAdmissionOutlivesOff(s: AccessFile): bool =
  s.admission == VerifyingRequest and s.admittedOperation != ReadOrReceipt and
    nextAdmission(s, s.admittedOperation) == ChangesOff
pure val weight_startAccessRequest = 3
```

Pinned `test/quint-native-google-access-file.test.mjs` runs the real
Java writer and installed host source over disposable POSIX paths and a
loopback server with controlled verification. It covers link and FIFO
refusal, old descriptor and new canonical results, per-call admission
and host recreation. `test/native-google-agent-host-access.test.mjs`
covers separate product host permission behavior. Android power loss,
installed bridge acknowledgment and effects past provider verification
are outside those fixtures.
