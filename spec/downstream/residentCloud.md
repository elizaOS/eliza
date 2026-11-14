# Resident Cloud inference admission

AlphaPhone uses Eliza's `CloudResidentBindingController`,
`ResidentRebindQueue`, and `ResidentPlanAdmissionRecord` from
`packages/auth/src/auth/cloud-resident-binding.ts`. Its consumer is
`apps/app/src/runtime/connection-ui.tsx`. The Eliza pinned producer also
supplies `packages/cloud/sdk/src/subscription-entitlement.ts`. AlphaPhone's
`PlanAdmissionGrace.qnt`, `CloudPlanRecheck.qnt`, and `ResidentLiveness.qnt`
cover offline admission, deferred recheck, and runtime availability.
Grace's host uses a different enrollment and credential route contract.

## Story: Retain local service and use Cloud only with current admission

### An offline decision uses a recent record for the same credential

A record is versioned and projected by the source decoder. A credential
matches only within its selected environment. When the verified user is
known it must match case insensitively. Canonical lowercase user IDs
represent that comparison here. A future verification time or a reached
plan end cannot supply offline grace. The age limit includes the exact
seven-day boundary. The host supplies absolute clock observations, which
may rewind. Cloud identity rejection, an authenticated plan decision,
and an outage have distinct outcomes. A billing outage can admit with
a recent record when identity was verified. A transport outage keeps an
existing binding only with such a record. Applying `kept` is a no-op.
A binding decision concerns inference, while starting and stopping the
resident is owned by the product runtime.

```quint
type PlanStatus = GoodPlan | PastDuePlan
type AdmissionRecord = { present: bool, environment: str, credential: str, user: str, planStatus: PlanStatus, verifiedAt: int, hasEnd: bool, endsAt: int }
type Lookup = { environment: str, credential: str, userKnown: bool, user: str, now: int }
type CloudObservation = VerifiedPlan | VerifiedWarning | NoPlan | BillingOutage | IdentityOutage | PlanOutage | SignInRefused | PlanUnavailable | AccountChanged
type CloudBinding = CloudAdmitted | KeptBinding | UnboundBinding
type AdmissionDecision = { binding: CloudBinding, hasGrace: bool, warning: bool, forget: bool }
pure val goodPlan: PlanStatus = GoodPlan
pure val pastDuePlan: PlanStatus = PastDuePlan
pure def recentAdmission(row: AdmissionRecord, query: Lookup): bool = row.present and query.credential != "" and row.environment == query.environment and row.credential == query.credential and (not(query.userKnown) or row.user == query.user) and (not(row.hasEnd) or row.endsAt > query.now) and query.now - row.verifiedAt >= 0 and query.now - row.verifiedAt <= 604800000
pure def admissionDecision(row: AdmissionRecord, query: Lookup, observation: CloudObservation): AdmissionDecision = {
  val grace = recentAdmission(row, query)
  val admitted = observation == VerifiedPlan or observation == VerifiedWarning or (observation == BillingOutage and grace)
  val kept = (observation == IdentityOutage or observation == PlanOutage) and grace
  { binding: if (admitted) CloudAdmitted else if (kept) KeptBinding else UnboundBinding,
    hasGrace: kept or (observation == BillingOutage and grace),
    warning: observation == VerifiedWarning or (observation == BillingOutage and grace and row.planStatus == PastDuePlan),
    forget: observation == NoPlan }
}
pure val rowValues = Set(
  { present: false, environment: "prod", credential: "key-a", user: "alice", planStatus: goodPlan, verifiedAt: 10, hasEnd: false, endsAt: 0 },
  { present: true, environment: "prod", credential: "key-a", user: "alice", planStatus: goodPlan, verifiedAt: 10, hasEnd: false, endsAt: 0 },
  { present: true, environment: "prod", credential: "key-a", user: "alice", planStatus: pastDuePlan, verifiedAt: 10, hasEnd: true, endsAt: 20 })
pure val queryValues = Set(
  { environment: "prod", credential: "key-a", userKnown: true, user: "alice", now: 10 },
  { environment: "prod", credential: "key-a", userKnown: true, user: "alice", now: 20 },
  { environment: "prod", credential: "key-b", userKnown: true, user: "alice", now: 10 },
  { environment: "stage", credential: "key-a", userKnown: true, user: "alice", now: 10 },
  { environment: "prod", credential: "key-a", userKnown: true, user: "bob", now: 10 },
  { environment: "prod", credential: "key-a", userKnown: false, user: "", now: 604800010 },
  { environment: "prod", credential: "key-a", userKnown: false, user: "", now: 604800011 })
pure def lawOutageNeedsMatchingFreshRecord(row: AdmissionRecord, query: Lookup, observation: CloudObservation): bool = admissionDecision(row, query, observation).hasGrace implies recentAdmission(row, query)
pure def lawEndedPlanForgetsOfflineAdmission(row: AdmissionRecord, query: Lookup): bool = admissionDecision(row, query, NoPlan).forget and admissionDecision(row, query, NoPlan).binding == UnboundBinding
pure def lawForeignOrExpiredRecordGivesNoOfflineGrace(row: AdmissionRecord, query: Lookup): bool = (row.environment != query.environment or row.credential != query.credential or (query.userKnown and row.user != query.user) or (row.hasEnd and row.endsAt <= query.now) or row.verifiedAt > query.now or query.now - row.verifiedAt > 604800000) implies not(recentAdmission(row, query))
```

