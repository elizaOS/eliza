lemma ProcessingRuntimeFacts(s: ProcessingPolicies)
  ensures alwaysRuntimeIdentitiesAreUnique(s) == (forall r :: r in s.runtimes ==>
    (r.id > 0 && r.policy >= 0 && |ProofLib.Filter((other: PolicyRuntime) => other.id == r.id, s.runtimes)| == 1 &&
    !(exists w :: w in s.wrappers && w.id == r.id)))
  ensures alwaysWrapperIdentitiesAreUnique(s) == (forall w :: w in s.wrappers ==>
    (w.id > 0 && |ProofLib.Filter((other: RuntimeWrapper) => other.id == w.id, s.wrappers)| == 1 &&
    (exists r :: r in s.runtimes && r.id == w.original)))
{}

lemma ProcessingAdmissionFacts(s: ProcessingPolicies)
  ensures alwaysAdmissionIdsAreUnique(s) == (forall row :: row in s.admissions ==>
    (row.id > 0 && row.policy >= 0 && |ProofLib.Filter((other: ProcessingAdmission) => other.id == row.id, s.admissions)| == 1))
{}

lemma ProcessingPolicyRuntimeFresh(items: seq<PolicyRuntime>, added: PolicyRuntime)
  requires forall row :: row in items ==> |ProofLib.Filter((other: PolicyRuntime) => other.id == row.id, items)| == 1
  requires forall row :: row in items ==> row.id != added.id
  ensures forall row :: row in items + [added] ==> |ProofLib.Filter((other: PolicyRuntime) => other.id == row.id, items + [added])| == 1
{
  forall row | row in items + [added]
    ensures |ProofLib.Filter((other: PolicyRuntime) => other.id == row.id, items + [added])| == 1
  {
    var sameKey := (other: PolicyRuntime) => other.id == row.id;
    ProofLib.FilterAppend(sameKey, items, added);
    if row == added {
      ProofLib.FilterNone(sameKey, items);
    } else {
      assert row in items;
    }
  }
}

lemma ProcessingPolicyRuntimeMapped(before: seq<PolicyRuntime>, after: seq<PolicyRuntime>)
  requires |before| == |after|
  requires forall i :: 0 <= i < |before| ==> before[i].id == after[i].id
  requires forall row :: row in before ==> |ProofLib.Filter((other: PolicyRuntime) => other.id == row.id, before)| == 1
  ensures forall row :: row in after ==> |ProofLib.Filter((other: PolicyRuntime) => other.id == row.id, after)| == 1
{
  forall row | row in after
    ensures |ProofLib.Filter((other: PolicyRuntime) => other.id == row.id, after)| == 1
  {
    var i :| 0 <= i < |after| && after[i] == row;
    assert before[i] in before;
    var sameId := (other: PolicyRuntime) => other.id == row.id;
    ProofLib.FilterLengthPointwise(sameId, sameId, before, after);
  }
}

lemma ProcessingRuntimeWrapperFresh(items: seq<RuntimeWrapper>, added: RuntimeWrapper)
  requires forall row :: row in items ==> |ProofLib.Filter((other: RuntimeWrapper) => other.id == row.id, items)| == 1
  requires forall row :: row in items ==> row.id != added.id
  ensures forall row :: row in items + [added] ==> |ProofLib.Filter((other: RuntimeWrapper) => other.id == row.id, items + [added])| == 1
{
  forall row | row in items + [added]
    ensures |ProofLib.Filter((other: RuntimeWrapper) => other.id == row.id, items + [added])| == 1
  {
    var sameKey := (other: RuntimeWrapper) => other.id == row.id;
    ProofLib.FilterAppend(sameKey, items, added);
    if row == added {
      ProofLib.FilterNone(sameKey, items);
    } else {
      assert row in items;
    }
  }
}

