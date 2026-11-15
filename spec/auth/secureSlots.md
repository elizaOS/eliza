# Native JSON slots and renderer storage admission

The native secure store keeps small JSON values for the device in
encrypted slots: `JsonCredentialSlots` under the Android `nativeonly`
module of the secure-store plugin, with Keystore keys and atomic files.
A renderer reaches it through a bridge that names a slot and asks to read,
write, compare-and-exchange or remove it. Notes, a mail journal, linked
calendar checkpoints and a read cache reach this path in a consumer; a
verified account snapshot and per-slot task key wrapping use the same
primitive natively. The [credential broker](./credentialBroker.md) owns
those native callers' authority. Which slot names belong to the native host,
which a renderer may exchange, and each slot's size budget are the branded
deployment's policy, supplied as data.

## Story: Persist a local draft without changing a native journal or a newer edit

> As a person writing on the device, I want my draft saved only where the
> app may write, and never over a newer edit or a native journal.

### A renderer can only name an allowed slot and compare approved draft slots

The shared slot policy validates 1–1024 UTF-16 code units. The bridge
refuses each native-only root both by itself and followed by a colon and
any suffix. Prefix lookalikes without the colon are ordinary names.
Compare-and-exchange requires a full allow-list match and both
`expectedValue` and `value` properties. Each property is a string or
explicit JSON null. A draft root's suffix can be empty and can contain line
breaks. Hashed families require exactly 64 lowercase hex digits. The Cloud
credential slots may be read and use the credential intent path for writes
and removals. The native storage layer maps logical Cloud names to the
installed deployment prefix. Renderer calls cannot use that physical
namespace. Cloud credential mutation and agent retirement remain with the
native lifecycle owner.

The bridge decoder derives the length, whether the root (the substring
before the first colon) is in each family of the deployment's slot policy,
and whether the exact `:v1:` framing and lowercase digest suffix were
present, all from the same slot string. These are decoder evidence, never
renderer claims. The native roots, exact exchange names, draft roots,
hashed exchange families and credential slots are the deployment's
policy, supplied as data.

```quint
type SlotRequest = ReadSlot | WriteSlot | ExchangeSlot | RemoveSlot
type SlotName = { text: str, units: int, nativeRoot: bool, exactExchange: bool, draftRoot: bool, hashedFamily: bool,
  credentialSlot: bool, scopeV1: bool, lowerHex64: bool }
type BridgeAdmission = RefusedSlot | LocalSlot | CredentialIntent
pure def draftExchange(slotName: SlotName): bool =
  slotName.exactExchange or (slotName.scopeV1 and (slotName.draftRoot or (slotName.lowerHex64 and slotName.hashedFamily)))
pure def bridgeAdmission(slotName: SlotName, request: SlotRequest, exactFields: bool): BridgeAdmission =
  if (slotName.text == "" or slotName.units < 1 or slotName.units > 1024 or slotName.nativeRoot) RefusedSlot
  else if (request == ExchangeSlot) {
    if (exactFields and draftExchange(slotName) and not(slotName.credentialSlot)) LocalSlot else RefusedSlot
  } else if (slotName.credentialSlot and (request == WriteSlot or request == RemoveSlot)) CredentialIntent
  else LocalSlot
pure val slotNameValues = Set(
  { text: "notes-draft:v1:device", units: 21, nativeRoot: false, exactExchange: true, draftRoot: false, hashedFamily: false, credentialSlot: false, scopeV1: true, lowerHex64: false },
  { text: "sms-send-ledger:v1:device", units: 25, nativeRoot: true, exactExchange: false, draftRoot: false, hashedFamily: false, credentialSlot: false, scopeV1: true, lowerHex64: false },
  { text: "mail-drafts:v1:", units: 15, nativeRoot: false, exactExchange: false, draftRoot: true, hashedFamily: false, credentialSlot: false, scopeV1: true, lowerHex64: false },
  { text: "cloud:production", units: 16, nativeRoot: false, exactExchange: false, draftRoot: false, hashedFamily: false, credentialSlot: true, scopeV1: false, lowerHex64: false },
  { text: "unknown", units: 7, nativeRoot: false, exactExchange: false, draftRoot: false, hashedFamily: false, credentialSlot: false, scopeV1: false, lowerHex64: false })
pure def lawRendererCannotEnterNativeNamespace(slotName: SlotName, request: SlotRequest, exactFields: bool): bool =
  slotName.nativeRoot implies bridgeAdmission(slotName, request, exactFields) == RefusedSlot
pure def lawUnapprovedExchangeRefused(slotName: SlotName, exactFields: bool): bool =
  (not(exactFields) or not(draftExchange(slotName)) or slotName.credentialSlot) implies
    bridgeAdmission(slotName, ExchangeSlot, exactFields) == RefusedSlot
```

