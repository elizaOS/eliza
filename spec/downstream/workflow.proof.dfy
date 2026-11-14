lemma WorkflowKeyInjective(left: string, right: string)
  ensures ("$" + left == "$" + right) == (left == right)
{
  assert ("$" + left)[1..] == left;
  assert ("$" + right)[1..] == right;
}

lemma submitWorkflow_ensures(w: Workflow, by_: string, form: RequestForm, submission: string, expected: int, inputKey: string)
  ensures (inv(w) ==> alwaysDefinitionVersion(submitWorkflow(w, by_, form, submission, expected, inputKey)))
  ensures (inv(w) ==> alwaysRunReplyIsExplicit(submitWorkflow(w, by_, form, submission, expected, inputKey)))
  ensures (inv(w) ==> alwaysSubmittedRunHasIdentity(submitWorkflow(w, by_, form, submission, expected, inputKey)))
  ensures (inv(w) ==> alwaysTypedActiveUsesReviewedSchedule(submitWorkflow(w, by_, form, submission, expected, inputKey)))
  ensures (inv(w) ==> stepRetainsSubmittedRuns(w, submitWorkflow(w, by_, form, submission, expected, inputKey)))
{
  if inv(w) && w.owner != "" && w.owner == by_ && form.ExactRequest? && submission != "" && expected > 0 && !(submission in w.submissionIds) && expected == w.version {
    var after := submitWorkflow(w, by_, form, submission, expected, inputKey);
    assert after.submissionIds == w.submissionIds + ProofLib.Filter((set_x: string) => !(set_x in w.submissionIds), [submission]);
    ProofLib.FilterCons((set_x: string) => !(set_x in w.submissionIds), [submission]);
    ProofLib.FilterNil((set_x: string) => !(set_x in w.submissionIds), []);
    assert after.submissionIds == w.submissionIds + [submission];
    forall id | id in w.submissionIds
      ensures id in after.submissionIds && entry(after, id) == entry(w, id)
    {
      assert id != submission;
      WorkflowKeyInjective(id, submission);
    }
    forall id | id in after.submissionIds
      ensures id != "" && entry(after, id).owner == after.owner && 0 < entry(after, id).version <= after.version && 0 < entry(after, id).runId <= after.serial
    {
      if id == submission { assert entry(after, id) == Submission(by_, expected, inputKey, w.serial + 1); }
      else { assert id in w.submissionIds; }
    }
  }
}