lemma ProcessingAdmissionSequenceFresh(items: seq<ProcessingAdmission>, added: ProcessingAdmission)
  requires forall row :: row in items ==> |ProofLib.Filter((other: ProcessingAdmission) => other.id == row.id, items)| == 1
  requires forall row :: row in items ==> row.id != added.id
  ensures forall row :: row in items + [added] ==> |ProofLib.Filter((other: ProcessingAdmission) => other.id == row.id, items + [added])| == 1
{
  forall row | row in items + [added]
    ensures |ProofLib.Filter((other: ProcessingAdmission) => other.id == row.id, items + [added])| == 1
  {
    var sameKey := (other: ProcessingAdmission) => other.id == row.id;
    ProofLib.FilterAppend(sameKey, items, added);
    if row == added {
      ProofLib.FilterNone(sameKey, items);
    } else {
      assert row in items;
    }
  }
}

lemma ProcessingAdmissionSequenceMapped(before: seq<ProcessingAdmission>, after: seq<ProcessingAdmission>)
  requires |before| == |after|
  requires forall i :: 0 <= i < |before| ==> before[i].id == after[i].id
  requires forall row :: row in before ==> |ProofLib.Filter((other: ProcessingAdmission) => other.id == row.id, before)| == 1
  ensures forall row :: row in after ==> |ProofLib.Filter((other: ProcessingAdmission) => other.id == row.id, after)| == 1
{
  forall row | row in after
    ensures |ProofLib.Filter((other: ProcessingAdmission) => other.id == row.id, after)| == 1
  {
    var i :| 0 <= i < |after| && after[i] == row;
    assert before[i] in before;
    var sameId := (other: ProcessingAdmission) => other.id == row.id;
    ProofLib.FilterLengthPointwise(sameId, sameId, before, after);
  }
}

lemma ProcessingRuntimeLookup(s: ProcessingPolicies, row: PolicyRuntime)
  requires alwaysRuntimeIdentitiesAreUnique(s) && row in s.runtimes
  ensures runtimeIdentity(s, row.id) == row.id && boundPolicy(s, row.id) == row.policy
{
  ProcessingRuntimeFacts(s);
  var isWrapper := (w: RuntimeWrapper) => w.id == row.id;
  ProofLib.FilterNone(isWrapper, s.wrappers);
  assert runtimeIdentity(s, row.id) == row.id;
  var isRuntime := (r: PolicyRuntime) => r.id == row.id;
  var matches := ProofLib.Filter(isRuntime, s.runtimes);
  assert |matches| == 1;
  ProofLib.FilterMember(isRuntime, s.runtimes, row);
  assert matches[0] == row;
}

lemma ProcessingPolicyAlwaysNonnegative(s: ProcessingPolicies, id: int)
  requires alwaysRuntimeIdentitiesAreUnique(s)
  ensures boundPolicy(s, id) >= 0
{
  var isRuntime := (row: PolicyRuntime) => row.id == runtimeIdentity(s, id);
  var matches := ProofLib.Filter(isRuntime, s.runtimes);
  if |matches| > 0 {
    assert matches[0] in matches;
    ProofLib.FilterMember(isRuntime, s.runtimes, matches[0]);
    assert boundPolicy(s, id) == matches[0].policy;
  }
}

lemma ProcessingWrappersPreservePolicy(s: ProcessingPolicies)
  requires alwaysRuntimeIdentitiesAreUnique(s) && alwaysWrapperIdentitiesAreUnique(s)
  ensures alwaysWrapperKeepsPolicy(s)
{
  ProcessingRuntimeFacts(s);
  forall w | w in s.wrappers
    ensures boundPolicy(s, w.id) == boundPolicy(s, w.original)
  {
    var row :| row in s.runtimes && row.id == w.original;
    ProcessingRuntimeLookup(s, row);
    var key := (other: RuntimeWrapper) => other.id == w.id;
    var found := ProofLib.Filter(key, s.wrappers);
    assert |found| == 1;
    ProofLib.FilterMember(key, s.wrappers, w);
    assert found[0] == w;
    assert runtimeIdentity(s, w.id) == w.original;
  }
}

