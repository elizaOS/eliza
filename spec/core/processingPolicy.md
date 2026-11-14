# Runtime-bound processing policy

Only host construction binds the immutable runtime processing policy. Model and action admissions consult the current host decision before payload preparation. Sources include [processing-policy.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/security/processing-policy.ts) and [runtime.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime.ts).

## Story: Bind a host processing policy once

As a host I require scoped admission before model or action payload processing and preserve the policy through runtime wrappers.

### Each runtime has at most one immutable policy binding

Wrappers resolve to the original runtime identity. Plugin metadata and runtime settings supply no policy authority.

```quint
type PolicyRuntime = {id: int, policy: int}
type RuntimeWrapper = {id: int, original: int}
type ProcessingKind = ModelProcessing | ActionProcessing
type AdmissionPhase = AdmissionNew | PolicyPending | ProcessingAllowed | ProcessingDenied | PayloadPrepared
type DenialReason = NoDenial | UnknownModality | UndeclaredDestination | PolicyUnavailable | MalformedDecision | HostDenied
type ProcessingAdmission = {id: int, runtime: int, policy: int, kind: ProcessingKind, phase: AdmissionPhase, reason: DenialReason, receipt: str, revision: str, decisionCalls: int}
type ProcessingPolicies = {runtimes: List[PolicyRuntime], wrappers: List[RuntimeWrapper], admissions: List[ProcessingAdmission]}
pure val initial: ProcessingPolicies = {runtimes: List(), wrappers: List(), admissions: List()}
pure val runtimeIdValues = Set(1, 2)
pure val wrapperIdValues = Set(3, 4)
pure val policyIdValues = Set(1, 2)
pure val admissionIdValues = Set(1, 2, 3)
pure val receiptValues = Set("", "admitted")
pure val revisionValues = Set("", "policy-1")
pure def runtimeIdentity(s: ProcessingPolicies, runtimeId: int): int = s.wrappers.select(w => w.id == runtimeId).nthOr(0, {id: runtimeId, original: runtimeId}).original
pure def boundPolicy(s: ProcessingPolicies, runtimeId: int): int = s.runtimes.select(r => r.id == runtimeIdentity(s, runtimeId)).nthOr(0, {id: runtimeId, policy: 0}).policy
pure def canRegisterPolicyRuntime(s: ProcessingPolicies, runtimeId: int): bool = runtimeId > 0 and not(s.runtimes.some(r => r.id == runtimeId)) and not(s.wrappers.some(w => w.id == runtimeId))
pure def registerPolicyRuntime(s: ProcessingPolicies, runtimeId: int): ProcessingPolicies = { ...s, runtimes: s.runtimes.append({id: runtimeId, policy: 0}) }
pure def canBindPolicy(s: ProcessingPolicies, runtimeId: int, policyId: int): bool = policyId > 0 and s.runtimes.some(r => r.id == runtimeId and r.policy == 0)
pure def bindPolicy(s: ProcessingPolicies, runtimeId: int, policyId: int): ProcessingPolicies = { ...s, runtimes: s.runtimes.listMap(r => if (r.id == runtimeId) { ...r, policy: policyId } else r) }
pure def canRegisterRuntimeWrapper(s: ProcessingPolicies, wrapperId: int, runtimeId: int): bool = wrapperId > 0 and s.runtimes.some(r => r.id == runtimeId) and not(s.runtimes.some(r => r.id == wrapperId)) and not(s.wrappers.some(w => w.id == wrapperId))
pure def registerRuntimeWrapper(s: ProcessingPolicies, wrapperId: int, runtimeId: int): ProcessingPolicies = { ...s, wrappers: s.wrappers.append({id: wrapperId, original: runtimeId}) }
pure def stepBoundPolicyCannotChange(before: ProcessingPolicies, after: ProcessingPolicies): bool = before.runtimes.every(r => r.policy != 0 implies boundPolicy(after, r.id) == r.policy)
pure def alwaysWrapperKeepsPolicy(s: ProcessingPolicies): bool = s.wrappers.every(w => boundPolicy(s, w.id) == boundPolicy(s, w.original))
pure def sometimesWrapperPolicyBound(s: ProcessingPolicies): bool = s.wrappers.some(w => boundPolicy(s, w.id) > 0)
```

