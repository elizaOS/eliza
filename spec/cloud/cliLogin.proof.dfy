lemma PollsBridge(s: CliLogin)
  ensures alwaysOnePollPerPoller(s) <==> ProofLib.DistinctBy(s.polls, (o: Poll) => o.poller)
  ensures alwaysClaimRevealedAtMostOnce(s) <==> s.reveals_ + |ProofLib.Filter((p: Poll) => p.step.PollClaimed?, s.polls)| <= 1 && (|ProofLib.Filter((p: Poll) => p.step.PollClaimed?, s.polls)| > 0 ==> s.consumed)
  ensures alwaysOneReveal(s) <==> s.reveals_ <= 1 && |ProofLib.Filter((p: Poll) => p.step.PollClaimed?, s.polls)| <= 1 && (s.reveals_ == 1 ==> s.consumed)
{
  var ps := s.polls;
  ProofLib.FilterNone((p: Poll) => p.step.PollClaimed?, ps);
  assert alwaysOnePollPerPoller(s) <==> forall p :: p in ps ==> |ProofLib.Filter((o: Poll) => (o.poller == p.poller), ps)| == 1;
  forall i | 0 <= i < |ps|
    ensures |ProofLib.Filter((o: Poll) => (o.poller == ps[i].poller), ps)| == 1 <==> forall j :: 0 <= j < |ps| && j != i ==> ps[j].poller != ps[i].poller
  {
    ProofLib.FilterCountOneIffUnique((o: Poll) => (o.poller == ps[i].poller), ps, (o: Poll) => o.poller, i);
  }
  if ProofLib.DistinctBy(ps, (o: Poll) => o.poller) {
    forall p | p in ps ensures |ProofLib.Filter((o: Poll) => (o.poller == p.poller), ps)| == 1 {
      var i :| 0 <= i < |ps| && ps[i] == p;
    }
  }
}

lemma FilterUpdateLength<T>(p: T -> bool, xs: seq<T>, i: int, v: T)
  requires 0 <= i < |xs|
  ensures |ProofLib.Filter(p, xs[i := v])| + (if p(xs[i]) then 1 else 0) == |ProofLib.Filter(p, xs)| + (if p(v) then 1 else 0)
  decreases |xs|
{
  ProofLib.FilterCons(p, xs);
  ProofLib.FilterCons(p, xs[i := v]);
  if i > 0 {
    assert xs[i := v][1..] == xs[1..][i - 1 := v];
    FilterUpdateLength(p, xs[1..], i - 1, v);
  } else {
    assert xs[i := v][1..] == xs[1..];
  }
}

lemma PollUpdate(s: CliLogin, poller: int, v: Poll)
  requires alwaysOnePollPerPoller(s) && pollOf(s, poller).poller == poller && !pollOf(s, poller).step.PollDone? && v.poller == poller
  ensures ProofLib.DistinctBy(putPoll(s, v), (o: Poll) => o.poller)
  ensures |ProofLib.Filter((p: Poll) => p.step.PollClaimed?, putPoll(s, v))| + (if pollOf(s, poller).step.PollClaimed? then 1 else 0) == |ProofLib.Filter((p: Poll) => p.step.PollClaimed?, s.polls)| + (if v.step.PollClaimed? then 1 else 0)
{
  PollsBridge(s);
  var f := ProofLib.Filter((p: Poll) => (p.poller == poller), s.polls);
  ProofLib.FilterSubset((p: Poll) => (p.poller == poller), s.polls);
  var i :| 0 <= i < |s.polls| && s.polls[i] == f[0];
  ProofLib.FilterMember((p: Poll) => (p.poller == poller), s.polls, f[0]);
  assert putPoll(s, v) == s.polls[i := v];
  FilterUpdateLength((p: Poll) => p.step.PollClaimed?, s.polls, i, v);
}

lemma beginPoll_ensures(s: CliLogin, poller: int)
  ensures (inv(s) ==> canBeginPoll(s, poller) ==> alwaysOneMintedKey(beginPoll(s, poller)))
  ensures (inv(s) ==> canBeginPoll(s, poller) ==> alwaysPendingSessionMintedNothing(beginPoll(s, poller)))
  ensures (inv(s) ==> canBeginPoll(s, poller) ==> alwaysClockNeverNegative(beginPoll(s, poller)))
  ensures (inv(s) ==> canBeginPoll(s, poller) ==> alwaysOneReveal(beginPoll(s, poller)))
  ensures (inv(s) ==> canBeginPoll(s, poller) ==> alwaysOnePollPerPoller(beginPoll(s, poller)))
  ensures (inv(s) ==> canBeginPoll(s, poller) ==> alwaysClaimRevealedAtMostOnce(beginPoll(s, poller)))
  ensures (inv(s) ==> canBeginPoll(s, poller) ==> alwaysCollectedBeforeDeadline(beginPoll(s, poller)))
  ensures (inv(s) ==> canBeginPoll(s, poller) ==> alwaysNoAbandonedActiveKey(beginPoll(s, poller)))
  ensures (inv(s) ==> canBeginPoll(s, poller) ==> stepClaimMatchesSession(s, beginPoll(s, poller)))
  ensures (inv(s) ==> canBeginPoll(s, poller) ==> stepCleanupKeepsCollectedKey(s, "beginPoll", beginPoll(s, poller)))
{
  if inv(s) && canBeginPoll(s, poller) {
    var after := beginPoll(s, poller);
    PollsBridge(s);
    PollsBridge(after);
    ProofLib.FilterAppend((p: Poll) => p.step.PollClaimed?, s.polls, Poll(poller, PollStep.PollDecrypting, s.key, s.owner, s.keyHash));
    ProofLib.DistinctByConcat(s.polls, [Poll(poller, PollStep.PollDecrypting, s.key, s.owner, s.keyHash)], (o: Poll) => o.poller);
  }
}

