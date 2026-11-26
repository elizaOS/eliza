lemma postChooser_ensures(s: FilesPreview, request: ChooserRequest, activityPresent: bool)
  ensures (inv(s) ==> canPostChooser(s) ==> alwaysCallsBelongToIssuedVisitsAndTickets(postChooser(s, request, activityPresent)))
  ensures (inv(s) ==> canPostChooser(s) ==> alwaysPreviewIsOfThisVisit(postChooser(s, request, activityPresent)))
  ensures (inv(s) ==> canPostChooser(s) ==> alwaysReplyCountsOnlyOpenedFiles(postChooser(s, request, activityPresent)))
  ensures (inv(s) ==> canPostChooser(s) ==> stepOnlyTheRequestingVisitShowsItsSelection(s, "postChooser", postChooser(s, request, activityPresent), []))
  ensures (inv(s) ==> canPostChooser(s) ==> stepReplyIsNeverRevised(s, postChooser(s, request, activityPresent)))
  ensures (inv(s) ==> canPostChooser(s) ==> stepChooserKeepsThePreview(s, "postChooser", postChooser(s, request, activityPresent)))
{
  if inv(s) && canPostChooser(s) {
    var after := postChooser(s, request, activityPresent);
    var local_0 := s.tickets + 1;
    if !(handedFiles(request) == 0 || !activityPresent) {
      var p := (set_x: int) => !(set_x in s.queued);
      assert !(local_0 in s.queued);
      ProofLib.FilterCons(p, [local_0]);
      ProofLib.FilterNil(p, [local_0][1..]);
      assert after.queued == s.queued + [local_0];
      assert local_0 in after.queued;
    }
  }
}

lemma startChooser_ensures(s: FilesPreview, ticket: int, launched: bool)
  ensures (inv(s) ==> canStartChooser(s, ticket) ==> alwaysCallsBelongToIssuedVisitsAndTickets(startChooser(s, ticket, launched)))
  ensures (inv(s) ==> canStartChooser(s, ticket) ==> alwaysPreviewIsOfThisVisit(startChooser(s, ticket, launched)))
  ensures (inv(s) ==> canStartChooser(s, ticket) ==> alwaysReplyCountsOnlyOpenedFiles(startChooser(s, ticket, launched)))
  ensures (inv(s) ==> canStartChooser(s, ticket) ==> stepOnlyTheRequestingVisitShowsItsSelection(s, "startChooser", startChooser(s, ticket, launched), []))
  ensures (inv(s) ==> canStartChooser(s, ticket) ==> stepReplyIsNeverRevised(s, startChooser(s, ticket, launched)))
  ensures (inv(s) ==> canStartChooser(s, ticket) ==> stepChooserKeepsThePreview(s, "startChooser", startChooser(s, ticket, launched)))
{
  if inv(s) && canStartChooser(s, ticket) {
    var after := startChooser(s, ticket, launched);
    var p := (set_x: int) => !(set_x in [ticket]);
    forall t | t in after.queued
      ensures t in s.queued && t != ticket
    {
      ProofLib.FilterMember(p, s.queued, t);
    }
    if !(ticket > 0 && awaitedTicket(s.call) == ticket) && awaitedTicket(s.call) in s.queued {
      ProofLib.FilterMember(p, s.queued, awaitedTicket(s.call));
    }
  }
}