### Storage distinguishes absence, unreadability, conflict and a definite capacity refusal

The native port authenticates one complete frame before yielding its
serialized value and checks that Android's JSON tokener accepts exactly
one value and no trailing token. The format remains byte version 1,
IV-length byte 12, the 12-byte IV, then AES-GCM ciphertext and 16-byte tag.
The lowercase SHA-256 of the slot's UTF-8 name is the filename and its
ASCII spelling is the AAD. The host supplies a dedicated directory and
AndroidKeyStore AES-256 alias, and the budget of each slot: a current
limit and a retained ceiling at least as large. Raw credentials and data
keys are represented only by synthetic equality tokens here.

An open that throws `FileNotFoundException` means absent only if both
the base and `.bak` are absent. Other open failures, invalid framing,
authentication, invalid JSON and oversized authenticated content remain
unreadable. For an existing slot, compare the full serialized
representation, preserving whitespace and key order in the comparison.
An absent slot compares only with null. The JSON string transmitted as
`"null"` is a present value. A stale expected value returns conflict
under the same process lock. It cannot trigger removal or write.
A deployment that preflights the retained ceiling does so before that
comparison. In the shared primitive the comparison precedes validation of
a replacement's size and JSON syntax. A platform failure remains an error,
including one reading a corrupt frame during CAS.

Android measures UTF-8 bytes. A value above the current limit may only
match or shrink the existing stored plaintext length, within the retained
ceiling. The direct write path gets that size from the existing frame
header and extent, without interpreting its payload; it cannot use that
observation to assert a successful authenticated read. CAS has already
read the whole prior authenticated value before this extent check. An
absent slot therefore cannot be initialized above the current limit.
Moving below that limit gives up the prior larger allowance. Rejecting for
capacity leaves bytes untouched and reports storage full.

