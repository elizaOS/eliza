# Pairing admission across senders

This model migrates the admission portion of `quint/PairingAdmission.qnt` and `services/pairing.ts`. One runtime serializes the read/check/write sequence across its requests. The pending limit applies independently to each channel. External writers remain an adapter concurrency boundary. Metadata is an optional detachment of a complete string-key/value object; JavaScript property ordering and Date/UUID codecs are conformance boundaries.

## Story: Admit pending pairing requests without evicting existing senders

As an owner, I want repeated requests to retain their original code and new senders to be rejected when my pending queue is full.

### One read-check-write admission owns the captured row and exact payload

Calls enter an unbounded FIFO as the promise tail is chained. The head enters the read sequence after every earlier call settles, including rejected calls. It samples the request timestamp when its serial body starts (before the list await), not when the caller joins the tail, and samples the expiry clock after the list returns. It ignores rows only when age is strictly greater than the TTL, at the captured expiry clock. Selection, the observed count and the normalized code comparison all use that one detached live list. When more than one live row matches, source stable ascending creation order picks the oldest, with the adapter’s read order breaking ties. Existing rows return the original code and ID. Their creation timestamp is immutable; last-seen is replaced by the original request timestamp and omitted metadata retains existing metadata. Admission failure preserves stored rows and returns no row. The source CSPRNG tries at most 500 full codes, rejects collisions case-insensitively, and may throw; this model checks the supplied result against the captured set. It does not generate random bytes. A ghost issued-ID set formalizes the fresh UUID boundary across deletion and delayed approval. The storage input uses valid detached request rows with exact and normalized code strings; uppercase normalization and requested alphabet/length are adapter conformance.

