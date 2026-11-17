lemma SeenUnreadable(b: bool, xs: seq<ClockReading>)
  ensures Std.Collections.Seq.FoldLeft((seen: bool, m: ClockReading) => (seen || !(m.readable)), b, xs) == (b || exists i :: 0 <= i < |xs| && !xs[i].readable)
  decreases |xs|
{
  if |xs| > 0 {
    SeenUnreadable(b || !xs[0].readable, xs[1..]);
    assert forall i :: 0 < i < |xs| ==> xs[i] == xs[1..][i - 1];
  }
}

lemma MinuteStep(acc: seq<int>, xs: seq<ClockReading>)
  requires |xs| > 0
  ensures Std.Collections.Seq.FoldLeft((acc: seq<int>, m: ClockReading) => (acc + Std.Collections.Seq.Filter((set_x: int) => !((set_x in acc)), [minuteOfDay(m.clock)])), acc, xs) == Std.Collections.Seq.FoldLeft((acc: seq<int>, m: ClockReading) => (acc + Std.Collections.Seq.Filter((set_x: int) => !((set_x in acc)), [minuteOfDay(m.clock)])), Std.Collections.Seq.FoldLeft((acc: seq<int>, m: ClockReading) => (acc + Std.Collections.Seq.Filter((set_x: int) => !((set_x in acc)), [minuteOfDay(m.clock)])), acc, [xs[0]]), xs[1..])
  ensures minuteOfDay(xs[0].clock) in Std.Collections.Seq.FoldLeft((acc: seq<int>, m: ClockReading) => (acc + Std.Collections.Seq.Filter((set_x: int) => !((set_x in acc)), [minuteOfDay(m.clock)])), acc, [xs[0]])
  ensures forall k :: k in acc ==> k in Std.Collections.Seq.FoldLeft((acc: seq<int>, m: ClockReading) => (acc + Std.Collections.Seq.Filter((set_x: int) => !((set_x in acc)), [minuteOfDay(m.clock)])), acc, [xs[0]])
{
  ProofLib.FilterMember((set_x: int) => !((set_x in acc)), [minuteOfDay(xs[0].clock)], minuteOfDay(xs[0].clock));
}

lemma DistinctMinutes(acc: seq<int>, xs: seq<ClockReading>)
  ensures forall k :: k in acc ==> k in Std.Collections.Seq.FoldLeft((acc: seq<int>, m: ClockReading) => (acc + Std.Collections.Seq.Filter((set_x: int) => !((set_x in acc)), [minuteOfDay(m.clock)])), acc, xs)
  ensures forall i :: 0 <= i < |xs| ==> minuteOfDay(xs[i].clock) in Std.Collections.Seq.FoldLeft((acc: seq<int>, m: ClockReading) => (acc + Std.Collections.Seq.Filter((set_x: int) => !((set_x in acc)), [minuteOfDay(m.clock)])), acc, xs)
  decreases |xs|
{
  if |xs| > 0 {
    MinuteStep(acc, xs);
    DistinctMinutes(Std.Collections.Seq.FoldLeft((acc: seq<int>, m: ClockReading) => (acc + Std.Collections.Seq.Filter((set_x: int) => !((set_x in acc)), [minuteOfDay(m.clock)])), acc, [xs[0]]), xs[1..]);
    assert forall i :: 0 < i < |xs| ==> xs[i] == xs[1..][i - 1];
  }
}

lemma MinuteOnce(x: ClockReading)
  ensures Std.Collections.Seq.FoldLeft((acc: seq<int>, m: ClockReading) => (acc + Std.Collections.Seq.Filter((set_x: int) => !((set_x in acc)), [minuteOfDay(m.clock)])), [], [x]) == [minuteOfDay(x.clock)]
  ensures Std.Collections.Seq.FoldLeft((acc: seq<int>, m: ClockReading) => (acc + Std.Collections.Seq.Filter((set_x: int) => !((set_x in acc)), [minuteOfDay(m.clock)])), [minuteOfDay(x.clock)], [x]) == [minuteOfDay(x.clock)]
{
  ProofLib.FilterCons((set_x: int) => !((set_x in [])), [minuteOfDay(x.clock)]);
  ProofLib.FilterNil((set_x: int) => !((set_x in [])), [minuteOfDay(x.clock)][1..]);
  ProofLib.FilterCons((set_x: int) => !((set_x in [minuteOfDay(x.clock)])), [minuteOfDay(x.clock)]);
  ProofLib.FilterNil((set_x: int) => !((set_x in [minuteOfDay(x.clock)])), [minuteOfDay(x.clock)][1..]);
}

lemma EveryMentionAgrees(t: StatedClock, xs: seq<ClockReading>)
  requires forall i :: 0 <= i < |xs| ==> xs[i].readable && minuteOfDay(xs[i].clock) == minuteOfDay(t)
  ensures Std.Collections.Seq.FoldLeft((ok: bool, m: ClockReading) => ((ok && m.readable) && (minuteOfDay(m.clock) == minuteOfDay(t))), true, xs)
  decreases |xs|
{
  if |xs| > 0 {
    EveryMentionAgrees(t, xs[1..]);
  }
}

lemma lawRepeatedMentionIsOneTime_ensures(reading: ClockReading)
  ensures (lawRepeatedMentionIsOneTime(reading) == true)
{
  if reading.readable {
    SeenUnreadable(false, [reading, reading]);
    MinuteStep([], [reading, reading]);
    MinuteOnce(reading);
    assert [reading, reading][1..] == [reading];
  }
}

lemma lawOneTimeOnlyWhenEveryMentionAgrees_ensures(span: RangeReading, mentions: seq<ClockReading>)
  ensures (lawOneTimeOnlyWhenEveryMentionAgrees(span, mentions) == true)
{
  var t := statedTimes(span, mentions);
  if t.statedKind.OneStatedTime? && !span.present {
    SeenUnreadable(false, mentions);
    DistinctMinutes([], mentions);
    var seen := Std.Collections.Seq.FoldLeft((acc: seq<int>, m: ClockReading) => (acc + Std.Collections.Seq.Filter((set_x: int) => !((set_x in acc)), [minuteOfDay(m.clock)])), [], mentions);
    assert |seen| <= 1;
    forall i | 0 <= i < |mentions|
      ensures mentions[i].readable && minuteOfDay(mentions[i].clock) == minuteOfDay(t.opensAt)
    {
      assert minuteOfDay(mentions[i].clock) == seen[0];
      assert minuteOfDay(mentions[0].clock) == seen[0];
    }
    EveryMentionAgrees(t.opensAt, mentions);
  }
}