lemma ProcessingBoundPoliciesRetained(s: ProcessingPolicies, after: ProcessingPolicies)
  requires alwaysRuntimeIdentitiesAreUnique(after)
  requires forall row :: row in s.runtimes && row.policy != 0 ==> row in after.runtimes
  ensures stepBoundPolicyCannotChange(s, after)
{
  forall row | row in s.runtimes && row.policy != 0 ensures boundPolicy(after, row.id) == row.policy {
    ProcessingRuntimeLookup(after, row);
  }
}

lemma ProcessingAdmissionMapped(s: ProcessingPolicies, after: ProcessingPolicies)
  requires alwaysAdmissionIdsAreUnique(s)
  requires |after.admissions| == |s.admissions|
  requires forall i :: 0 <= i < |s.admissions| ==>
    (after.admissions[i].id == s.admissions[i].id && after.admissions[i].policy == s.admissions[i].policy &&
    (s.admissions[i].phase.ProcessingDenied? ==> after.admissions[i].phase.ProcessingDenied?))
  ensures alwaysAdmissionIdsAreUnique(after) && stepDeniedProcessingTerminal(s, after)
{
  ProcessingAdmissionFacts(s);
  ProcessingAdmissionFacts(after);
  ProcessingAdmissionSequenceMapped(s.admissions, after.admissions);
  forall row | row in after.admissions ensures row.id > 0 && row.policy >= 0 {
    var i :| 0 <= i < |after.admissions| && after.admissions[i] == row;
    assert s.admissions[i] in s.admissions;
  }
  forall row | row in s.admissions && row.phase.ProcessingDenied?
    ensures exists retained :: retained in after.admissions && retained.id == row.id && retained.phase.ProcessingDenied?
  {
    var i :| 0 <= i < |s.admissions| && s.admissions[i] == row;
    assert after.admissions[i] in after.admissions;
  }
}

lemma registerPolicyRuntime_ensures(s: ProcessingPolicies, by_: PolicyCaller, runtimeId: int)
  ensures (inv(s) ==> canRegisterPolicyRuntime(s, by_, runtimeId) ==> alwaysRuntimeIdentitiesAreUnique(registerPolicyRuntime(s, by_, runtimeId)))
  ensures (inv(s) ==> canRegisterPolicyRuntime(s, by_, runtimeId) ==> alwaysWrapperIdentitiesAreUnique(registerPolicyRuntime(s, by_, runtimeId)))
  ensures (inv(s) ==> canRegisterPolicyRuntime(s, by_, runtimeId) ==> alwaysWrapperKeepsPolicy(registerPolicyRuntime(s, by_, runtimeId)))
  ensures (inv(s) ==> canRegisterPolicyRuntime(s, by_, runtimeId) ==> alwaysPolicyAdmissionHasReceipt(registerPolicyRuntime(s, by_, runtimeId)))
  ensures (inv(s) ==> canRegisterPolicyRuntime(s, by_, runtimeId) ==> alwaysAdmissionIdsAreUnique(registerPolicyRuntime(s, by_, runtimeId)))
  ensures (inv(s) ==> canRegisterPolicyRuntime(s, by_, runtimeId) ==> alwaysPendingDecisionWasRequested(registerPolicyRuntime(s, by_, runtimeId)))
  ensures (inv(s) ==> canRegisterPolicyRuntime(s, by_, runtimeId) ==> stepBoundPolicyCannotChange(s, registerPolicyRuntime(s, by_, runtimeId)))
  ensures (inv(s) ==> canRegisterPolicyRuntime(s, by_, runtimeId) ==> stepDeniedProcessingTerminal(s, registerPolicyRuntime(s, by_, runtimeId)))
{
  if inv(s) && canRegisterPolicyRuntime(s, by_, runtimeId) {
    var after := registerPolicyRuntime(s, by_, runtimeId);
    var added := PolicyRuntime(runtimeId, 0);
    ProcessingRuntimeFacts(s);
    ProcessingRuntimeFacts(after);
    ProcessingPolicyRuntimeFresh(s.runtimes, added);
    assert alwaysRuntimeIdentitiesAreUnique(after);
    assert alwaysWrapperIdentitiesAreUnique(after);
    ProcessingWrappersPreservePolicy(after);
    ProcessingBoundPoliciesRetained(s, after);
  }
}

