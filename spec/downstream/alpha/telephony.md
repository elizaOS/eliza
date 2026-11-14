# Alpha Phone, Messages, and Contacts review

The renderer uses Eliza's `packages/contracts/src/native-telephony.ts`,
`device-action-execution.ts`, `native-address-book.ts`, `sms-send.ts`, and
`mms-send.ts`. The native image header comes from `MainActivity` and the
installation proofs described in [product admission](./product.md).
Alpha's device receiver scopes the exact proposal, asks for review when
required, and journals the effect. `specs/quint/application/DeviceActionReview.qnt`,
`native/NativeMmsDispatch.qnt`, `native/PhoneCalls.qnt`, and
`native/ContactsBook.qnt` are pinned evidence. Generic approval and receipt
identity remain [core authorization](../../core/capabilityAuthority.md) and
[receipt binding](../../core/receiptBindings.md) contracts.

## Story: Review a phone effect on the verified device and avoid repeating it

### A direct SMS is bounded and uses an active subscription

The native SMS decoder normalizes and deduplicates recipients, rejects
malformed numbers and preserves authored body bytes. Raw recipient count
is checked before deduplication. Handoff accepts up to ten recipients and
5,000 UTF-16 units, and cannot carry a chosen SIM. Direct send accepts up to
five recipients and 1,600 UTF-16 units, rejects NUL and lone surrogates,
and admits one available SIM or an explicit still-active subscription.
Multiple active SIMs require the owner's choice. A handoff is a distinct
terminal outcome from a radio dispatch or delivery receipt. Typed native
permission, role and device errors remain visible to the owner. MMS binds
its exact attachments and multipart dispatch receipt separately.

```quint
type SmsMode = Handoff | Direct
pure val directMode: SmsMode = Direct
type SmsEvidence = { installed: bool, roleAllows: bool, recipients: int, recipientsValid: bool, bodyUnits: int, authored: bool, wellFormed: bool, simKnown: bool, activeSims: int, simChosen: bool, choiceIsActive: bool }
pure val smsValues = Set(
  { installed: true, roleAllows: true, recipients: 1, recipientsValid: true, bodyUnits: 120, authored: true, wellFormed: true, simKnown: true, activeSims: 1, simChosen: false, choiceIsActive: false },
  { installed: true, roleAllows: true, recipients: 1, recipientsValid: true, bodyUnits: 120, authored: true, wellFormed: true, simKnown: true, activeSims: 2, simChosen: false, choiceIsActive: false },
  { installed: true, roleAllows: true, recipients: 1, recipientsValid: true, bodyUnits: 120, authored: true, wellFormed: true, simKnown: true, activeSims: 2, simChosen: true, choiceIsActive: true },
  { installed: false, roleAllows: true, recipients: 1, recipientsValid: true, bodyUnits: 120, authored: true, wellFormed: true, simKnown: true, activeSims: 1, simChosen: false, choiceIsActive: false }
)
pure def validSms(mode: SmsMode, sms: SmsEvidence): bool =
  sms.installed and sms.roleAllows and sms.recipients > 0 and sms.recipientsValid and sms.authored and sms.bodyUnits > 0 and
  (if (mode == Handoff) sms.recipients <= 10 and sms.bodyUnits <= 5000 and not(sms.simChosen)
   else sms.recipients <= 5 and sms.bodyUnits <= 1600 and sms.wellFormed and sms.simKnown and
     (if (sms.simChosen) sms.activeSims >= 1 and sms.choiceIsActive else sms.activeSims == 1))
pure def lawUnverifiedImageCannotDispatch(mode: SmsMode, sms: SmsEvidence): bool = not(sms.installed) implies not(validSms(mode, sms))
pure def lawMultipleSimsNeedAnExplicitChoice(sms: SmsEvidence): bool = sms.activeSims > 1 and not(sms.simChosen) implies not(validSms(Direct, sms))
```

### A durable applying entry consumes the authorization before the external effect

A reviewed device proposal belongs to the live authenticated owner and an
exact operation/request scope. It must be nonsensitive, unexpired and
uncanceled when entering the provider call. The local journal reserves
that identity, records the owner decision and claim, then stores applying
before a dispatch. An existing applying or terminal entry is read back
without sending again. Approval may be replaced by explicit current
request authority only when user preference and operation eligibility
permit direct action. An unknown result remains unknown; receipt upload
failure cannot replay a radio/OS operation. The journal can report a
pre-effect failure from applying if the operation retired before the
external call. This single-proposal machine owns the durable journal and
observed dispatch count. UI cards, native throttles, multipart outcomes,
real journal key derivation and callback timing remain shell obligations.

