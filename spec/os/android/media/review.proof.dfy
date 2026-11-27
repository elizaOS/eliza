lemma settleResume_ensures(s: PermittedReview, reviewId: int, destroyed: bool)
  ensures (inv(s) ==> canSettleResume(s, reviewId) ==> alwaysHeldSelectionsWereAdmitted(settleResume(s, reviewId, destroyed)))
  ensures (inv(s) ==> canSettleResume(s, reviewId) ==> alwaysClosedReviewShowsNoDialog(settleResume(s, reviewId, destroyed)))
  ensures (inv(s) ==> canSettleResume(s, reviewId) ==> stepAndroidIsAskedOnlyAfterLocalConfirmation(s, "settleResume", settleResume(s, reviewId, destroyed)))
  ensures (inv(s) ==> canSettleResume(s, reviewId) ==> stepWorkIsQueuedOnlyForALiveGrant(s, "settleResume", settleResume(s, reviewId, destroyed)))
  ensures (inv(s) ==> canSettleResume(s, reviewId) ==> stepResumeKeepsTheNewerReview(s, "settleResume", settleResume(s, reviewId, destroyed)))
{
  if inv(s) && canSettleResume(s, reviewId) {
    var matched := ProofLib.Filter((t: ReviewTicket) => (t.token.id == reviewId), s.awaitingResume);
    var rest := ProofLib.Filter((t: ReviewTicket) => (t.token.id != reviewId), s.awaitingResume);
    var found :| found in s.awaitingResume && found.token.id == reviewId;
    ProofLib.FilterMember((t: ReviewTicket) => (t.token.id == reviewId), s.awaitingResume, found);
    assert found in matched;
    assert |matched| > 0;
    ProofLib.FilterMember((t: ReviewTicket) => (t.token.id == reviewId), s.awaitingResume, matched[0]);
    assert matched[0] in s.awaitingResume;
    assert admitted(matched[0].selection);
    forall t | t in rest
      ensures t in s.awaitingResume
    {
      ProofLib.FilterMember((x: ReviewTicket) => (x.token.id != reviewId), s.awaitingResume, t);
    }
  }
}

lemma lawStoppedReviewReportsNothingChanged_ensures(entry: ReviewEntry, ladders: seq<os__android__media__rows_RowLadder>)
  ensures (lawStoppedReviewReportsNothingChanged(entry, ladders) == true)
{
  if |ladders| > 0 {
    var outcomes := seq(|ladders|, i_map requires 0 <= i_map < |ladders| => var l := ladders[i_map]; itemOutcome(true, l));
    assert outcomes[0] in outcomes;
    assert outcomes[0] == os__android__media__rows_RowOutcome.RowUnverified;
    assert !os__android__media__rows_rowVerified(outcomes[0]);
    assert !os__android__media__rows_rowsComplete(outcomes);
  }
}
