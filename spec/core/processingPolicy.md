# Runtime-bound processing policy

Only host construction binds the immutable runtime processing policy. Model and action admissions consult the current host decision before payload preparation. Sources include [processing-policy.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/security/processing-policy.ts) and [runtime.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime.ts).

## Story: Bind a host processing policy once

As a host I require scoped admission before model or action payload processing and preserve the policy through runtime wrappers.

### Each runtime has at most one immutable policy binding

Wrappers resolve to the original runtime identity. Plugin metadata and runtime settings supply no policy authority.

Discovered by the proof: if a wrapper and a runtime can share the same
identity, a wrapper lookup can hide a previously bound policy. Each runtime
or wrapper identity is registered once. Every wrapper directly refers to
an existing original runtime. A runtime setting cannot rebind that original.

```quint
type PolicyRuntime = {id: int, policy: int}
type RuntimeWrapper = {id: int, original: int}
type ProcessingKind = ModelProcessing | ActionProcessing
type AdmissionPhase = AdmissionNew | PolicyPending | ProcessingAllowed | ProcessingDenied | PayloadPrepared
type DenialReason = NoDenial | UnknownModality | UndeclaredDestination | PolicyUnavailable | MalformedDecision | HostDenied
type AdmissionScope = {agent: str, room: str, message: str, stage: str}
type ProcessingInput = {kind: ProcessingKind, scope: AdmissionScope, requestedModel: str, resolvedModel: str, modality: str, provider: str, handler: int, attempt: int, actionName: str, egressDeclared: bool, egress: List[str], priorFailure: str}
type PolicyOutput = {available: bool, shapeValid: bool, allow: bool, receipt: str, revision: str, revisionPresent: bool, code: str, failure: str}
type ProcessingAdmission = {id: int, runtime: int, policy: int, request: ProcessingInput, phase: AdmissionPhase, reason: DenialReason, receipt: str, revision: str, revisionPresent: bool, policyCode: str, cause: str, decisionCalls: int}
type ProcessingPolicies = {runtimes: List[PolicyRuntime], wrappers: List[RuntimeWrapper], admissions: List[ProcessingAdmission]}
pure val initial: ProcessingPolicies = {runtimes: List(), wrappers: List(), admissions: List()}
pure val runtimeIdValues = Set(1, 2)
pure val wrapperIdValues = Set(3, 4)
pure val policyIdValues = Set(1, 2)
pure val admissionIdValues = Set(1, 2, 3)
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
pure def alwaysRuntimeIdentitiesAreUnique(s: ProcessingPolicies): bool = s.runtimes.every(r => r.id > 0 and r.policy >= 0 and s.runtimes.select(other => other.id == r.id).length() == 1 and not(s.wrappers.some(w => w.id == r.id)))
pure def alwaysWrapperIdentitiesAreUnique(s: ProcessingPolicies): bool = s.wrappers.every(w => w.id > 0 and s.wrappers.select(other => other.id == w.id).length() == 1 and s.runtimes.some(r => r.id == w.original))
pure def sometimesWrapperPolicyBound(s: ProcessingPolicies): bool = s.wrappers.some(w => boundPolicy(s, w.id) > 0)
```

### A processing request is admitted only by a valid host decision

Unknown modality, undeclared action egress, a throwing policy, malformed output and explicit denial terminate processing before payload preparation. An absent policy preserves ordinary dispatch. The request retains its scope, exact handler identity, and requested and resolved model slots. The attempt index distinguishes the primary attempt from failover. An explicitly empty egress declaration is valid. Each unique admission captures its request once through the policy await.

The approval retains a nonempty policy-owned receipt and revision. The
decoder supplies exact shape validity. A valid denial has a string code
and either a string or null revision, with empty strings accepted. A
policy exception becomes the denial's cause. Other denials retain any
earlier provider failure as their cause. A denied model attempt is terminal.
A denied action cannot invoke the handler or emit its callback. The model
dispatch checks current turn cancellation again after admission. The
handler and slot of the subsequent preparation belong to the same recorded
attempt. The policy receipt is diagnostic evidence for that admission.