### A failed old apply cannot remove a newer binding

A Cloud apply rechecks the saved credential before the bind and after it.
Cancellation or a changed credential transfers responsibility to the
successor. A failed bind can clear only its returned, still-current
binding guard. Failure to confirm that cleanup returns unknown. A
successful native clear confirms the unbound result. The model treats
native bind and fenced clear as separate observations, with fresh binding
guards represented by increasing ordinals. It models one controller apply
at a time and allows a successor native owner to replace the credential
or provider binding while an async step is pending.

```quint
type ApplyPhase = NoApply | AwaitingBind | CheckingBind | AwaitingCleanup
type ApplyReport = NoApplyReport | CloudApplied | UnboundAfterFailure | UnknownBinding | ObsoleteApply | CancelledApply
type Resident = { credential: str, provider: str, guard: int, serial: int, phase: ApplyPhase, requested: str, acquired: int, reply: ApplyReport }
pure val initial: Resident = { credential: "", provider: "", guard: 0, serial: 0, phase: NoApply, requested: "", acquired: 0, reply: NoApplyReport }
pure def replaceCredential(r: Resident, credential: str): Resident = { ...r, credential: credential }
pure def replaceProvider(r: Resident, provider: str): Resident = { ...r, provider: provider, serial: r.serial + 1, guard: r.serial + 1 }
pure def canStartApply(r: Resident): bool = r.phase == NoApply and r.credential != ""
pure def startApply(r: Resident): Resident = { ...r, phase: AwaitingBind, requested: r.credential, acquired: 0, reply: NoApplyReport }
pure def applyReport(reply: ApplyReport, r: Resident): Resident = { ...r, phase: NoApply, requested: "", acquired: 0, reply: reply }
pure def canObserveBind(r: Resident): bool = r.phase == AwaitingBind
pure def observeBind(r: Resident, changedProvider: bool): Resident =
  if (r.credential != r.requested) applyReport(ObsoleteApply, r)
  else if (changedProvider) { ...r, phase: CheckingBind, provider: r.requested, serial: r.serial + 1, guard: r.serial + 1, acquired: r.serial + 1 }
  else applyReport(UnknownBinding, r)
pure def canCheckBound(r: Resident): bool = r.phase == CheckingBind
pure def checkBound(r: Resident, checkSuccessful: bool): Resident =
  if (r.credential != r.requested) applyReport(ObsoleteApply, r)
  else if (checkSuccessful) applyReport(CloudApplied, r)
  else { ...r, phase: AwaitingCleanup }
pure def canFinishCleanup(r: Resident): bool = r.phase == AwaitingCleanup
pure def finishCleanup(r: Resident, clearConfirmed: bool): Resident =
  if (r.credential != r.requested) applyReport(ObsoleteApply, r)
  else if (r.guard != r.acquired or not(clearConfirmed)) applyReport(UnknownBinding, r)
  else { ...applyReport(UnboundAfterFailure, r), provider: "", serial: r.serial + 1, guard: r.serial + 1 }
pure def canCancelApply(r: Resident): bool = r.phase != NoApply
pure def cancelApply(r: Resident): Resident = applyReport(CancelledApply, r)
pure val credentialValues = Set("", "key-a", "key-b")
pure val providerValues = Set("", "key-a", "key-b")
pure def alwaysGuardIsAllocated(r: Resident): bool = r.serial >= 0 and r.guard == r.serial and r.acquired >= 0 and r.acquired <= r.serial
pure def alwaysAttemptPhaseOwnsCredential(r: Resident): bool = (r.phase == NoApply) == (r.requested == "") and (r.phase == CheckingBind or r.phase == AwaitingCleanup) == (r.acquired > 0)
pure def stepCleanupCannotClearSuccessor(before: Resident, via: str, after: Resident): bool = via != "finishCleanup" or (before.credential == before.requested and before.guard == before.acquired) or (after.provider == before.provider and after.guard == before.guard)
pure def stepCancellationRetainsBinding(before: Resident, via: str, after: Resident): bool = via != "cancelApply" or (after.provider == before.provider and after.guard == before.guard)
pure def sometimesCancelledApply(r: Resident): bool = r.reply == CancelledApply
pure def sometimesCleanedFailedBind(r: Resident): bool = r.reply == UnboundAfterFailure
pure def sometimesApplyIsObsolete(r: Resident): bool = r.reply == ObsoleteApply
```