lemma registerRuntimeWrapper_ensures(s: ProcessingPolicies, by_: PolicyCaller, wrapperId: int, runtimeId: int)
  ensures (inv(s) ==> canRegisterRuntimeWrapper(s, by_, wrapperId, runtimeId) ==> alwaysRuntimeIdentitiesAreUnique(registerRuntimeWrapper(s, by_, wrapperId, runtimeId)))
  ensures (inv(s) ==> canRegisterRuntimeWrapper(s, by_, wrapperId, runtimeId) ==> alwaysWrapperIdentitiesAreUnique(registerRuntimeWrapper(s, by_, wrapperId, runtimeId)))
  ensures (inv(s) ==> canRegisterRuntimeWrapper(s, by_, wrapperId, runtimeId) ==> alwaysWrapperKeepsPolicy(registerRuntimeWrapper(s, by_, wrapperId, runtimeId)))
  ensures (inv(s) ==> canRegisterRuntimeWrapper(s, by_, wrapperId, runtimeId) ==> alwaysPolicyAdmissionHasReceipt(registerRuntimeWrapper(s, by_, wrapperId, runtimeId)))
  ensures (inv(s) ==> canRegisterRuntimeWrapper(s, by_, wrapperId, runtimeId) ==> alwaysAdmissionIdsAreUnique(registerRuntimeWrapper(s, by_, wrapperId, runtimeId)))
  ensures (inv(s) ==> canRegisterRuntimeWrapper(s, by_, wrapperId, runtimeId) ==> alwaysPendingDecisionWasRequested(registerRuntimeWrapper(s, by_, wrapperId, runtimeId)))
  ensures (inv(s) ==> canRegisterRuntimeWrapper(s, by_, wrapperId, runtimeId) ==> stepBoundPolicyCannotChange(s, registerRuntimeWrapper(s, by_, wrapperId, runtimeId)))
  ensures (inv(s) ==> canRegisterRuntimeWrapper(s, by_, wrapperId, runtimeId) ==> stepDeniedProcessingTerminal(s, registerRuntimeWrapper(s, by_, wrapperId, runtimeId)))
{
  if inv(s) && canRegisterRuntimeWrapper(s, by_, wrapperId, runtimeId) {
    var after := registerRuntimeWrapper(s, by_, wrapperId, runtimeId);
    var added := RuntimeWrapper(wrapperId, runtimeId);
    ProcessingRuntimeFacts(s);
    ProcessingRuntimeFacts(after);
    ProcessingRuntimeWrapperFresh(s.wrappers, added);
    assert alwaysRuntimeIdentitiesAreUnique(after);
    assert alwaysWrapperIdentitiesAreUnique(after);
    ProcessingWrappersPreservePolicy(after);
    ProcessingBoundPoliciesRetained(s, after);
  }
}