```quint
pure val exampleScope: AdmissionScope = {agent: "agent", room: "room", message: "message", stage: "response"}
pure val exampleModel: ProcessingInput = {kind: ModelProcessing, scope: exampleScope, requestedModel: "TEXT_LARGE", resolvedModel: "TEXT_SMALL", modality: "text", provider: "alpha", handler: 1, attempt: 1, actionName: "", egressDeclared: false, egress: List(), priorFailure: ""}
pure val exampleAction: ProcessingInput = {kind: ActionProcessing, scope: exampleScope, requestedModel: "", resolvedModel: "", modality: "", provider: "", handler: 0, attempt: 0, actionName: "WRITE", egressDeclared: true, egress: List(), priorFailure: ""}
pure val inputValues = Set(exampleModel, { ...exampleModel, modality: "" }, { ...exampleModel, attempt: 2, priorFailure: "provider-error" }, exampleAction, { ...exampleAction, egressDeclared: false }, { ...exampleAction, egress: List("workspace") })
pure val allowedOutput: PolicyOutput = {available: true, shapeValid: true, allow: true, receipt: "admitted", revision: "policy-1", revisionPresent: true, code: "", failure: ""}
pure val deniedOutput: PolicyOutput = {available: true, shapeValid: true, allow: false, receipt: "", revision: "policy-1", revisionPresent: true, code: "scope_denied", failure: ""}
pure val outputValues = Set(allowedOutput, { ...allowedOutput, receipt: "" }, { ...allowedOutput, revision: "" }, deniedOutput, { ...deniedOutput, revisionPresent: false, revision: "" }, { ...deniedOutput, shapeValid: false }, { ...deniedOutput, available: false, failure: "policy-error" })
pure def canBeginAdmission(s: ProcessingPolicies, admissionId: int, runtimeId: int, input: ProcessingInput): bool = admissionId > 0 and s.runtimes.some(r => r.id == runtimeIdentity(s, runtimeId)) and not(s.admissions.some(a => a.id == admissionId))
pure def beginAdmission(s: ProcessingPolicies, admissionId: int, runtimeId: int, input: ProcessingInput): ProcessingPolicies = {
  val policy = boundPolicy(s, runtimeId)
  val unknown = input.kind == ModelProcessing and input.modality == ""
  val undeclared = input.kind == ActionProcessing and not(input.egressDeclared)
  val refused = policy != 0 and (unknown or undeclared)
  { ...s, admissions: s.admissions.append({id: admissionId, runtime: runtimeIdentity(s, runtimeId), policy: policy, request: input, phase: if (policy == 0) ProcessingAllowed else if (refused) ProcessingDenied else PolicyPending, reason: if (not(refused)) NoDenial else if (unknown) UnknownModality else UndeclaredDestination, receipt: "", revision: "", revisionPresent: false, policyCode: "", cause: if (refused) input.priorFailure else "", decisionCalls: if (policy != 0 and not(refused)) 1 else 0}) }
}
pure def canDecideAdmission(s: ProcessingPolicies, admissionId: int, output: PolicyOutput): bool = s.admissions.some(a => a.id == admissionId and a.phase == PolicyPending)
pure def admissionOutcome(a: ProcessingAdmission, output: PolicyOutput): ProcessingAdmission = {
  val valid = output.available and output.shapeValid and (not(output.allow) or (output.receipt != "" and output.revisionPresent and output.revision != ""))
  val admitted = valid and output.allow
  val hostDenied = valid and not(output.allow)
  { ...a, phase: if (admitted) ProcessingAllowed else ProcessingDenied, reason: if (not(output.available)) PolicyUnavailable else if (not(valid)) MalformedDecision else if (hostDenied) HostDenied else NoDenial, receipt: if (admitted) output.receipt else "", revision: if (valid and output.revisionPresent) output.revision else "", revisionPresent: valid and output.revisionPresent, policyCode: if (hostDenied) output.code else "", cause: if (admitted) "" else if (not(output.available) and output.failure != "") output.failure else a.request.priorFailure }
}
pure def decideAdmission(s: ProcessingPolicies, admissionId: int, output: PolicyOutput): ProcessingPolicies =
  { ...s, admissions: s.admissions.listMap(a => if (a.id == admissionId and a.phase == PolicyPending) admissionOutcome(a, output) else a) }
pure def canPreparePayload(s: ProcessingPolicies, admissionId: int, aborted: bool): bool = s.admissions.some(a => a.id == admissionId and a.phase == ProcessingAllowed and (a.request.kind == ActionProcessing or not(aborted)))
pure def preparePayload(s: ProcessingPolicies, admissionId: int, aborted: bool): ProcessingPolicies = { ...s, admissions: s.admissions.listMap(a => if (a.id == admissionId and a.phase == ProcessingAllowed and (a.request.kind == ActionProcessing or not(aborted))) { ...a, phase: PayloadPrepared } else a) }
pure def alwaysPolicyAdmissionHasReceipt(s: ProcessingPolicies): bool = s.admissions.every(a => a.policy > 0 and (a.phase == ProcessingAllowed or a.phase == PayloadPrepared) implies a.receipt != "" and a.revisionPresent and a.revision != "" and a.decisionCalls == 1)
pure def alwaysAdmissionIdsAreUnique(s: ProcessingPolicies): bool = s.admissions.every(a => a.id > 0 and a.policy >= 0 and s.admissions.select(other => other.id == a.id).length() == 1)
pure def alwaysPendingDecisionWasRequested(s: ProcessingPolicies): bool = s.admissions.every(a => a.phase == PolicyPending implies a.policy > 0 and a.decisionCalls == 1)
pure def stepDeniedProcessingTerminal(before: ProcessingPolicies, after: ProcessingPolicies): bool = before.admissions.every(a => a.phase == ProcessingDenied implies after.admissions.some(b => b.id == a.id and b.phase == ProcessingDenied))
pure def sometimesHostDenialRetainsCode(s: ProcessingPolicies): bool = s.admissions.some(a => a.reason == HostDenied and a.policyCode == "scope_denied")
pure def sometimesPolicyFailureStopsPayload(s: ProcessingPolicies): bool = s.admissions.some(a => a.phase == ProcessingDenied and a.reason == PolicyUnavailable)
```