```quint
type PairingScope = { agent: str, channel: str, sender: str }
type MetadataEntry = { key: str, value: str }
type PairingMetadata = { present: bool, entries: List[MetadataEntry] }
type PendingRow = { scope: PairingScope, id: str, code: str, normalizedCode: str, createdAt: int, lastSeenAt: int, metadata: PairingMetadata }
type AdmissionInput = { scope: PairingScope, metadata: PairingMetadata }
type WaitingAdmission = { ticket: int, input: AdmissionInput }
type RequestInput = { scope: PairingScope, enteredAt: int, metadata: PairingMetadata }
type GeneratedCode = { id: str, code: str, normalizedCode: str }
type AdmissionPhase = AdmissionIdle | AdmissionReading | AdmissionCreating | AdmissionUpdating | AdmissionRejecting
type AdmissionResult = AdmissionNone | AdmissionAccepted | AdmissionFailed | AdmissionFull
type WriteKind = WriteFailure | RepeatedWrite | FreshWrite
type WriteOutcome = { kind: WriteKind, generated: GeneratedCode }
type TicketWalk = { valid: bool, expected: int }
type AdmissionReceipt = { ticket: int, resultKind: AdmissionResult, created: bool, returned: PendingRow }
type PairingAdmission = { configured: bool, rows: List[PendingRow], issuedIds: Set[str], phase: AdmissionPhase, activeTicket: int, nextTicket: int, waiting: List[WaitingAdmission], receipts: List[AdmissionReceipt], request: RequestInput, captured: List[PendingRow], prior: PendingRow, maximum: int, ttl: int, cleanupIds: List[str] }
pure val emptyScope: PairingScope = { agent: "", channel: "", sender: "" }
pure val absentMetadata: PairingMetadata = { present: false, entries: List() }
pure val emptyRow: PendingRow = { scope: emptyScope, id: "", code: "", normalizedCode: "", createdAt: 0, lastSeenAt: 0, metadata: absentMetadata }
pure val emptyRequest: RequestInput = { scope: emptyScope, enteredAt: 0, metadata: absentMetadata }
pure val emptyInput: AdmissionInput = { scope: emptyScope, metadata: absentMetadata }
pure val noAdmission: WaitingAdmission = { ticket: 0, input: emptyInput }
pure val noReceipt: AdmissionReceipt = { ticket: 0, resultKind: AdmissionNone, created: false, returned: emptyRow }
pure val initial: PairingAdmission = { configured: false, rows: List(), issuedIds: Set(), phase: AdmissionIdle, activeTicket: 0, nextTicket: 1, waiting: List(), receipts: List(), request: emptyRequest, captured: List(), prior: emptyRow, maximum: 3, ttl: 3600000, cleanupIds: List() }
pure def sameChannel(left: PairingScope, right: PairingScope): bool = left.agent == right.agent and left.channel == right.channel
pure def liveAt(now: int, ttl: int, row: PendingRow): bool = now - row.createdAt <= ttl
pure def validMetadata(metadata: PairingMetadata): bool = if (metadata.present) metadata.entries.every(entry => metadata.entries.select(other => other.key == entry.key).length() == 1) else metadata.entries.length() == 0
pure def validPendingRow(row: PendingRow): bool = row.id != "" and row.code != "" and row.normalizedCode != "" and validMetadata(row.metadata)
pure def earlierPending(chosen: PendingRow, row: PendingRow): PendingRow = if (chosen.id == "" or row.createdAt < chosen.createdAt) row else chosen
pure def oldestPending(rows: List[PendingRow]): PendingRow = rows.foldl(emptyRow, (chosen, row) => earlierPending(chosen, row))
pure def liveInChannel(rows: List[PendingRow], scope: PairingScope, readAt: int, ttl: int): List[PendingRow] = rows.select(row => sameChannel(row.scope, scope) and liveAt(readAt, ttl, row))
pure def dropPending(id: str, s: PairingAdmission): PairingAdmission = { ...s, rows: s.rows.select(row => row.id != id) }
pure def canRestorePending(s: PairingAdmission, row: PendingRow): bool = not(s.configured) and validPendingRow(row) and not(s.issuedIds.contains(row.id))
pure def restorePending(s: PairingAdmission, row: PendingRow): PairingAdmission = { ...s, rows: s.rows.append(row), issuedIds: s.issuedIds.union(Set(row.id)) }
pure def canConfigure(s: PairingAdmission): bool = not(s.configured)
pure def configure(s: PairingAdmission, maximum: int, ttl: int): PairingAdmission = { ...s, configured: true, maximum: maximum, ttl: ttl }
pure def queuedFirst(s: PairingAdmission): WaitingAdmission = s.waiting.nthOr(0, noAdmission)
pure def lastReceipt(s: PairingAdmission): AdmissionReceipt = s.receipts.nthOr(s.receipts.length() - 1, noReceipt)
pure def canEnqueueAdmission(s: PairingAdmission, input: AdmissionInput): bool = s.configured and validMetadata(input.metadata)
pure def enqueueAdmission(s: PairingAdmission, input: AdmissionInput): PairingAdmission = { ...s, waiting: s.waiting.append({ ticket: s.nextTicket, input: input }), nextTicket: s.nextTicket + 1 }
pure def canEnterAdmission(s: PairingAdmission): bool = s.phase == AdmissionIdle and s.waiting.length() > 0
pure def enterAdmission(s: PairingAdmission, enteredAt: int): PairingAdmission = {
  val selectedCall = queuedFirst(s)
  { ...s, phase: AdmissionReading, activeTicket: selectedCall.ticket, waiting: if (s.waiting.length() > 0) s.waiting.tail() else List(), request: { scope: selectedCall.input.scope, enteredAt: enteredAt, metadata: selectedCall.input.metadata }, captured: List(), prior: emptyRow }
}
pure def finishAdmission(receipt: AdmissionReceipt, s: PairingAdmission): PairingAdmission = { ...s, phase: AdmissionIdle, activeTicket: 0, receipts: s.receipts.append(receipt) }
pure def canReadPending(s: PairingAdmission): bool = s.phase == AdmissionReading
pure def rememberCleanup(ids: List[str], row: PendingRow): List[str] = if (ids.includes(row.id)) ids else ids.append(row.id)
pure def readPending(s: PairingAdmission, readAt: int): PairingAdmission = {
  val room = s.rows.select(row => sameChannel(row.scope, s.request.scope))
  val live = room.select(row => liveAt(readAt, s.ttl, row))
  val prior = oldestPending(live.select(row => row.scope == s.request.scope))
  val expired = room.select(row => not(liveAt(readAt, s.ttl, row)))
  { ...s, captured: live, prior: prior, cleanupIds: expired.foldl(s.cleanupIds, (ids, row) => rememberCleanup(ids, row)), phase: if (prior.id != "") AdmissionUpdating else if (live.length() >= s.maximum) AdmissionRejecting else AdmissionCreating }
}
pure def newRow(capturedInput: RequestInput, generated: GeneratedCode): PendingRow = { scope: capturedInput.scope, id: generated.id, code: generated.code, normalizedCode: generated.normalizedCode, createdAt: capturedInput.enteredAt, lastSeenAt: capturedInput.enteredAt, metadata: capturedInput.metadata }
pure def refreshedRow(prior: PendingRow, capturedInput: RequestInput): PendingRow = { ...prior, lastSeenAt: capturedInput.enteredAt, metadata: if (capturedInput.metadata.present) capturedInput.metadata else prior.metadata }
pure def freshIdentity(s: PairingAdmission, generated: GeneratedCode): bool = generated.id != "" and generated.code != "" and generated.normalizedCode != "" and not(s.issuedIds.contains(generated.id)) and not(s.captured.some(row => row.normalizedCode == generated.normalizedCode))
pure def canWritePending(s: PairingAdmission, writeResult: WriteOutcome): bool =
  if (writeResult.kind == WriteFailure) s.phase == AdmissionCreating or s.phase == AdmissionUpdating
  else if (writeResult.kind == RepeatedWrite) s.phase == AdmissionUpdating and s.rows.some(row => row.id == s.prior.id and row == s.prior)
  else s.phase == AdmissionCreating and freshIdentity(s, writeResult.generated)
pure def writePending(s: PairingAdmission, writeResult: WriteOutcome): PairingAdmission = {
  val prior = refreshedRow(s.prior, s.request)
  val createdRow = newRow(s.request, writeResult.generated)
  if (writeResult.kind == WriteFailure) finishAdmission({ ...noReceipt, ticket: s.activeTicket, resultKind: AdmissionFailed }, s)
  else if (writeResult.kind == RepeatedWrite) finishAdmission({ ticket: s.activeTicket, resultKind: AdmissionAccepted, created: false, returned: prior }, { ...s, rows: s.rows.listMap(existing => if (existing.id == prior.id) prior else existing) })
  else finishAdmission({ ticket: s.activeTicket, resultKind: AdmissionAccepted, created: true, returned: createdRow }, { ...s, rows: s.rows.append(createdRow), issuedIds: s.issuedIds.union(Set(createdRow.id)) })
}
pure def canRejectFull(s: PairingAdmission): bool = s.phase == AdmissionRejecting
pure def rejectFull(s: PairingAdmission): PairingAdmission = finishAdmission({ ...noReceipt, ticket: s.activeTicket, resultKind: AdmissionFull }, s)
pure def canReadFailed(s: PairingAdmission): bool = s.phase == AdmissionReading
pure def readFailed(s: PairingAdmission): PairingAdmission = finishAdmission({ ...noReceipt, ticket: s.activeTicket, resultKind: AdmissionFailed }, s)
pure def canSettleCleanup(s: PairingAdmission, id: str): bool = s.cleanupIds.includes(id)
pure def settleCleanup(s: PairingAdmission, id: str, success: bool): PairingAdmission = { ...s, cleanupIds: s.cleanupIds.select(other => other != id), rows: if (success) s.rows.select(row => row.id != id) else s.rows }
pure def rowsForId(rows: List[PendingRow], id: str): List[PendingRow] = rows.select(row => row.id == id)
pure def alwaysUniquePendingIds(s: PairingAdmission): bool = s.rows.every(row => row.id != "" and row.code != "" and s.issuedIds.contains(row.id) and rowsForId(s.rows, row.id).length() == 1)
pure def alwaysCreatingHasFreeCapacity(s: PairingAdmission): bool = s.phase == AdmissionCreating implies s.captured.length() < s.maximum
pure def alwaysUpdatingOwnsCapturedPrior(s: PairingAdmission): bool = s.phase == AdmissionUpdating implies s.prior.id != "" and s.captured.includes(s.prior) and s.prior.scope == s.request.scope
pure def alwaysReceiptHasIdentity(s: PairingAdmission): bool = s.receipts.every(receipt => receipt.resultKind == AdmissionAccepted implies receipt.returned.id != "" and receipt.returned.code != "")
pure def alwaysUnconfiguredHasNoCall(s: PairingAdmission): bool = not(s.configured) implies s.phase == AdmissionIdle and s.waiting.length() == 0
pure def alwaysActiveOwnerAgreesWithPhase(s: PairingAdmission): bool = (s.activeTicket == 0) == (s.phase == AdmissionIdle)
pure def completedTickets(s: PairingAdmission): int = s.receipts.length()
pure def occupiedTickets(s: PairingAdmission): int = completedTickets(s) + (if (s.activeTicket == 0) 0 else 1)
pure def alwaysTicketFrontier(s: PairingAdmission): bool =
  s.nextTicket == occupiedTickets(s) + s.waiting.length() + 1 and (s.activeTicket == 0 or s.activeTicket == completedTickets(s) + 1)
pure def walkTicket(walk: TicketWalk, ticket: int): TicketWalk = { valid: walk.valid and ticket == walk.expected, expected: walk.expected + 1 }
pure def consecutiveTickets(tickets: List[int], first: int): bool = tickets.foldl({ valid: true, expected: first }, (walk, ticket) => walkTicket(walk, ticket)).valid
pure def waitingIds(items: List[WaitingAdmission]): List[int] = items.listMap(queuedCall => queuedCall.ticket)
pure def receiptIds(items: List[AdmissionReceipt]): List[int] = items.listMap(receipt => receipt.ticket)
pure def alwaysTicketOrder(s: PairingAdmission): bool =
  consecutiveTickets(receiptIds(s.receipts), 1) and
  consecutiveTickets(waitingIds(s.waiting), occupiedTickets(s) + 1)
pure def stepOnlyHeadEnters(before: PairingAdmission, via: str, after: PairingAdmission): bool = via == "enterAdmission" implies after.activeTicket == queuedFirst(before).ticket and after.request.scope == queuedFirst(before).input.scope and after.request.metadata == queuedFirst(before).input.metadata
pure def stepReceiptsNameActiveCall(before: PairingAdmission, via: str, after: PairingAdmission): bool =
  (via == "writePending" or via == "rejectFull" or via == "readFailed") implies lastReceipt(after).ticket == before.activeTicket
pure def stepExistingRequestKeepsIdentity(before: PairingAdmission, via: str, after: PairingAdmission): bool = via == "writePending" and before.phase == AdmissionUpdating and lastReceipt(after).resultKind == AdmissionAccepted implies lastReceipt(after).returned.scope == before.prior.scope and lastReceipt(after).returned.id == before.prior.id and lastReceipt(after).returned.code == before.prior.code and lastReceipt(after).returned.createdAt == before.prior.createdAt and lastReceipt(after).returned.lastSeenAt == before.request.enteredAt
pure def stepNewRowHasFreeCapacity(before: PairingAdmission, via: str, after: PairingAdmission): bool = via == "writePending" and lastReceipt(after).created implies before.captured.length() < before.maximum
pure def sometimesQueueFull(s: PairingAdmission): bool = lastReceipt(s).resultKind == AdmissionFull
pure def sometimesFailedWrite(s: PairingAdmission): bool = lastReceipt(s).resultKind == AdmissionFailed
pure def sometimesExistingCodeReused(s: PairingAdmission): bool = lastReceipt(s).resultKind == AdmissionAccepted and not(lastReceipt(s).created) and lastReceipt(s).returned.id == s.prior.id
pure def sometimesExpiredRowCanBeDeleted(s: PairingAdmission): bool = s.cleanupIds.length() > 0
pure val scopeOne: PairingScope = { agent: "a1", channel: "chat", sender: "one" }
pure val scopeTwo: PairingScope = { agent: "a1", channel: "chat", sender: "two" }
pure val inputValues: Set[AdmissionInput] = Set({ scope: scopeOne, metadata: absentMetadata }, { scope: scopeOne, metadata: { present: true, entries: List({ key: "display", value: "Name" }) } }, { scope: scopeTwo, metadata: absentMetadata }, { scope: { ...scopeOne, channel: "mail" }, metadata: absentMetadata })
pure val enteredAtValues = Set(0, 1, 2, 3)
pure val emptyCode: GeneratedCode = { id: "", code: "", normalizedCode: "" }
pure val failedWrite: WriteOutcome = { kind: WriteFailure, generated: emptyCode }
pure val repeatedWrite: WriteOutcome = { kind: RepeatedWrite, generated: emptyCode }
pure val firstWrite: WriteOutcome = { kind: FreshWrite, generated: { id: "request1", code: "MNPQRTUV", normalizedCode: "MNPQRTUV" } }
pure val secondWrite: WriteOutcome = { kind: FreshWrite, generated: { id: "request2", code: "NPQRTUVM", normalizedCode: "NPQRTUVM" } }
pure val collidingWrite: WriteOutcome = { kind: FreshWrite, generated: { id: "request3", code: "MNPQRTUV", normalizedCode: "MNPQRTUV" } }
pure val writeResultValues: Set[WriteOutcome] = Set(failedWrite, repeatedWrite, firstWrite, secondWrite, collidingWrite)
pure val rowValues: Set[PendingRow] = Set({ scope: scopeOne, id: "legacy1", code: "mnpqrtuv", normalizedCode: "MNPQRTUV", createdAt: -10, lastSeenAt: 0, metadata: absentMetadata }, { scope: scopeOne, id: "legacy2", code: "MNPQRSTV", normalizedCode: "MNPQRSTV", createdAt: -11, lastSeenAt: 0, metadata: absentMetadata })
pure val idValues = Set("request1", "request2", "request3", "legacy1", "legacy2")
pure val maximumValues = Set(0, 1, 2, 3)
pure val ttlValues = Set(1, 5, 3600000)
pure val readAtValues = Set(0, 1, 3, 6, 3600001)
pure val fair_enterAdmission = "weak"
pure val fair_readPending = "weak"
pure val fair_writePending = "weak"
pure val fair_rejectFull = "weak"
pure def received(s: PairingAdmission, ticket: int): bool = s.receipts.some(receipt => receipt.ticket == ticket)
pure def leadsToAdmissionReleased(s: PairingAdmission, later: PairingAdmission): bool = s.activeTicket != 0 implies received(later, s.activeTicket)
pure def leadsToQueuedAdmissionsSettle(s: PairingAdmission, later: PairingAdmission): bool = s.waiting.every(queuedCall => received(later, queuedCall.ticket))
```