lemma bindPolicy_ensures(s: ProcessingPolicies, by_: PolicyCaller, runtimeId: int, policyId: int)
  ensures (inv(s) ==> canBindPolicy(s, by_, runtimeId, policyId) ==> alwaysRuntimeIdentitiesAreUnique(bindPolicy(s, by_, runtimeId, policyId)))
  ensures (inv(s) ==> canBindPolicy(s, by_, runtimeId, policyId) ==> alwaysWrapperIdentitiesAreUnique(bindPolicy(s, by_, runtimeId, policyId)))
  ensures (inv(s) ==> canBindPolicy(s, by_, runtimeId, policyId) ==> alwaysWrapperKeepsPolicy(bindPolicy(s, by_, runtimeId, policyId)))
  ensures (inv(s) ==> canBindPolicy(s, by_, runtimeId, policyId) ==> alwaysPolicyAdmissionHasReceipt(bindPolicy(s, by_, runtimeId, policyId)))
  ensures (inv(s) ==> canBindPolicy(s, by_, runtimeId, policyId) ==> alwaysAdmissionIdsAreUnique(bindPolicy(s, by_, runtimeId, policyId)))
  ensures (inv(s) ==> canBindPolicy(s, by_, runtimeId, policyId) ==> alwaysPendingDecisionWasRequested(bindPolicy(s, by_, runtimeId, policyId)))
  ensures (inv(s) ==> canBindPolicy(s, by_, runtimeId, policyId) ==> stepBoundPolicyCannotChange(s, bindPolicy(s, by_, runtimeId, policyId)))
  ensures (inv(s) ==> canBindPolicy(s, by_, runtimeId, policyId) ==> stepDeniedProcessingTerminal(s, bindPolicy(s, by_, runtimeId, policyId)))
{
  if inv(s) && canBindPolicy(s, by_, runtimeId, policyId) {
    var after := bindPolicy(s, by_, runtimeId, policyId);
    var unbound :| unbound in s.runtimes && unbound.id == runtimeId && unbound.policy == 0;
    ProcessingRuntimeFacts(s);
    ProcessingRuntimeFacts(after);
    ProcessingRuntimeLookup(s, unbound);
    forall i | 0 <= i < |s.runtimes|
      ensures after.runtimes[i].id == s.runtimes[i].id
      ensures after.runtimes[i].policy >= 0
    {
      assert s.runtimes[i] in s.runtimes;
    }
    ProcessingPolicyRuntimeMapped(s.runtimes, after.runtimes);
    forall row | row in after.runtimes
      ensures row.id > 0 && !(exists w :: w in after.wrappers && w.id == row.id)
    {
      var i :| 0 <= i < |after.runtimes| && after.runtimes[i] == row;
      assert s.runtimes[i] in s.runtimes;
    }
    forall w | w in after.wrappers
      ensures exists row :: row in after.runtimes && w.original == row.id
    {
      var row :| row in s.runtimes && w.original == row.id;
      var i :| 0 <= i < |s.runtimes| && s.runtimes[i] == row;
      assert after.runtimes[i] in after.runtimes;
    }
    forall row | row in s.runtimes && row.policy != 0 ensures row in after.runtimes {
      if row.id == runtimeId { ProcessingRuntimeLookup(s, row); }
      var i :| 0 <= i < |s.runtimes| && s.runtimes[i] == row;
      assert after.runtimes[i] == row;
    }
    assert alwaysRuntimeIdentitiesAreUnique(after);
    assert alwaysWrapperIdentitiesAreUnique(after);
    ProcessingWrappersPreservePolicy(after);
    ProcessingBoundPoliciesRetained(s, after);
  }
}