lemma deliver_ensures(s: CliLogin, poller: int)
  ensures (inv(s) ==> canDeliver(s, poller) ==> alwaysOneMintedKey(deliver(s, poller)))
  ensures (inv(s) ==> canDeliver(s, poller) ==> alwaysPendingSessionMintedNothing(deliver(s, poller)))
  ensures (inv(s) ==> canDeliver(s, poller) ==> alwaysClockNeverNegative(deliver(s, poller)))
  ensures (inv(s) ==> canDeliver(s, poller) ==> alwaysOneReveal(deliver(s, poller)))
  ensures (inv(s) ==> canDeliver(s, poller) ==> alwaysOnePollPerPoller(deliver(s, poller)))
  ensures (inv(s) ==> canDeliver(s, poller) ==> alwaysClaimRevealedAtMostOnce(deliver(s, poller)))
  ensures (inv(s) ==> canDeliver(s, poller) ==> alwaysCollectedBeforeDeadline(deliver(s, poller)))
  ensures (inv(s) ==> canDeliver(s, poller) ==> alwaysNoAbandonedActiveKey(deliver(s, poller)))
  ensures (inv(s) ==> canDeliver(s, poller) ==> stepClaimMatchesSession(s, deliver(s, poller)))
  ensures (inv(s) ==> canDeliver(s, poller) ==> stepCleanupKeepsCollectedKey(s, "deliver", deliver(s, poller)))
{
  if inv(s) && canDeliver(s, poller) {
    var after := deliver(s, poller);
    PollsBridge(s);
    PollsBridge(after);
    PollUpdate(s, poller, pollOf(s, poller).(step := PollStep.PollDone));
  }
}

lemma loseReply_ensures(s: CliLogin, poller: int)
  ensures (inv(s) ==> canLoseReply(s, poller) ==> alwaysOneMintedKey(loseReply(s, poller)))
  ensures (inv(s) ==> canLoseReply(s, poller) ==> alwaysPendingSessionMintedNothing(loseReply(s, poller)))
  ensures (inv(s) ==> canLoseReply(s, poller) ==> alwaysClockNeverNegative(loseReply(s, poller)))
  ensures (inv(s) ==> canLoseReply(s, poller) ==> alwaysOneReveal(loseReply(s, poller)))
  ensures (inv(s) ==> canLoseReply(s, poller) ==> alwaysOnePollPerPoller(loseReply(s, poller)))
  ensures (inv(s) ==> canLoseReply(s, poller) ==> alwaysClaimRevealedAtMostOnce(loseReply(s, poller)))
  ensures (inv(s) ==> canLoseReply(s, poller) ==> alwaysCollectedBeforeDeadline(loseReply(s, poller)))
  ensures (inv(s) ==> canLoseReply(s, poller) ==> alwaysNoAbandonedActiveKey(loseReply(s, poller)))
  ensures (inv(s) ==> canLoseReply(s, poller) ==> stepClaimMatchesSession(s, loseReply(s, poller)))
  ensures (inv(s) ==> canLoseReply(s, poller) ==> stepCleanupKeepsCollectedKey(s, "loseReply", loseReply(s, poller)))
{
  if inv(s) && canLoseReply(s, poller) {
    var after := loseReply(s, poller);
    PollsBridge(s);
    PollsBridge(after);
    PollUpdate(s, poller, pollOf(s, poller).(step := PollStep.PollDone));
  }
}

lemma claimKey_ensures(s: CliLogin, poller: int)
  ensures (inv(s) ==> canClaimKey(s, poller) ==> alwaysOneMintedKey(claimKey(s, poller)))
  ensures (inv(s) ==> canClaimKey(s, poller) ==> alwaysPendingSessionMintedNothing(claimKey(s, poller)))
  ensures (inv(s) ==> canClaimKey(s, poller) ==> alwaysClockNeverNegative(claimKey(s, poller)))
  ensures (inv(s) ==> canClaimKey(s, poller) ==> alwaysOneReveal(claimKey(s, poller)))
  ensures (inv(s) ==> canClaimKey(s, poller) ==> alwaysOnePollPerPoller(claimKey(s, poller)))
  ensures (inv(s) ==> canClaimKey(s, poller) ==> alwaysClaimRevealedAtMostOnce(claimKey(s, poller)))
  ensures (inv(s) ==> canClaimKey(s, poller) ==> alwaysCollectedBeforeDeadline(claimKey(s, poller)))
  ensures (inv(s) ==> canClaimKey(s, poller) ==> alwaysNoAbandonedActiveKey(claimKey(s, poller)))
  ensures (inv(s) ==> canClaimKey(s, poller) ==> stepClaimMatchesSession(s, claimKey(s, poller)))
  ensures (inv(s) ==> canClaimKey(s, poller) ==> stepCleanupKeepsCollectedKey(s, "claimKey", claimKey(s, poller)))
{
  if inv(s) && canClaimKey(s, poller) {
    var after := claimKey(s, poller);
    PollsBridge(s);
    PollsBridge(after);
    PollUpdate(s, poller, pollOf(s, poller).(step := PollStep.PollClaimed));
    PollUpdate(s, poller, pollOf(s, poller).(step := PollStep.PollDone));
  }
}