```quint
type SlotRead = SlotAbsent | SlotUnreadable | SlotValue({ opaqueText: str, storedBytes: int })
type ExpectedValue = ExpectAbsent | ExpectValue({ exactText: str })
type FrameOpen = OpenedFrame | FileNotFound | OtherOpenError
type JsonFrameEvidence = { opened: FrameOpen, baseVisible: bool, backupVisible: bool, correctFrame: bool,
  authenticated: bool, singleJson: bool, plainBytes: int, valueToken: str }
type SlotBudget = { limit: int, retained: int }
type SerializedProposal = { units: int, utf8Bytes: int, singleJson: bool, token: str }
type Replacement = RemoveValue | ReplaceValue({ units: int, utf8Bytes: int, singleJson: bool, token: str })
type SlotDecision = SlotConflict | SlotFull | SlotFailed | CanWriteFrame | CanEraseFrame
pure def budgetValid(budget: SlotBudget): bool = budget.limit >= 1 and budget.retained >= budget.limit and budget.retained <= 2147483583
pure def readFrame(frame: JsonFrameEvidence, budget: SlotBudget): SlotRead =
  if (not(budgetValid(budget))) SlotUnreadable
  else if (frame.opened == FileNotFound and not(frame.baseVisible) and not(frame.backupVisible)) SlotAbsent
  else if (frame.opened == OpenedFrame and frame.correctFrame and frame.authenticated and frame.singleJson and
    frame.plainBytes >= 1 and frame.plainBytes <= budget.retained) SlotValue({ opaqueText: frame.valueToken, storedBytes: frame.plainBytes })
  else SlotUnreadable
pure def isAbsent(observed: SlotRead): bool = match observed { | SlotAbsent => true | _ => false }
pure def isUnreadable(observed: SlotRead): bool = match observed { | SlotUnreadable => true | _ => false }
pure def hasValue(observed: SlotRead): bool = match observed { | SlotValue(held) => true | _ => false }
pure def expectedMatches(observed: SlotRead, expected: ExpectedValue): bool = match expected {
  | ExpectAbsent => isAbsent(observed)
  | ExpectValue(draft) => match observed {
    | SlotValue(held) => held.opaqueText == draft.exactText
    | _ => false
  }
}
pure def observedExtent(observed: SlotRead): int = match observed {
  | SlotValue(held) => held.storedBytes
  | _ => -1
}
pure def overRetained(proposal: Replacement, budget: SlotBudget): bool = match proposal {
  | RemoveValue => false
  | ReplaceValue(encoded) => encoded.units > budget.retained or encoded.utf8Bytes > budget.retained
}
pure def writeDecision(proposal: Replacement, budget: SlotBudget, priorExtent: int): SlotDecision = match proposal {
  | RemoveValue => CanEraseFrame
  | ReplaceValue(encoded) =>
    if (not(budgetValid(budget)) or encoded.units < 1 or encoded.utf8Bytes < 1) SlotFailed
    else if (encoded.units > budget.retained) SlotFull
    else if (not(encoded.singleJson)) SlotFailed
    else if (encoded.utf8Bytes > budget.retained or (encoded.utf8Bytes > budget.limit and encoded.utf8Bytes > priorExtent)) SlotFull
    else CanWriteFrame
}
pure def exchangeDecision(observed: SlotRead, expected: ExpectedValue, proposal: Replacement, budget: SlotBudget,
  retainedPreflight: bool): SlotDecision =
  if (not(budgetValid(budget))) SlotFailed
  else if (retainedPreflight and overRetained(proposal, budget)) SlotFull
  else if (isUnreadable(observed)) SlotFailed
  else if (not(expectedMatches(observed, expected))) SlotConflict
  else writeDecision(proposal, budget, observedExtent(observed))
pure val budgetValues = Set({ limit: 256, retained: 256 }, { limit: 30, retained: 32 }, { limit: 0, retained: 0 })
pure val frameValues = Set(
  { opened: OpenedFrame, baseVisible: true, backupVisible: false, correctFrame: true, authenticated: true, singleJson: true, plainBytes: 31, valueToken: "draft-1" },
  { opened: FileNotFound, baseVisible: false, backupVisible: false, correctFrame: false, authenticated: false, singleJson: false, plainBytes: 0, valueToken: "" },
  { opened: OpenedFrame, baseVisible: true, backupVisible: true, correctFrame: true, authenticated: false, singleJson: true, plainBytes: 31, valueToken: "draft-2" })
pure val observedValues = Set(SlotAbsent, SlotUnreadable, SlotValue({ opaqueText: "draft-1", storedBytes: 30 }),
  SlotValue({ opaqueText: "draft-2", storedBytes: 32 }))
pure val expectedValues = Set(ExpectAbsent, ExpectValue({ exactText: "draft-1" }), ExpectValue({ exactText: "draft-2" }))
pure val proposalValues = Set(RemoveValue,
  ReplaceValue({ units: 30, utf8Bytes: 30, singleJson: true, token: "draft-1" }),
  ReplaceValue({ units: 31, utf8Bytes: 31, singleJson: true, token: "draft-2" }),
  ReplaceValue({ units: 32, utf8Bytes: 33, singleJson: true, token: "draft-3" }),
  ReplaceValue({ units: 6, utf8Bytes: 6, singleJson: false, token: "invalid" }))
pure val encodedValues = Set({ units: 31, utf8Bytes: 31, singleJson: true, token: "draft-2" },
  { units: 32, utf8Bytes: 33, singleJson: true, token: "draft-3" })
pure val priorExtentValues = Set(-1, 30, 31, 32)
pure def lawInvalidBudgetNeverReadsOrWrites(frame: JsonFrameEvidence, budget: SlotBudget, observed: SlotRead, expected: ExpectedValue,
  proposal: Replacement, retainedPreflight: bool): bool =
  not(budgetValid(budget)) implies (isUnreadable(readFrame(frame, budget)) and
    exchangeDecision(observed, expected, proposal, budget, retainedPreflight) == SlotFailed)
pure def lawExistingFileCannotReadAsAbsent(frame: JsonFrameEvidence, budget: SlotBudget): bool =
  (frame.baseVisible or frame.backupVisible) implies not(isAbsent(readFrame(frame, budget)))
pure def lawUnauthenticatedFrameCannotSupplyValue(frame: JsonFrameEvidence, budget: SlotBudget): bool =
  not(frame.authenticated) implies not(hasValue(readFrame(frame, budget)))
pure def lawUnreadableNeverMatchesAbsent(expected: ExpectedValue, proposal: Replacement, budget: SlotBudget, retainedPreflight: bool): bool =
  (exchangeDecision(SlotUnreadable, expected, proposal, budget, retainedPreflight) == SlotFailed or
    exchangeDecision(SlotUnreadable, expected, proposal, budget, retainedPreflight) == SlotFull)
pure def lawStaleExchangeCannotChangeBytes(observed: SlotRead, expected: ExpectedValue, proposal: Replacement, budget: SlotBudget,
  retainedPreflight: bool): bool =
  (budgetValid(budget) and not(isUnreadable(observed)) and not(expectedMatches(observed, expected)) and
    not(retainedPreflight and overRetained(proposal, budget))) implies
    exchangeDecision(observed, expected, proposal, budget, retainedPreflight) == SlotConflict
pure def lawAboveCurrentSizeNeverGrows(encoded: SerializedProposal, budget: SlotBudget, priorExtent: int): bool =
  (encoded.utf8Bytes > budget.limit and writeDecision(ReplaceValue({ units: encoded.units, utf8Bytes: encoded.utf8Bytes,
    singleJson: encoded.singleJson, token: encoded.token }), budget, priorExtent) == CanWriteFrame) implies
    encoded.utf8Bytes <= priorExtent and encoded.utf8Bytes <= budget.retained
pure def lawAbsentExchangeCannotInitializeAboveCap(encoded: SerializedProposal, budget: SlotBudget, retainedPreflight: bool): bool =
  encoded.utf8Bytes > budget.limit implies exchangeDecision(SlotAbsent, ExpectAbsent,
    ReplaceValue({ units: encoded.units, utf8Bytes: encoded.utf8Bytes, singleJson: encoded.singleJson, token: encoded.token }),
    budget, retainedPreflight) != CanWriteFrame
```

