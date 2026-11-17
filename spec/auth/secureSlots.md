# Secure slots

The native secure store keeps small JSON values for the device in encrypted
slots, under a hardware-backed key, with atomic files. A renderer reaches it
through a bridge that names a slot and asks to read, write,
compare-and-exchange or remove it; a consumer's drafts, journals and caches
use this path, and a verified account snapshot and per-slot task key
wrapping use the same primitive natively. The
[credential broker](./credentialBroker.md) owns those native callers'
authority. Which slot names belong to the native host, which a renderer may
exchange, and each slot's size budget are the branded deployment's policy,
supplied as data.

## Story: Persist a local draft without changing a native journal or a newer edit

> As a person writing on the device, I want my draft saved only where the
> app may write, and never over a newer edit or a native journal.

### A renderer can only name an allowed slot and compare approved draft slots

A slot name is 1–1024 UTF-16 code units. A native-only root is refused
both by itself and followed by a colon and any suffix; a prefix lookalike
without the colon is an ordinary name. Compare-and-exchange needs both
`expectedValue` and `value`, each a string or JSON null, and an allowed
slot: an exact exchange name, a draft root under `:v1:`, or a hashed
family under `:v1:` with exactly 64 lowercase hex digits. Credential slots
may be read; their writes and removals take the credential intent path,
and their mutation stays with the native lifecycle owner. The decoder
derives every flag of a slot name from the slot string itself, never from
a renderer's claim, against the deployment's slot policy.

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
  { text: "draft:v1:x", units: 10, nativeRoot: false, exactExchange: true, draftRoot: false, hashedFamily: false, credentialSlot: false, scopeV1: true, lowerHex64: false },
  { text: "native:v1:x", units: 11, nativeRoot: true, exactExchange: false, draftRoot: false, hashedFamily: false, credentialSlot: false, scopeV1: true, lowerHex64: false },
  { text: "drafts:v1:", units: 10, nativeRoot: false, exactExchange: false, draftRoot: true, hashedFamily: false, credentialSlot: false, scopeV1: true, lowerHex64: false },
  { text: "credential:x", units: 12, nativeRoot: false, exactExchange: false, draftRoot: false, hashedFamily: false, credentialSlot: true, scopeV1: false, lowerHex64: false },
  { text: "unknown", units: 7, nativeRoot: false, exactExchange: false, draftRoot: false, hashedFamily: false, credentialSlot: false, scopeV1: false, lowerHex64: false })
pure def lawRendererCannotEnterNativeNamespace(slotName: SlotName, request: SlotRequest, exactFields: bool): bool =
  slotName.nativeRoot implies bridgeAdmission(slotName, request, exactFields) == RefusedSlot
pure def lawUnapprovedExchangeRefused(slotName: SlotName, exactFields: bool): bool =
  (not(exactFields) or not(draftExchange(slotName)) or slotName.credentialSlot) implies
    bridgeAdmission(slotName, ExchangeSlot, exactFields) == RefusedSlot
```

### Storage distinguishes absence, unreadability, conflict and a definite capacity refusal

A slot is absent only if neither its file nor its backup exists. A frame
that fails to open, fails authentication, holds anything but exactly one
JSON value or exceeds the retained ceiling is unreadable, never absent. A
present slot compares by its full serialized text, an absent one only with
null. A stale expected value is a conflict and neither writes nor removes.
A deployment that preflights the retained ceiling refuses an oversized
replacement before that comparison. A platform failure remains an error.

Each slot has a current limit and a retained ceiling at least as large, in
UTF-8 bytes. A value above the current limit may only match or shrink the
stored length, so an absent slot is never initialized above the limit. A
capacity refusal leaves the bytes untouched and reports storage full.

```quint
type SlotRead = SlotAbsent | SlotUnreadable | SlotValue({ opaqueText: str, storedBytes: int })
type ExpectedValue = ExpectAbsent | ExpectValue({ exactText: str })
type FrameOpen = OpenedFrame | FrameMissing | OtherOpenError
type JsonFrameEvidence = { opened: FrameOpen, baseVisible: bool, backupVisible: bool, correctFrame: bool,
  authenticated: bool, singleJson: bool, plainBytes: int, valueToken: str }
type SlotBudget = { limit: int, retained: int }
type SerializedProposal = { units: int, utf8Bytes: int, singleJson: bool, token: str }
type Replacement = RemoveValue | ReplaceValue(SerializedProposal)
type SlotDecision = SlotConflict | SlotFull | SlotFailed | CanWriteFrame | CanEraseFrame
pure def budgetValid(budget: SlotBudget): bool = budget.limit >= 1 and budget.retained >= budget.limit and budget.retained <= 2147483583
pure def readFrame(frame: JsonFrameEvidence, budget: SlotBudget): SlotRead =
  if (not(budgetValid(budget))) SlotUnreadable
  else if (frame.opened == FrameMissing and not(frame.baseVisible) and not(frame.backupVisible)) SlotAbsent
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
  { opened: FrameMissing, baseVisible: false, backupVisible: false, correctFrame: false, authenticated: false, singleJson: false, plainBytes: 0, valueToken: "" },
  { opened: OpenedFrame, baseVisible: true, backupVisible: true, correctFrame: true, authenticated: false, singleJson: true, plainBytes: 31, valueToken: "draft-2" })
pure val observedValues = Set(SlotAbsent, SlotUnreadable, SlotValue({ opaqueText: "draft-1", storedBytes: 30 }),
  SlotValue({ opaqueText: "draft-2", storedBytes: 32 }))
pure val expectedValues = Set(ExpectAbsent, ExpectValue({ exactText: "draft-1" }), ExpectValue({ exactText: "draft-2" }))
pure val proposalValues = Set(RemoveValue,
  ReplaceValue({ units: 30, utf8Bytes: 30, singleJson: true, token: "draft-1" }),
  ReplaceValue({ units: 31, utf8Bytes: 31, singleJson: true, token: "draft-2" }),
  ReplaceValue({ units: 32, utf8Bytes: 33, singleJson: true, token: "draft-3" }),
  ReplaceValue({ units: 6, utf8Bytes: 6, singleJson: false, token: "invalid" }))
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
pure def lawAboveCurrentSizeNeverGrows(proposal: Replacement, budget: SlotBudget, priorExtent: int): bool = match proposal {
  | RemoveValue => true
  | ReplaceValue(encoded) => (encoded.utf8Bytes > budget.limit and writeDecision(proposal, budget, priorExtent) == CanWriteFrame) implies
    (encoded.utf8Bytes <= priorExtent and encoded.utf8Bytes <= budget.retained)
}
pure def lawAbsentExchangeCannotInitializeAboveCap(proposal: Replacement, budget: SlotBudget, retainedPreflight: bool): bool = match proposal {
  | RemoveValue => true
  | ReplaceValue(encoded) => encoded.utf8Bytes > budget.limit implies exchangeDecision(SlotAbsent, ExpectAbsent, proposal, budget, retainedPreflight) != CanWriteFrame
}
```

### An exchange is acknowledged only after local readback confirms the result

One slot mutation runs inside the process-wide lock, for the bridge's
current owner. A conflicting or refused request never touches the files. A
write is acknowledged only after the new frame reads back exactly, and a
removal only after the file, its backup and its staged sibling are all
gone; any other outcome is unconfirmed, and the caller rereads before it
retries.

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