lemma beginAdmission_ensures(s: ProcessingPolicies, by_: PolicyCaller, admissionId: int, runtimeId: int, input: ProcessingInput)
  ensures (inv(s) ==> canBeginAdmission(s, by_, admissionId, runtimeId, input) ==> alwaysRuntimeIdentitiesAreUnique(beginAdmission(s, by_, admissionId, runtimeId, input)))
  ensures (inv(s) ==> canBeginAdmission(s, by_, admissionId, runtimeId, input) ==> alwaysWrapperIdentitiesAreUnique(beginAdmission(s, by_, admissionId, runtimeId, input)))
  ensures (inv(s) ==> canBeginAdmission(s, by_, admissionId, runtimeId, input) ==> alwaysWrapperKeepsPolicy(beginAdmission(s, by_, admissionId, runtimeId, input)))
  ensures (inv(s) ==> canBeginAdmission(s, by_, admissionId, runtimeId, input) ==> alwaysPolicyAdmissionHasReceipt(beginAdmission(s, by_, admissionId, runtimeId, input)))
  ensures (inv(s) ==> canBeginAdmission(s, by_, admissionId, runtimeId, input) ==> alwaysAdmissionIdsAreUnique(beginAdmission(s, by_, admissionId, runtimeId, input)))
  ensures (inv(s) ==> canBeginAdmission(s, by_, admissionId, runtimeId, input) ==> alwaysPendingDecisionWasRequested(beginAdmission(s, by_, admissionId, runtimeId, input)))
  ensures (inv(s) ==> canBeginAdmission(s, by_, admissionId, runtimeId, input) ==> stepBoundPolicyCannotChange(s, beginAdmission(s, by_, admissionId, runtimeId, input)))
  ensures (inv(s) ==> canBeginAdmission(s, by_, admissionId, runtimeId, input) ==> stepDeniedProcessingTerminal(s, beginAdmission(s, by_, admissionId, runtimeId, input)))
{
  if inv(s) && canBeginAdmission(s, by_, admissionId, runtimeId, input) {
    var after := beginAdmission(s, by_, admissionId, runtimeId, input);
    var added := after.admissions[|s.admissions|];
    ProcessingPolicyAlwaysNonnegative(s, runtimeId);
    ProcessingAdmissionFacts(s);
    ProcessingAdmissionFacts(after);
    assert after.admissions == s.admissions + [added];
    forall row | row in after.admissions
      ensures row.id > 0 && row.policy >= 0
      ensures row.phase.PolicyPending? ==> row.policy > 0 && row.decisionCalls == 1
      ensures row.policy > 0 && (row.phase.ProcessingAllowed? || row.phase.PayloadPrepared?) ==>
        (row.receipt != "" && row.revisionPresent && row.revision != "" && row.decisionCalls == 1)
    {
      if row != added { assert row in s.admissions; }
    }
    ProcessingAdmissionSequenceFresh(s.admissions, added);
    ProcessingBoundPoliciesRetained(s, after);
  }
}

lemma decideAdmission_ensures(s: ProcessingPolicies, by_: PolicyCaller, admissionId: int, output: PolicyOutput)
  ensures (inv(s) ==> canDecideAdmission(s, by_, admissionId, output) ==> alwaysRuntimeIdentitiesAreUnique(decideAdmission(s, by_, admissionId, output)))
  ensures (inv(s) ==> canDecideAdmission(s, by_, admissionId, output) ==> alwaysWrapperIdentitiesAreUnique(decideAdmission(s, by_, admissionId, output)))
  ensures (inv(s) ==> canDecideAdmission(s, by_, admissionId, output) ==> alwaysWrapperKeepsPolicy(decideAdmission(s, by_, admissionId, output)))
  ensures (inv(s) ==> canDecideAdmission(s, by_, admissionId, output) ==> alwaysPolicyAdmissionHasReceipt(decideAdmission(s, by_, admissionId, output)))
  ensures (inv(s) ==> canDecideAdmission(s, by_, admissionId, output) ==> alwaysAdmissionIdsAreUnique(decideAdmission(s, by_, admissionId, output)))
  ensures (inv(s) ==> canDecideAdmission(s, by_, admissionId, output) ==> alwaysPendingDecisionWasRequested(decideAdmission(s, by_, admissionId, output)))
  ensures (inv(s) ==> canDecideAdmission(s, by_, admissionId, output) ==> stepBoundPolicyCannotChange(s, decideAdmission(s, by_, admissionId, output)))
  ensures (inv(s) ==> canDecideAdmission(s, by_, admissionId, output) ==> stepDeniedProcessingTerminal(s, decideAdmission(s, by_, admissionId, output)))
{
  if inv(s) && canDecideAdmission(s, by_, admissionId, output) {
    var after := decideAdmission(s, by_, admissionId, output);
    forall i | 0 <= i < |s.admissions|
      ensures after.admissions[i].id == s.admissions[i].id && after.admissions[i].policy == s.admissions[i].policy
      ensures s.admissions[i].phase.ProcessingDenied? ==> after.admissions[i].phase.ProcessingDenied?
    {}
    ProcessingAdmissionMapped(s, after);
    ProcessingBoundPoliciesRetained(s, after);
    forall row | row in after.admissions
      ensures row.policy > 0 && (row.phase.ProcessingAllowed? || row.phase.PayloadPrepared?) ==>
        (row.receipt != "" && row.revisionPresent && row.revision != "" && row.decisionCalls == 1)
      ensures row.phase.PolicyPending? ==> row.policy > 0 && row.decisionCalls == 1
    {
      var i :| 0 <= i < |after.admissions| && after.admissions[i] == row;
      assert s.admissions[i] in s.admissions;
    }
  }
}

