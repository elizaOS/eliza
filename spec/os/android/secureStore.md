# Secure store

The device keeps small JSON values in encrypted slots. Each slot is one
file in no-backup storage, named by the SHA-256 of the slot name, and holds
one AES-GCM frame under a hardware-backed Android Keystore key, with the
file name as associated data. One process lock holds every read, write,
remove and compare-and-exchange, so this machine follows one mutation at a
time. Values stay in the Java shell: the model sees the slot name, the
evidence the shell read, the byte sizes and the outcome. Which slots are
native-only, which the app view may write and which it may also
compare-and-exchange, and each slot's byte budget, are the consumer's
policy, supplied as data. Sources: `JsonCredentialSlots`
(`plugins/plugin-native-secure-store/android-nativeonly`) and
`SecureSlotPolicy` (`plugins/plugin-native-agent`). Native custody (the
device credential in `signIn/credential` and the task keys in
`android/taskKeys`) uses the same slots.

## Story: Persist a value without losing a newer edit

> As a person using the device, I want each value saved only where the
> caller may write it. When I compare and exchange, the store checks the
> current value and preserves a newer or unreadable value.

### The app view names only slots its consumer policy opens to it, and never a delegation slot

The shell classifies the slot name before any file is touched: the
consumer policy gives its access and budget, and any name under
`cloud-delegation:` is a delegation slot, which os does not support. A
native-only namespace covers its exact name and every name that follows it
with a colon. A native caller may use any supported slot. The app view may
read, write and remove a slot that is not native-only, and may
compare-and-exchange only a slot the policy marks exchangeable. A name is
1 to 1024 UTF-16 units, and a budget has a current limit of at least one
byte and a retained ceiling no lower than it; anything else is refused.

```quint
import atomicPublication as P from "../../core/atomicPublication"
type SlotAccess = NativeOnly | RendererWritable | RendererExchangeable
type SlotFamily = OrdinarySlot | DelegationSlot
type SlotRule = { slot: str, family: SlotFamily, access: SlotAccess, limit: int, retained: int }
type Caller = NativeCaller | RendererCaller
type SlotRequest = ReadRequest | WriteRequest | RemoveRequest | ExchangeRequest
pure def budgetValid(rule: SlotRule): bool = rule.limit >= 1 and rule.retained >= rule.limit
pure def admits(caller: Caller, request: SlotRequest, rule: SlotRule): bool =
  rule.slot != "" and rule.family == OrdinarySlot and budgetValid(rule) and
    (caller == NativeCaller or (rule.access != NativeOnly and (request != ExchangeRequest or rule.access == RendererExchangeable)))
pure val ruleValues = Set(
  { slot: "draft", family: OrdinarySlot, access: RendererExchangeable, limit: 32, retained: 48 },
  { slot: "notes", family: OrdinarySlot, access: RendererWritable, limit: 32, retained: 32 },
  { slot: "journal", family: OrdinarySlot, access: NativeOnly, limit: 32, retained: 32 },
  { slot: "delegation", family: DelegationSlot, access: RendererExchangeable, limit: 32, retained: 32 })
pure def lawAppViewNeverReachesNativeOnlySlot(request: SlotRequest, rule: SlotRule): bool =
  rule.access == NativeOnly implies not(admits(RendererCaller, request, rule))
pure def lawAppViewExchangesOnlyExchangeableSlot(rule: SlotRule): bool =
  admits(RendererCaller, ExchangeRequest, rule) implies rule.access == RendererExchangeable
pure def lawDelegationSlotIsRefused(caller: Caller, request: SlotRequest, rule: SlotRule): bool =
  rule.family == DelegationSlot implies not(admits(caller, request, rule))
```

### A slot is absent only when none of its files exists, and an unreadable slot is never treated as absent

The shell opens the frame and reports what it found: no file and no backup
(`NoFile`), a file or backup it cannot open (`Unopenable`), a frame that is
not version 1 with a 12-byte nonce, fails authentication, or is not exactly
one JSON value (`Rejected`), or an authentic value with its UTF-8 size. An
authentic value larger than the retained ceiling is unreadable. A read
reports an unreadable slot as an error. Compare-and-exchange cannot treat
it as absent, so only an absent slot may be initialised through an
exchange that expects no value.

```quint
type Frame = NoFile | Unopenable | Rejected | Authentic({ bytes: int })
type SlotRead = Absent | Unreadable | Value({ bytes: int })
pure def readFrame(frame: Frame, rule: SlotRule): SlotRead = match frame {
  | NoFile => Absent
  | Authentic(f) => if (f.bytes >= 1 and f.bytes <= rule.retained) Value({ bytes: f.bytes }) else Unreadable
  | _ => Unreadable
}
pure def mayInitialize(observed: SlotRead): bool = observed == Absent
pure val frameValues = Set(NoFile, Unopenable, Rejected, Authentic({ bytes: 10 }), Authentic({ bytes: 40 }), Authentic({ bytes: 60 }))
pure def lawOnlyAMissingFileReadsAbsent(frame: Frame, rule: SlotRule): bool =
  mayInitialize(readFrame(frame, rule)) implies frame == NoFile
pure def lawOversizedValueIsUnreadable(frame: Frame, rule: SlotRule): bool = match frame {
  | Authentic(f) => f.bytes > rule.retained implies readFrame(frame, rule) == Unreadable
  | _ => true
}
```