### An exchange is acknowledged only after local readback confirms the result

The machine describes one slot mutation inside the process-wide lock,
using the caller's authenticated snapshot and physical extent for that
slot. A host that also holds a lifecycle lock takes it before the slot
lock and checks the current bridge owner at entry. A conflicting or
rejected request never enters the filesystem mutation. A write is
acknowledged after the newly written frame is finished and read back
exactly, including the version, IV, ciphertext and end of file. A removal
is acknowledged after the base, `.bak` and `.new` are all absent.
A commit or readback error is an unconfirmed outcome, including failure
after `finishWrite`; a caller must reread before deciding how to retry.
The port supplies readback evidence from this exact serialized operation.
The lock serializes same-process writers. Live readback conveys no
power-loss guarantee. The Java writer syncs its output file but does
not explicitly sync its parent directory.

```quint
type Readback = { exactFrame: bool, baseGone: bool, backupGone: bool, stagedGone: bool }
type ExchangePhase = ReadyExchange | WritingExchange | ErasingExchange | RefusedExchange | SavedExchange | UnconfirmedExchange
type SlotExchange = { phase: ExchangePhase, decision: SlotDecision, verified: bool }
pure val initial: SlotExchange = { phase: ReadyExchange, decision: SlotFailed, verified: false }
pure def canBeginExchange(s: SlotExchange, currentOwner: bool): bool = s.phase == ReadyExchange and currentOwner
pure def beginExchange(s: SlotExchange, currentOwner: bool, observed: SlotRead, expected: ExpectedValue,
  proposal: Replacement, budget: SlotBudget, retainedPreflight: bool): SlotExchange = {
  val decision = exchangeDecision(observed, expected, proposal, budget, retainedPreflight)
  { phase: if (decision == CanWriteFrame) WritingExchange else if (decision == CanEraseFrame) ErasingExchange else RefusedExchange,
    decision: decision, verified: false }
}
pure def canSettleExchange(s: SlotExchange): bool = s.phase == WritingExchange or s.phase == ErasingExchange
pure def confirmsExchange(phase: ExchangePhase, readback: Readback): bool =
  (phase == WritingExchange and readback.exactFrame) or
    (phase == ErasingExchange and readback.baseGone and readback.backupGone and readback.stagedGone)
pure def settleExchange(s: SlotExchange, readback: Readback): SlotExchange = {
  val confirmed = confirmsExchange(s.phase, readback)
  { ...s, phase: if (confirmed) SavedExchange else UnconfirmedExchange, verified: confirmed }
}
pure def canReopenExchange(s: SlotExchange): bool =
  s.phase == RefusedExchange or s.phase == SavedExchange or s.phase == UnconfirmedExchange
pure def reopenExchange(s: SlotExchange): SlotExchange = initial
pure val readbackValues = Set(
  { exactFrame: true, baseGone: false, backupGone: false, stagedGone: false },
  { exactFrame: false, baseGone: true, backupGone: true, stagedGone: true },
  { exactFrame: false, baseGone: true, backupGone: true, stagedGone: false },
  { exactFrame: false, baseGone: false, backupGone: false, stagedGone: false })
pure def alwaysExchangeSavedOnlyWithReadback(s: SlotExchange): bool = (s.phase == SavedExchange) == s.verified
pure def alwaysOnlyAdmittedDecisionCanMutate(s: SlotExchange): bool =
  (s.phase == WritingExchange implies s.decision == CanWriteFrame) and
    (s.phase == ErasingExchange implies s.decision == CanEraseFrame) and
    ((s.phase == SavedExchange or s.phase == UnconfirmedExchange) implies (s.decision == CanWriteFrame or s.decision == CanEraseFrame))
pure def lawRemoveReadbackChecksStagedSibling(readback: Readback): bool =
  not(readback.stagedGone) implies not(confirmsExchange(ErasingExchange, readback))
pure def stepOnlyReadbackCanAcknowledge(before: SlotExchange, via: str, after: SlotExchange): bool =
  (before.phase != SavedExchange and after.phase == SavedExchange) implies
    via == "settleExchange" and (before.phase == WritingExchange or before.phase == ErasingExchange)
pure def sometimesExactWriteAcknowledged(s: SlotExchange): bool = s.phase == SavedExchange and s.decision == CanWriteFrame
pure def sometimesExactEraseAcknowledged(s: SlotExchange): bool = s.phase == SavedExchange and s.decision == CanEraseFrame
pure def sometimesUnconfirmedExchange(s: SlotExchange): bool = s.phase == UnconfirmedExchange
```
