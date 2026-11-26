lemma FoldLeftConcat<A, T>(f: (A, T) -> A, acc: A, xs: seq<T>, ys: seq<T>)
  ensures Std.Collections.Seq.FoldLeft(f, acc, xs + ys) == Std.Collections.Seq.FoldLeft(f, Std.Collections.Seq.FoldLeft(f, acc, xs), ys)
  decreases |xs|
{
  if |xs| == 0 {
    assert xs + ys == ys;
  } else {
    assert (xs + ys)[0] == xs[0];
    assert (xs + ys)[1..] == xs[1..] + ys;
    FoldLeftConcat(f, f(acc, xs[0]), xs[1..], ys);
  }
}

lemma SegmentRequiresBothEnds(p: SegmentProgress, seen: seq<SegmentSignal>, rest: seq<SegmentSignal>)
  requires p.ready ==> typed0_agent__voice__clientAudio(SegmentSignal.AudioReady) in seen
  requires p.loaded ==> typed0_agent__voice__clientAudio(SegmentSignal.AudioReady) in seen && typed0_agent__voice__clientAudio(SegmentSignal.InputLoaded) in seen
  requires p.ended ==> typed0_agent__voice__clientAudio(SegmentSignal.AudioEnded) in seen
  requires p.outcome.SegmentPlayed? ==> typed0_agent__voice__clientAudio(SegmentSignal.AudioReady) in seen && typed0_agent__voice__clientAudio(SegmentSignal.InputLoaded) in seen && typed0_agent__voice__clientAudio(SegmentSignal.AudioEnded) in seen
  ensures var res := Std.Collections.Seq.FoldLeft((q: SegmentProgress, sig: SegmentSignal) => segmentAfter(q, sig), p, rest);
    res.outcome.SegmentPlayed? ==> (typed0_agent__voice__clientAudio(SegmentSignal.AudioReady) in (seen + rest)
      && typed0_agent__voice__clientAudio(SegmentSignal.InputLoaded) in (seen + rest)
      && typed0_agent__voice__clientAudio(SegmentSignal.AudioEnded) in (seen + rest))
  decreases |rest|
{
  if |rest| == 0 {
    assert seen + rest == seen;
  } else {
    var next := segmentAfter(p, rest[0]);
    assert (seen + [rest[0]]) + rest[1..] == seen + rest;
    SegmentRequiresBothEnds(next, seen + [rest[0]], rest[1..]);
  }
}

lemma SegmentSettledStays(p: SegmentProgress, later: seq<SegmentSignal>)
  requires !p.outcome.SegmentPending?
  ensures Std.Collections.Seq.FoldLeft((q: SegmentProgress, sig: SegmentSignal) => segmentAfter(q, sig), p, later) == p
  decreases |later|
{
  if |later| > 0 {
    assert segmentAfter(p, later[0]) == p;
    SegmentSettledStays(p, later[1..]);
  }
}

lemma ReplyPlayedBounded(r: ReplyRun, segmentCount: int, events: seq<ReplyEvent>)
  requires r.played <= (if segmentCount > 0 then segmentCount else 0)
  ensures Std.Collections.Seq.FoldLeft((q: ReplyRun, e: ReplyEvent) => replyAfter(q, segmentCount, e), r, events).played <= (if segmentCount > 0 then segmentCount else 0)
  decreases |events|
{
  if |events| > 0 {
    ReplyPlayedBounded(replyAfter(r, segmentCount, events[0]), segmentCount, events[1..]);
  }
}

lemma ReplyIdleStaysWithoutSpeak(r: ReplyRun, segmentCount: int, later: seq<ReplyEvent>)
  requires !r.running
  requires !(typed1_agent__voice__clientAudio(ReplyEvent.SpeakReply) in later)
  ensures var res := Std.Collections.Seq.FoldLeft((q: ReplyRun, e: ReplyEvent) => replyAfter(q, segmentCount, e), r, later);
    res.played == r.played && !res.running
  decreases |later|
{
  if |later| > 0 {
    assert later[0] in later;
    assert !later[0].SpeakReply?;
    var next := replyAfter(r, segmentCount, later[0]);
    assert next.played == r.played && !next.running;
    assert forall e :: e in later[1..] ==> e in later;
    ReplyIdleStaysWithoutSpeak(next, segmentCount, later[1..]);
  }
}

lemma lawASegmentPlaysOnlyAfterBothEnds_ensures(signals: seq<SegmentSignal>)
  ensures (lawASegmentPlaysOnlyAfterBothEnds(signals) == true)
{
  SegmentRequiresBothEnds(segmentStart, [], signals);
  assert [] + signals == signals;
}

lemma lawASettledSegmentStaysSettled_ensures(signals: seq<SegmentSignal>, later: seq<SegmentSignal>)
  ensures (lawASettledSegmentStaysSettled(signals, later) == true)
{
  if !segmentOf(signals).outcome.SegmentPending? {
    var f := (p: SegmentProgress, sig: SegmentSignal) => segmentAfter(p, sig);
    FoldLeftConcat(f, segmentStart, signals, later);
    SegmentSettledStays(segmentOf(signals), later);
  }
}

lemma lawNoMoreSegmentsThanTheReplyHas_ensures(segmentCount: int, events: seq<ReplyEvent>)
  ensures (lawNoMoreSegmentsThanTheReplyHas(segmentCount, events) == true)
{
  ReplyPlayedBounded(replyIdle, segmentCount, events);
}

lemma lawNothingPlaysAfterStop_ensures(segmentCount: int, events: seq<ReplyEvent>, later: seq<ReplyEvent>)
  ensures (lawNothingPlaysAfterStop(segmentCount, events, later) == true)
{
  if !(typed1_agent__voice__clientAudio(ReplyEvent.SpeakReply) in later) {
    var f := (r: ReplyRun, e: ReplyEvent) => replyAfter(r, segmentCount, e);
    var prefix := events + [ReplyEvent.StopReply];
    FoldLeftConcat(f, replyIdle, events, [ReplyEvent.StopReply]);
    var afterStop := replyOf(segmentCount, prefix);
    assert afterStop == replyAfter(replyOf(segmentCount, events), segmentCount, ReplyEvent.StopReply);
    assert !afterStop.running;
    FoldLeftConcat(f, replyIdle, prefix, later);
    ReplyIdleStaysWithoutSpeak(afterStop, segmentCount, later);
  }
}