### A processing request is admitted only by a valid host decision

Unknown modality, undeclared action egress, a throwing policy, malformed output and explicit denial terminate processing before payload preparation. An absent policy preserves ordinary dispatch.

```quint
pure def canBeginAdmission(s: ProcessingPolicies, admissionId: int, runtimeId: int, kind: ProcessingKind, modalityKnown: bool, destinationDeclared: bool): bool = admissionId > 0 and s.runtimes.some(r => r.id == runtimeIdentity(s, runtimeId)) and not(s.admissions.some(a => a.id == admissionId))
pure def beginAdmission(s: ProcessingPolicies, admissionId: int, runtimeId: int, kind: ProcessingKind, modalityKnown: bool, destinationDeclared: bool): ProcessingPolicies = {
  val policy = boundPolicy(s, runtimeId)
  val unknown = kind == ModelProcessing and not(modalityKnown)
  val undeclared = kind == ActionProcessing and not(destinationDeclared)
  { ...s, admissions: s.admissions.append({id: admissionId, runtime: runtimeIdentity(s, runtimeId), policy: policy, kind: kind, phase: if (policy == 0) ProcessingAllowed else if (unknown or undeclared) ProcessingDenied else PolicyPending, reason: if (policy == 0) NoDenial else if (unknown) UnknownModality else if (undeclared) UndeclaredDestination else NoDenial, receipt: "", revision: "", decisionCalls: if (policy != 0 and not(unknown or undeclared)) 1 else 0}) }
}
pure def canDecideAdmission(s: ProcessingPolicies, admissionId: int, available: bool, valid: bool, allow: bool, receipt: str, revision: str): bool = s.admissions.some(a => a.id == admissionId and a.phase == PolicyPending)
pure def decideAdmission(s: ProcessingPolicies, admissionId: int, available: bool, valid: bool, allow: bool, receipt: str, revision: str): ProcessingPolicies = {
  val admitted = available and valid and allow and receipt != "" and revision != ""
  { ...s, admissions: s.admissions.listMap(a => if (a.id != admissionId) a else { ...a, phase: if (admitted) ProcessingAllowed else ProcessingDenied, reason: if (not(available)) PolicyUnavailable else if (not(valid) or (allow and (receipt == "" or revision == ""))) MalformedDecision else if (not(allow)) HostDenied else NoDenial, receipt: if (admitted) receipt else "", revision: if (admitted) revision else "" }) }
}
pure def canPreparePayload(s: ProcessingPolicies, admissionId: int): bool = s.admissions.some(a => a.id == admissionId and a.phase == ProcessingAllowed)
pure def preparePayload(s: ProcessingPolicies, admissionId: int): ProcessingPolicies = { ...s, admissions: s.admissions.listMap(a => if (a.id == admissionId) { ...a, phase: PayloadPrepared } else a) }
pure def alwaysPolicyAdmissionHasReceipt(s: ProcessingPolicies): bool = s.admissions.every(a => a.policy > 0 and (a.phase == ProcessingAllowed or a.phase == PayloadPrepared) implies a.receipt != "" and a.revision != "" and a.decisionCalls == 1)
pure def stepDeniedProcessingTerminal(before: ProcessingPolicies, after: ProcessingPolicies): bool = before.admissions.every(a => a.phase == ProcessingDenied implies after.admissions.some(b => b.id == a.id and b.phase == ProcessingDenied))
pure def sometimesPolicyFailureStopsPayload(s: ProcessingPolicies): bool = s.admissions.some(a => a.phase == ProcessingDenied and a.reason == PolicyUnavailable)
```