lemma preparePayload_ensures(s: ProcessingPolicies, by_: PolicyCaller, admissionId: int, aborted: bool)
  ensures (inv(s) ==> canPreparePayload(s, by_, admissionId, aborted) ==> alwaysRuntimeIdentitiesAreUnique(preparePayload(s, by_, admissionId, aborted)))
  ensures (inv(s) ==> canPreparePayload(s, by_, admissionId, aborted) ==> alwaysWrapperIdentitiesAreUnique(preparePayload(s, by_, admissionId, aborted)))
  ensures (inv(s) ==> canPreparePayload(s, by_, admissionId, aborted) ==> alwaysWrapperKeepsPolicy(preparePayload(s, by_, admissionId, aborted)))
  ensures (inv(s) ==> canPreparePayload(s, by_, admissionId, aborted) ==> alwaysPolicyAdmissionHasReceipt(preparePayload(s, by_, admissionId, aborted)))
  ensures (inv(s) ==> canPreparePayload(s, by_, admissionId, aborted) ==> alwaysAdmissionIdsAreUnique(preparePayload(s, by_, admissionId, aborted)))
  ensures (inv(s) ==> canPreparePayload(s, by_, admissionId, aborted) ==> alwaysPendingDecisionWasRequested(preparePayload(s, by_, admissionId, aborted)))
  ensures (inv(s) ==> canPreparePayload(s, by_, admissionId, aborted) ==> stepBoundPolicyCannotChange(s, preparePayload(s, by_, admissionId, aborted)))
  ensures (inv(s) ==> canPreparePayload(s, by_, admissionId, aborted) ==> stepDeniedProcessingTerminal(s, preparePayload(s, by_, admissionId, aborted)))
{
  if inv(s) && canPreparePayload(s, by_, admissionId, aborted) {
    var after := preparePayload(s, by_, admissionId, aborted);
    forall i | 0 <= i < |s.admissions|
      ensures after.admissions[i].id == s.admissions[i].id && after.admissions[i].policy == s.admissions[i].policy
      ensures s.admissions[i].phase.ProcessingDenied? ==> after.admissions[i].phase.ProcessingDenied?
    {}
    ProcessingAdmissionMapped(s, after);
    ProcessingBoundPoliciesRetained(s, after);
    forall row | row in after.admissions
      ensures row.policy > 0 && (row.phase.ProcessingAllowed? || row.phase.PayloadPrepared?) ==>
        (row.receipt != "" && row.revisionPresent && row.revision != "" && row.decisionCalls == 1)
      ensures row.phase.PolicyPending? ==> row.policy > 0 && row.decisionCalls == 1
    {
      var i :| 0 <= i < |after.admissions| && after.admissions[i] == row;
      assert s.admissions[i] in s.admissions;
    }
  }
}