### A value above the current limit cannot grow beyond the value already stored

A value is at most the retained ceiling. Above the current limit it is
accepted only when the slot already holds a value at least as large, so an
absent slot is never initialised above the limit. A refusal for size is
definite: nothing was written and the caller is told the storage is full.
An empty value is refused.

```quint
type Proposal = RemoveValue | PutValue({ bytes: int })
type ExchangeOutcome = Written | Removed | Conflict | CapacityRefused | Refused | Failed | Unconfirmed
type Verdict = WriteFrame | EraseFrame | Answer({ outcome: ExchangeOutcome })
pure def priorBytes(observed: SlotRead): int = match observed {
  | Value(v) => v.bytes
  | _ => -1
}
pure def putVerdict(bytes: int, rule: SlotRule, observed: SlotRead): Verdict =
  if (bytes < 1) Answer({ outcome: Refused })
  else if (bytes > rule.retained) Answer({ outcome: CapacityRefused })
  else if (bytes > rule.limit and observed == Unreadable) Answer({ outcome: Failed })
  else if (bytes > rule.limit and bytes > priorBytes(observed)) Answer({ outcome: CapacityRefused })
  else WriteFrame
pure val proposalValues = Set(RemoveValue, PutValue({ bytes: 0 }), PutValue({ bytes: 10 }), PutValue({ bytes: 40 }), PutValue({ bytes: 60 }))
pure val observedValues = Set(Absent, Unreadable, Value({ bytes: 10 }), Value({ bytes: 40 }))
pure def lawNeverWritesAboveRetained(bytes: int, rule: SlotRule, observed: SlotRead): bool =
  putVerdict(bytes, rule, observed) == WriteFrame implies (bytes >= 1 and bytes <= rule.retained)
pure def lawAboveLimitOnlyShrinks(bytes: int, rule: SlotRule, observed: SlotRead): bool =
  (putVerdict(bytes, rule, observed) == WriteFrame and bytes > rule.limit) implies bytes <= priorBytes(observed)
```

### A compare-and-exchange changes a slot only when it holds exactly the expected value

An unconditional write or removal replaces whatever is there. A
compare-and-exchange names the value it expects: none, or an exact
serialized text, which the shell compares in full with the stored text. A
slot that cannot be read fails the exchange; a value other than the
expected one is a conflict, and neither writes nor removes.

```quint
type Expectation = Unconditional | ExpectAbsent | ExpectText({ sameAsStored: bool })
pure def requestOf(expectation: Expectation, proposal: Proposal): SlotRequest =
  if (expectation != Unconditional) ExchangeRequest else match proposal { | RemoveValue => RemoveRequest | _ => WriteRequest }
pure def expectationHolds(expectation: Expectation, observed: SlotRead): bool = match expectation {
  | Unconditional => true
  | ExpectAbsent => observed == Absent
  | ExpectText(t) => t.sameAsStored and priorBytes(observed) >= 1
}
pure def verdict(caller: Caller, rule: SlotRule, expectation: Expectation, proposal: Proposal, observed: SlotRead): Verdict =
  if (not(admits(caller, requestOf(expectation, proposal), rule))) Answer({ outcome: Refused })
  else if (expectation != Unconditional and observed == Unreadable) Answer({ outcome: Failed })
  else if (not(expectationHolds(expectation, observed))) Answer({ outcome: Conflict })
  else match proposal {
    | RemoveValue => EraseFrame
    | PutValue(p) => putVerdict(p.bytes, rule, observed)
  }
pure def mutates(v: Verdict): bool = v == WriteFrame or v == EraseFrame
pure val expectationValues = Set(Unconditional, ExpectAbsent, ExpectText({ sameAsStored: true }), ExpectText({ sameAsStored: false }))
pure def lawStaleExchangeNeverMutates(caller: Caller, rule: SlotRule, expectation: Expectation, proposal: Proposal, observed: SlotRead): bool =
  not(expectationHolds(expectation, observed)) implies not(mutates(verdict(caller, rule, expectation, proposal, observed)))
pure def lawUnreadableSlotNeverExchanges(caller: Caller, rule: SlotRule, expectation: Expectation, proposal: Proposal): bool =
  expectation != Unconditional implies not(mutates(verdict(caller, rule, expectation, proposal, Unreadable)))
pure def lawRefusedRequestNeverMutates(caller: Caller, rule: SlotRule, expectation: Expectation, proposal: Proposal, observed: SlotRead): bool =
  not(admits(caller, requestOf(expectation, proposal), rule)) implies verdict(caller, rule, expectation, proposal, observed) == Answer({ outcome: Refused })
```

