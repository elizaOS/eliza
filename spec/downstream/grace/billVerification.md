# Verification field assistance

Sources at Grace's pin include `bill-code-coordinator.mjs` and
`plugins/plugin-google-workspace/src/task-code-resolver.ts`. Grace wires
this through the configured helper and the checked challenge provider.
The resolver owns a short-lived value. The task actuator owns the
operation and target fence. The contract below models their shared
authority and result without carrying any verification value.

## Story: Help with the current verification field while the person verifies

### One current challenge authorizes one fill, with no Verify action

The coordinator refuses duplicate lookups per task while one is pending.
It checks task and account, current observation and challenge identity
before dispatch. Her own typing wins. An absent, ambiguous, expired,
incomplete or invalid result leaves verification with the person.
If a challenge already has an operation in this task epoch, the coordinator
offers manual verification. A resolved fill consumes a referenced value
only for the current owner, challenge and exact target. A filled field is
not proof of successful verification. The person presses Verify.

```quint
type ChallengeLookup = { taskActive: bool, currentAccount: bool, challengeCurrent: bool, untouchedField: bool, uniqueTarget: bool, handledBefore: bool }
type ChallengeGrant = { authorized: bool, ownerCurrent: bool, taskUnchanged: bool, observationCurrent: bool, signalLive: bool, withinExpiry: bool }
type ChallengePhase = AwaitChallenge | LookupInFlight | FillReady | ValueConsumed | FillReadback | ManualVerification
type Verification = { phase: ChallengePhase, hasHandle: bool, confirmedFilled: bool }
pure val awaitChallenge: ChallengePhase = AwaitChallenge
pure val lookingUp: ChallengePhase = LookupInFlight
pure val fillReady: ChallengePhase = FillReady
pure val valueConsumed: ChallengePhase = ValueConsumed
pure val readingFill: ChallengePhase = FillReadback
pure val manualVerification: ChallengePhase = ManualVerification

pure val initial: Verification = { phase: awaitChallenge, hasHandle: false, confirmedFilled: false }
pure def lookupAdmitted(facts: ChallengeLookup): bool =
  facts.taskActive and facts.currentAccount and facts.challengeCurrent and
  facts.untouchedField and facts.uniqueTarget and not(facts.handledBefore)
pure def currentGrant(grant: ChallengeGrant): bool =
  grant.authorized and grant.ownerCurrent and grant.taskUnchanged and
  grant.observationCurrent and grant.signalLive and grant.withinExpiry
pure def canBeginLookup(v: Verification): bool = v.phase == awaitChallenge
pure def beginLookup(v: Verification, facts: ChallengeLookup): Verification =
  { ...v, phase: if (lookupAdmitted(facts)) lookingUp else manualVerification }
pure def canReceiveLookup(v: Verification): bool = v.phase == lookingUp
pure def receiveLookup(v: Verification, grant: ChallengeGrant, ready: bool): Verification =
  if (ready and currentGrant(grant)) { ...v, phase: fillReady, hasHandle: true }
  else { ...v, phase: manualVerification, hasHandle: false }
pure def canConsumeHandle(v: Verification, grant: ChallengeGrant): bool =
  v.phase == fillReady and v.hasHandle and currentGrant(grant)
pure def consumeHandle(v: Verification, grant: ChallengeGrant): Verification =
  { ...v, phase: valueConsumed, hasHandle: false }
pure def canDispatchFill(v: Verification, grant: ChallengeGrant): bool =
  v.phase == valueConsumed and currentGrant(grant)
pure def dispatchFill(v: Verification, grant: ChallengeGrant): Verification =
  { ...v, phase: readingFill }
pure def canConcludeFill(v: Verification): bool = v.phase == readingFill
pure def concludeFill(v: Verification, successObserved: bool): Verification =
  { ...v, phase: manualVerification, confirmedFilled: successObserved }
pure def abortVerification(v: Verification): Verification =
  { ...v, phase: manualVerification, hasHandle: false }
pure def alwaysOnlyReadyHasHandle(v: Verification): bool = v.hasHandle iff v.phase == fillReady
pure def alwaysSuccessfulReadbackNeedsManualVerify(v: Verification): bool =
  v.confirmedFilled implies v.phase == manualVerification
pure def lawAlreadyHandledCannotLookUp(facts: ChallengeLookup): bool =
  facts.handledBefore implies not(lookupAdmitted(facts))
pure def lawUserInputCannotBeOverwritten(facts: ChallengeLookup): bool =
  not(facts.untouchedField) implies not(lookupAdmitted(facts))
pure def sometimesFillReadBack(v: Verification): bool = v.confirmedFilled
pure def sometimesVerificationGoesManual(v: Verification): bool = v.phase == manualVerification and not(v.confirmedFilled)
pure val validLookup: ChallengeLookup = { taskActive: true, currentAccount: true, challengeCurrent: true, untouchedField: true, uniqueTarget: true, handledBefore: false }
pure val factsValues = Set(validLookup, { ...validLookup, untouchedField: false }, { ...validLookup, handledBefore: true })
pure val validGrant: ChallengeGrant = { authorized: true, ownerCurrent: true, taskUnchanged: true, observationCurrent: true, signalLive: true, withinExpiry: true }
pure val grantValues = Set(validGrant, { ...validGrant, ownerCurrent: false }, { ...validGrant, withinExpiry: false })
pure val weight_beginLookup = 6
pure val weight_receiveLookup = 6
pure val weight_consumeHandle = 6
pure val weight_dispatchFill = 6
pure val weight_concludeFill = 6
```
