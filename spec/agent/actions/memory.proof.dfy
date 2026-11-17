lemma SettledBlocked(failed: bool, m: Memory)
  ensures settleOwnedPage(failed, m).blocked == (if failed then m.blocked + ProofLib.Filter((set_x: int) => !((set_x in m.blocked)), [m.running]) else m.blocked)
{
}

lemma finishPage_ensures(m: Memory, failed: bool)
  ensures (inv(m) ==> canFinishPage(m, failed) ==> alwaysBlockedPageFailed(finishPage(m, failed)))
  ensures (inv(m) ==> canFinishPage(m, failed) ==> alwaysPendingPageKeepsTask(finishPage(m, failed)))
  ensures (inv(m) ==> canFinishPage(m, failed) ==> alwaysPageSettlesOnce(finishPage(m, failed)))
  ensures (inv(m) ==> canFinishPage(m, failed) ==> alwaysRunningPageIsCurrentAndPending(finishPage(m, failed)))
  ensures (inv(m) ==> canFinishPage(m, failed) ==> alwaysPendingPageUnsettled(finishPage(m, failed)))
  ensures (inv(m) ==> canFinishPage(m, failed) ==> stepStaleResultWritesNothing(m, "finishPage", finishPage(m, failed)))
  ensures (inv(m) ==> canFinishPage(m, failed) ==> stepShutdownKeepsPages(m, "finishPage", finishPage(m, failed)))
{
  if inv(m) && canFinishPage(m, failed) && ownsRow(m) {
    var after := finishPage(m, failed);
    SettledBlocked(failed, m);
    forall x ensures x in after.blocked <==> x in m.blocked || (failed && x == m.running) {
      ProofLib.FilterMember((set_x: int) => !((set_x in m.blocked)), [m.running], x);
    }
    forall p | p in pageIds && p in after.blocked ensures pageStatus(after, p).PageFailed? {
      if p != m.running {
        assert pageStatus(m, p).PageFailed?;
      }
    }
  }
}
