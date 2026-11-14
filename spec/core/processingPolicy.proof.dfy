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

lemma registerPolicyRuntime_ensures(s: ProcessingPolicies, runtimeId: int)
  ensures (inv(s) ==> canRegisterPolicyRuntime(s, runtimeId) ==> alwaysRuntimeIdentitiesAreUnique(registerPolicyRuntime(s, runtimeId)))
  ensures (inv(s) ==> canRegisterPolicyRuntime(s, runtimeId) ==> alwaysWrapperIdentitiesAreUnique(registerPolicyRuntime(s, runtimeId)))
  ensures (inv(s) ==> canRegisterPolicyRuntime(s, runtimeId) ==> alwaysWrapperKeepsPolicy(registerPolicyRuntime(s, runtimeId)))
  ensures (inv(s) ==> canRegisterPolicyRuntime(s, runtimeId) ==> alwaysPolicyAdmissionHasReceipt(registerPolicyRuntime(s, runtimeId)))
  ensures (inv(s) ==> canRegisterPolicyRuntime(s, runtimeId) ==> alwaysAdmissionIdsAreUnique(registerPolicyRuntime(s, runtimeId)))
  ensures (inv(s) ==> canRegisterPolicyRuntime(s, runtimeId) ==> alwaysPendingDecisionWasRequested(registerPolicyRuntime(s, runtimeId)))
  ensures (inv(s) ==> canRegisterPolicyRuntime(s, runtimeId) ==> stepBoundPolicyCannotChange(s, registerPolicyRuntime(s, runtimeId)))
  ensures (inv(s) ==> canRegisterPolicyRuntime(s, runtimeId) ==> stepDeniedProcessingTerminal(s, registerPolicyRuntime(s, runtimeId)))
{
  if inv(s) && canRegisterPolicyRuntime(s, runtimeId) {
    var after := registerPolicyRuntime(s, runtimeId);
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

lemma registerRuntimeWrapper_ensures(s: ProcessingPolicies, wrapperId: int, runtimeId: int)
  ensures (inv(s) ==> canRegisterRuntimeWrapper(s, wrapperId, runtimeId) ==> alwaysRuntimeIdentitiesAreUnique(registerRuntimeWrapper(s, wrapperId, runtimeId)))
  ensures (inv(s) ==> canRegisterRuntimeWrapper(s, wrapperId, runtimeId) ==> alwaysWrapperIdentitiesAreUnique(registerRuntimeWrapper(s, wrapperId, runtimeId)))
  ensures (inv(s) ==> canRegisterRuntimeWrapper(s, wrapperId, runtimeId) ==> alwaysWrapperKeepsPolicy(registerRuntimeWrapper(s, wrapperId, runtimeId)))
  ensures (inv(s) ==> canRegisterRuntimeWrapper(s, wrapperId, runtimeId) ==> alwaysPolicyAdmissionHasReceipt(registerRuntimeWrapper(s, wrapperId, runtimeId)))
  ensures (inv(s) ==> canRegisterRuntimeWrapper(s, wrapperId, runtimeId) ==> alwaysAdmissionIdsAreUnique(registerRuntimeWrapper(s, wrapperId, runtimeId)))
  ensures (inv(s) ==> canRegisterRuntimeWrapper(s, wrapperId, runtimeId) ==> alwaysPendingDecisionWasRequested(registerRuntimeWrapper(s, wrapperId, runtimeId)))
  ensures (inv(s) ==> canRegisterRuntimeWrapper(s, wrapperId, runtimeId) ==> stepBoundPolicyCannotChange(s, registerRuntimeWrapper(s, wrapperId, runtimeId)))
  ensures (inv(s) ==> canRegisterRuntimeWrapper(s, wrapperId, runtimeId) ==> stepDeniedProcessingTerminal(s, registerRuntimeWrapper(s, wrapperId, runtimeId)))
{
  if inv(s) && canRegisterRuntimeWrapper(s, wrapperId, runtimeId) {
    var after := registerRuntimeWrapper(s, wrapperId, runtimeId);
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

lemma bindPolicy_ensures(s: ProcessingPolicies, runtimeId: int, policyId: int)
  ensures (inv(s) ==> canBindPolicy(s, runtimeId, policyId) ==> alwaysRuntimeIdentitiesAreUnique(bindPolicy(s, runtimeId, policyId)))
  ensures (inv(s) ==> canBindPolicy(s, runtimeId, policyId) ==> alwaysWrapperIdentitiesAreUnique(bindPolicy(s, runtimeId, policyId)))
  ensures (inv(s) ==> canBindPolicy(s, runtimeId, policyId) ==> alwaysWrapperKeepsPolicy(bindPolicy(s, runtimeId, policyId)))
  ensures (inv(s) ==> canBindPolicy(s, runtimeId, policyId) ==> alwaysPolicyAdmissionHasReceipt(bindPolicy(s, runtimeId, policyId)))
  ensures (inv(s) ==> canBindPolicy(s, runtimeId, policyId) ==> alwaysAdmissionIdsAreUnique(bindPolicy(s, runtimeId, policyId)))
  ensures (inv(s) ==> canBindPolicy(s, runtimeId, policyId) ==> alwaysPendingDecisionWasRequested(bindPolicy(s, runtimeId, policyId)))
  ensures (inv(s) ==> canBindPolicy(s, runtimeId, policyId) ==> stepBoundPolicyCannotChange(s, bindPolicy(s, runtimeId, policyId)))
  ensures (inv(s) ==> canBindPolicy(s, runtimeId, policyId) ==> stepDeniedProcessingTerminal(s, bindPolicy(s, runtimeId, policyId)))
{
  if inv(s) && canBindPolicy(s, runtimeId, policyId) {
    var after := bindPolicy(s, runtimeId, policyId);
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

lemma beginAdmission_ensures(s: ProcessingPolicies, admissionId: int, runtimeId: int, input: ProcessingInput)
  ensures (inv(s) ==> canBeginAdmission(s, admissionId, runtimeId, input) ==> alwaysRuntimeIdentitiesAreUnique(beginAdmission(s, admissionId, runtimeId, input)))
  ensures (inv(s) ==> canBeginAdmission(s, admissionId, runtimeId, input) ==> alwaysWrapperIdentitiesAreUnique(beginAdmission(s, admissionId, runtimeId, input)))
  ensures (inv(s) ==> canBeginAdmission(s, admissionId, runtimeId, input) ==> alwaysWrapperKeepsPolicy(beginAdmission(s, admissionId, runtimeId, input)))
  ensures (inv(s) ==> canBeginAdmission(s, admissionId, runtimeId, input) ==> alwaysPolicyAdmissionHasReceipt(beginAdmission(s, admissionId, runtimeId, input)))
  ensures (inv(s) ==> canBeginAdmission(s, admissionId, runtimeId, input) ==> alwaysAdmissionIdsAreUnique(beginAdmission(s, admissionId, runtimeId, input)))
  ensures (inv(s) ==> canBeginAdmission(s, admissionId, runtimeId, input) ==> alwaysPendingDecisionWasRequested(beginAdmission(s, admissionId, runtimeId, input)))
  ensures (inv(s) ==> canBeginAdmission(s, admissionId, runtimeId, input) ==> stepBoundPolicyCannotChange(s, beginAdmission(s, admissionId, runtimeId, input)))
  ensures (inv(s) ==> canBeginAdmission(s, admissionId, runtimeId, input) ==> stepDeniedProcessingTerminal(s, beginAdmission(s, admissionId, runtimeId, input)))
{
  if inv(s) && canBeginAdmission(s, admissionId, runtimeId, input) {
    var after := beginAdmission(s, admissionId, runtimeId, input);
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

lemma decideAdmission_ensures(s: ProcessingPolicies, admissionId: int, output: PolicyOutput)
  ensures (inv(s) ==> canDecideAdmission(s, admissionId, output) ==> alwaysRuntimeIdentitiesAreUnique(decideAdmission(s, admissionId, output)))
  ensures (inv(s) ==> canDecideAdmission(s, admissionId, output) ==> alwaysWrapperIdentitiesAreUnique(decideAdmission(s, admissionId, output)))
  ensures (inv(s) ==> canDecideAdmission(s, admissionId, output) ==> alwaysWrapperKeepsPolicy(decideAdmission(s, admissionId, output)))
  ensures (inv(s) ==> canDecideAdmission(s, admissionId, output) ==> alwaysPolicyAdmissionHasReceipt(decideAdmission(s, admissionId, output)))
  ensures (inv(s) ==> canDecideAdmission(s, admissionId, output) ==> alwaysAdmissionIdsAreUnique(decideAdmission(s, admissionId, output)))
  ensures (inv(s) ==> canDecideAdmission(s, admissionId, output) ==> alwaysPendingDecisionWasRequested(decideAdmission(s, admissionId, output)))
  ensures (inv(s) ==> canDecideAdmission(s, admissionId, output) ==> stepBoundPolicyCannotChange(s, decideAdmission(s, admissionId, output)))
  ensures (inv(s) ==> canDecideAdmission(s, admissionId, output) ==> stepDeniedProcessingTerminal(s, decideAdmission(s, admissionId, output)))
{
  if inv(s) && canDecideAdmission(s, admissionId, output) {
    var after := decideAdmission(s, admissionId, output);
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

lemma preparePayload_ensures(s: ProcessingPolicies, admissionId: int, aborted: bool)
  ensures (inv(s) ==> canPreparePayload(s, admissionId, aborted) ==> alwaysRuntimeIdentitiesAreUnique(preparePayload(s, admissionId, aborted)))
  ensures (inv(s) ==> canPreparePayload(s, admissionId, aborted) ==> alwaysWrapperIdentitiesAreUnique(preparePayload(s, admissionId, aborted)))
  ensures (inv(s) ==> canPreparePayload(s, admissionId, aborted) ==> alwaysWrapperKeepsPolicy(preparePayload(s, admissionId, aborted)))
  ensures (inv(s) ==> canPreparePayload(s, admissionId, aborted) ==> alwaysPolicyAdmissionHasReceipt(preparePayload(s, admissionId, aborted)))
  ensures (inv(s) ==> canPreparePayload(s, admissionId, aborted) ==> alwaysAdmissionIdsAreUnique(preparePayload(s, admissionId, aborted)))
  ensures (inv(s) ==> canPreparePayload(s, admissionId, aborted) ==> alwaysPendingDecisionWasRequested(preparePayload(s, admissionId, aborted)))
  ensures (inv(s) ==> canPreparePayload(s, admissionId, aborted) ==> stepBoundPolicyCannotChange(s, preparePayload(s, admissionId, aborted)))
  ensures (inv(s) ==> canPreparePayload(s, admissionId, aborted) ==> stepDeniedProcessingTerminal(s, preparePayload(s, admissionId, aborted)))
{
  if inv(s) && canPreparePayload(s, admissionId, aborted) {
    var after := preparePayload(s, admissionId, aborted);
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
