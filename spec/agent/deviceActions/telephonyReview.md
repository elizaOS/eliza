# Device effect authority and SMS bounds

Who may authorize a device effect, and the bounds of a text message, for
[device action custody](./execution.md), which journals and runs the effect.
Generic approval and receipt identity are the
[core authorization](../../core/capabilityAuthority.md) and
[receipt binding](../../core/receiptBindings.md) contracts.

## Story: Review a phone effect on the verified device and avoid repeating it

> As a user, a message, call or contact change happens on my verified device
> after review, or directly only when I allow it, and is never repeated.

### A device effect needs review unless the current request may act directly

Authority needs a live, nonsensitive, unexpired and exact context. With it,
the user's review is approval; without review, the current request acts
directly only when the user's preference allows direct action and the
operation is eligible. Anything else has no authority.

```quint
type DeviceAuthority = NoAuthority | Approval | DirectRequest
type AuthorityCheck = { live: bool, nonsensitive: bool, unexpired: bool, exact: bool, forceReview: bool, requestEligible: bool, reviewed: bool }
pure val evidenceValues = Set(
  { live: true, nonsensitive: true, unexpired: true, exact: true, forceReview: true, requestEligible: true, reviewed: true },
  { live: true, nonsensitive: true, unexpired: true, exact: true, forceReview: false, requestEligible: true, reviewed: false },
  { live: true, nonsensitive: true, unexpired: true, exact: true, forceReview: true, requestEligible: true, reviewed: false },
  { live: false, nonsensitive: true, unexpired: true, exact: true, forceReview: false, requestEligible: true, reviewed: true }
)
pure def authority(evidence: AuthorityCheck): DeviceAuthority =
  if (not(evidence.live and evidence.nonsensitive and evidence.unexpired and evidence.exact)) NoAuthority
  else if (evidence.reviewed) Approval else if (not(evidence.forceReview) and evidence.requestEligible) DirectRequest else NoAuthority
pure def lawForcedReviewNeedsApproval(evidence: AuthorityCheck): bool =
  (evidence.forceReview and not(evidence.reviewed)) implies authority(evidence) == NoAuthority
pure def lawStaleContextHasNoAuthority(evidence: AuthorityCheck): bool =
  not(evidence.live) implies authority(evidence) == NoAuthority
```

### A direct SMS is bounded and uses an active subscription

Recipients are normalized and deduplicated after their raw count is checked;
malformed numbers are refused and the authored body is kept as written. A
handoff to the messaging app accepts up to ten recipients and 5,000 UTF-16
units and cannot choose a SIM. A direct send accepts up to five recipients
and 1,600 UTF-16 units, refuses NUL and lone surrogates, and uses the one
available SIM or an explicit, still-active subscription; several active SIMs
need the owner's choice. A handoff is its own terminal outcome: only a sent
message can later report delivery.

```quint
type SmsMode = Handoff | Direct
type SmsEvidence = { installed: bool, roleAllows: bool, recipients: int, recipientsValid: bool, bodyUnits: int, authored: bool, wellFormed: bool, simKnown: bool, activeSims: int, simChosen: bool, choiceIsActive: bool }
pure val smsValues = Set(
  { installed: true, roleAllows: true, recipients: 1, recipientsValid: true, bodyUnits: 120, authored: true, wellFormed: true, simKnown: true, activeSims: 1, simChosen: false, choiceIsActive: false },
  { installed: true, roleAllows: true, recipients: 1, recipientsValid: true, bodyUnits: 120, authored: true, wellFormed: true, simKnown: true, activeSims: 2, simChosen: false, choiceIsActive: false },
  { installed: true, roleAllows: true, recipients: 1, recipientsValid: true, bodyUnits: 120, authored: true, wellFormed: true, simKnown: true, activeSims: 2, simChosen: true, choiceIsActive: true },
  { installed: true, roleAllows: true, recipients: 7, recipientsValid: true, bodyUnits: 120, authored: true, wellFormed: true, simKnown: true, activeSims: 1, simChosen: false, choiceIsActive: false },
  { installed: false, roleAllows: true, recipients: 1, recipientsValid: true, bodyUnits: 120, authored: true, wellFormed: true, simKnown: true, activeSims: 1, simChosen: false, choiceIsActive: false }
)
pure def validSms(mode: SmsMode, sms: SmsEvidence): bool =
  sms.installed and sms.roleAllows and sms.recipients > 0 and sms.recipientsValid and sms.authored and sms.bodyUnits > 0 and
  (if (mode == Handoff) sms.recipients <= 10 and sms.bodyUnits <= 5000 and not(sms.simChosen)
   else sms.recipients <= 5 and sms.bodyUnits <= 1600 and sms.wellFormed and sms.simKnown and
     (if (sms.simChosen) sms.activeSims >= 1 and sms.choiceIsActive else sms.activeSims == 1))
type SmsOutcome = SmsHandedOff | SmsSent | SmsDelivered
pure def smsProgress(before: SmsOutcome, after: SmsOutcome): bool = before == SmsSent and after == SmsDelivered
pure def lawUnverifiedImageCannotDispatch(mode: SmsMode, sms: SmsEvidence): bool = not(sms.installed) implies not(validSms(mode, sms))
pure def lawMultipleSimsNeedAnExplicitChoice(sms: SmsEvidence): bool = sms.activeSims > 1 and not(sms.simChosen) implies not(validSms(Direct, sms))
pure def lawDirectSendHasFewerRecipients(sms: SmsEvidence): bool = sms.recipients > 5 implies not(validSms(Direct, sms))
pure def lawHandoffIsTerminal(laterOutcome: SmsOutcome): bool = not(smsProgress(SmsHandedOff, laterOutcome))
```
