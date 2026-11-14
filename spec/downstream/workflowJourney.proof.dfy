lemma dispatchReviewed_ensures(j: WorkflowJourney)
  ensures (inv(j) ==> canDispatchReviewed(j) ==> alwaysArchiveCoordinates(dispatchReviewed(j)))
  ensures (inv(j) ==> canDispatchReviewed(j) ==> alwaysDefinitionCoordinates(dispatchReviewed(j)))
  ensures (inv(j) ==> canDispatchReviewed(j) ==> alwaysLocalIntentTracksPhase(dispatchReviewed(j)))
  ensures (inv(j) ==> canDispatchReviewed(j) ==> alwaysServerAdmissionTracksPhase(dispatchReviewed(j)))
{
  if inv(j) && canDispatchReviewed(j) {
    var before := j.remote;
    var after := dispatchReviewed(j).remote;
    var id := "submission";
    ProofLib.FilterCons((key: string) => !(key in before.submissionIds), [id]);
    ProofLib.FilterNil((key: string) => !(key in before.submissionIds), []);
    assert after.submissionIds == before.submissionIds + [id];
    assert downstream__workflow_entry(after, id) == downstream__workflow_Submission("owner", j.reviewedVersion, "{}", before.serial + 1);
    forall key | key in after.submissionIds
      ensures key != "" && downstream__workflow_entry(after, key).owner == after.owner &&
        0 < downstream__workflow_entry(after, key).version <= after.version &&
        0 < downstream__workflow_entry(after, key).runId <= after.serial
    {
      if key != id {
        assert key in before.submissionIds;
        assert ("$" + key)[1..] == key;
        assert ("$" + id)[1..] == id;
        assert downstream__workflow_entry(after, key) == downstream__workflow_entry(before, key);
      }
    }
  }
}