```quint
type JournalPhase = Empty | Reserved | Applying | Terminal
pure val reservedPhase: JournalPhase = Reserved
pure val applyingPhase: JournalPhase = Applying
pure val terminalPhase: JournalPhase = Terminal
type PhoneEffect = NoEffect | HandedOff | Sent | Delivered | Failed | OutcomeUnknown
pure val failedEffect: PhoneEffect = Failed
type DeviceAuthority = NoAuthority | Approval | DirectRequest
type AuthorityCheck = { live: bool, nonsensitive: bool, unexpired: bool, exact: bool, forceReview: bool, requestEligible: bool, reviewed: bool }
pure val evidenceValues = Set(
  { live: true, nonsensitive: true, unexpired: true, exact: true, forceReview: true, requestEligible: true, reviewed: true },
  { live: true, nonsensitive: true, unexpired: true, exact: true, forceReview: false, requestEligible: true, reviewed: false },
  { live: false, nonsensitive: true, unexpired: true, exact: true, forceReview: false, requestEligible: true, reviewed: true }
)
pure def authority(evidence: AuthorityCheck): DeviceAuthority =
  if (not(evidence.live and evidence.nonsensitive and evidence.unexpired and evidence.exact)) NoAuthority
  else if (evidence.reviewed) Approval else if (not(evidence.forceReview) and evidence.requestEligible) DirectRequest else NoAuthority
pure def legalSmsProgress(before: PhoneEffect, after: PhoneEffect): bool =
  before == NoEffect and (after == HandedOff or after == Sent or after == Failed or after == OutcomeUnknown) or
  before == Sent and after == Delivered
type PhoneJournal = { phase: JournalPhase, claimed: bool, ownerId: int, identity: str, authorityKind: DeviceAuthority, dispatched: bool, outcome: PhoneEffect, uploaded: bool }
pure val initial: PhoneJournal = { phase: Empty, claimed: false, ownerId: 0, identity: "", authorityKind: NoAuthority, dispatched: false, outcome: NoEffect, uploaded: false }
pure def canReserve(s: PhoneJournal, ownerId: int, identity: str, evidence: AuthorityCheck): bool =
  s.phase == Empty and ownerId > 0 and identity != "" and authority(evidence) != NoAuthority
pure def reserve(s: PhoneJournal, ownerId: int, identity: str, evidence: AuthorityCheck): PhoneJournal =
  { ...s, phase: reservedPhase, ownerId: ownerId, identity: identity, authorityKind: authority(evidence) }
pure def canClaim(s: PhoneJournal, ownerId: int, identity: str, evidence: AuthorityCheck): bool =
  s.phase == Reserved and not(s.claimed) and ownerId == s.ownerId and identity == s.identity and authority(evidence) == s.authorityKind
pure def claim(s: PhoneJournal, ownerId: int, identity: str, evidence: AuthorityCheck): PhoneJournal = { ...s, claimed: true }
pure def canWriteApplying(s: PhoneJournal): bool = s.phase == Reserved and s.claimed
pure def writeApplying(s: PhoneJournal): PhoneJournal = { ...s, phase: applyingPhase }
pure def canDispatch(s: PhoneJournal, ownerId: int, identity: str, evidence: AuthorityCheck, mode: SmsMode, sms: SmsEvidence): bool =
  s.phase == Applying and not(s.dispatched) and ownerId == s.ownerId and identity == s.identity and authority(evidence) == s.authorityKind and validSms(mode, sms)
pure def dispatch(s: PhoneJournal, ownerId: int, identity: str, evidence: AuthorityCheck, mode: SmsMode, sms: SmsEvidence): PhoneJournal = { ...s, dispatched: true }
pure def canSettlePhone(s: PhoneJournal, answer: PhoneEffect): bool =
  s.phase == Applying and legalSmsProgress(NoEffect, answer) and (s.dispatched or answer == Failed)
pure def settlePhone(s: PhoneJournal, answer: PhoneEffect): PhoneJournal = { ...s, phase: terminalPhase, outcome: answer }
pure def canUploadReceipt(s: PhoneJournal): bool = s.phase == Terminal and not(s.uploaded)
pure def uploadReceipt(s: PhoneJournal, acknowledged: bool): PhoneJournal = { ...s, uploaded: acknowledged }
pure val ownerIdValues = Set(1, 2)
pure val identityValues = Set("proposal", "other")
pure val weight_claim = 5
pure val weight_dispatch = 8
pure val weight_settlePhone = 5
pure def alwaysStoredEffectHasAuthority(s: PhoneJournal): bool =
  s.phase == Empty or (s.ownerId > 0 and s.identity != "" and s.authorityKind != NoAuthority)
pure def alwaysApplyingRequiresDurableClaim(s: PhoneJournal): bool = (s.phase == Applying or s.phase == Terminal) implies s.claimed
pure def alwaysEffectReceiptFollowsDispatch(s: PhoneJournal): bool =
  (s.outcome == Sent or s.outcome == HandedOff or s.outcome == OutcomeUnknown or s.outcome == Delivered) implies s.dispatched
pure def alwaysDispatchedOwnsJournal(s: PhoneJournal): bool = s.dispatched implies (s.phase == Applying or s.phase == Terminal)
pure def alwaysUploadedOwnsTerminal(s: PhoneJournal): bool = s.uploaded implies s.phase == Terminal
pure def stepDispatchCannotBeUndone(before: PhoneJournal, after: PhoneJournal): bool = before.dispatched implies after.dispatched
pure def stepTerminalIsNeverReopened(before: PhoneJournal, after: PhoneJournal): bool = before.phase == Terminal implies after.phase == Terminal
pure def sometimesSends(s: PhoneJournal): bool = s.outcome == Sent
pure def sometimesUnknown(s: PhoneJournal): bool = s.outcome == OutcomeUnknown
```