### A write is acknowledged only after it reads back exactly, and a removal only after every file of the slot is gone

A write publishes a new frame atomically (core atomic publication), syncs
it, then reads the committed file and compares it byte for byte. A failure
receipt means the old frame is still in place, so the write has definitely
failed. A published frame that does not read back exactly is unconfirmed:
the caller rereads before it retries. A removal deletes the file, its
backup and its staged sibling, and is acknowledged only when all three are
gone. A refusal, conflict or failure decided before the files are touched
is answered at once.

```quint
type SlotExchange = Ready | Writing({ slot: str }) | Removing({ slot: str }) | Answered({ slot: str, outcome: ExchangeOutcome })
pure val initial: SlotExchange = Ready
pure def inFlight(s: SlotExchange): bool = match s { | Writing(w) => true | Removing(r) => true | _ => false }
pure def canBegin(s: SlotExchange): bool = not(inFlight(s))
pure def begin(s: SlotExchange, by: Caller, rule: SlotRule, expectation: Expectation, proposal: Proposal, observed: SlotRead): SlotExchange = {
  val decided = verdict(by, rule, expectation, proposal, observed)
  match decided {
    | WriteFrame => Writing({ slot: rule.slot })
    | EraseFrame => Removing({ slot: rule.slot })
    | Answer(a) => Answered({ slot: rule.slot, outcome: a.outcome })
  }
}
pure def canSettleWrite(s: SlotExchange, receipt: P::PublicationReceipt): bool =
  (receipt == P::SuccessReceipt or receipt == P::FailureReceipt) and match s { | Writing(w) => true | _ => false }
pure def settleWrite(s: SlotExchange, receipt: P::PublicationReceipt, readBack: bool): SlotExchange = match s {
  | Writing(w) => Answered({ slot: w.slot, outcome: if (receipt == P::FailureReceipt) Failed else if (readBack) Written else Unconfirmed })
  | _ => s
}
pure def canSettleRemove(s: SlotExchange): bool = match s { | Removing(r) => true | _ => false }
pure def settleRemove(s: SlotExchange, allGone: bool): SlotExchange = match s {
  | Removing(r) => Answered({ slot: r.slot, outcome: if (allGone) Removed else Unconfirmed })
  | _ => s
}
pure def outcomeOf(s: SlotExchange): ExchangeOutcome = match s { | Answered(a) => a.outcome | _ => Unconfirmed }
pure def slotOf(s: SlotExchange): str = match s { | Writing(w) => w.slot | Removing(r) => r.slot | Answered(a) => a.slot | _ => "" }
pure def answered(s: SlotExchange): bool = match s { | Answered(a) => true | _ => false }
pure val receiptValues = Set(P::SuccessReceipt, P::FailureReceipt)
pure def stepWrittenOnlyAfterReadback(before: SlotExchange, via: str, after: SlotExchange): bool =
  (answered(after) and outcomeOf(after) == Written and before != after) implies (via == "settleWrite" and match before { | Writing(w) => true | _ => false })
pure def stepRemovedOnlyAfterEveryFileIsGone(before: SlotExchange, via: str, after: SlotExchange): bool =
  (answered(after) and outcomeOf(after) == Removed and before != after) implies (via == "settleRemove" and match before { | Removing(r) => true | _ => false })
pure def stepSettlingAnswersTheSameSlot(before: SlotExchange, via: str, after: SlotExchange): bool =
  (via == "settleWrite" or via == "settleRemove") implies slotOf(after) == slotOf(before)
pure def sometimesWritten(s: SlotExchange): bool = outcomeOf(s) == Written and answered(s)
pure def sometimesRemoved(s: SlotExchange): bool = outcomeOf(s) == Removed
pure def sometimesConflict(s: SlotExchange): bool = outcomeOf(s) == Conflict
pure def sometimesStorageFull(s: SlotExchange): bool = outcomeOf(s) == CapacityRefused
pure def sometimesRefused(s: SlotExchange): bool = outcomeOf(s) == Refused
pure def sometimesFailedWithOldValueKept(s: SlotExchange): bool = outcomeOf(s) == Failed
pure def sometimesUnconfirmed(s: SlotExchange): bool = answered(s) and outcomeOf(s) == Unconfirmed
```

### Every mutation that touches the files is answered

The platform eventually completes each admitted write and removal; the
caller always receives an answer, never silence.

```quint
pure val fair_settleWrite = "weak"
pure val fair_settleRemove = "weak"
pure def leadsToMutationAnswered(s: SlotExchange, later: SlotExchange): bool = inFlight(s) implies answered(later)
```
