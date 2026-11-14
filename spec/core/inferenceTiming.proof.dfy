lemma TimerFilters(t: Timer)
  ensures alwaysCloserIdentityUnique(t) == (forall closer :: closer in t.closers ==> |ProofLib.Filter((other: SpanCloser) => (other.id == closer.id), t.closers)| == 1)
  ensures alwaysMarksAreUnique(t) == ((forall mark :: mark in t.marks ==> |ProofLib.Filter((other: TimingMark) => (other.name == mark.name), t.marks)| == 1) && t.duplicateMarks >= 0)
{}

lemma openSpan_ensures(t: Timer, id: string, name: string)
  ensures (inv(t) ==> canOpenSpan(t, id, name) ==> alwaysOpenTimerHasNoDuration(openSpan(t, id, name)))
  ensures (inv(t) ==> canOpenSpan(t, id, name) ==> alwaysSpanCapacity(openSpan(t, id, name)))
  ensures (inv(t) ==> canOpenSpan(t, id, name) ==> alwaysCloserIdentityUnique(openSpan(t, id, name)))
  ensures (inv(t) ==> canOpenSpan(t, id, name) ==> alwaysMarksAreUnique(openSpan(t, id, name)))
  ensures (inv(t) ==> canOpenSpan(t, id, name) ==> alwaysUnstartedTimerIsEmpty(openSpan(t, id, name)))
  ensures (inv(t) ==> canOpenSpan(t, id, name) ==> stepCloseTimeIsStable(t, openSpan(t, id, name)))
  ensures (inv(t) ==> canOpenSpan(t, id, name) ==> stepFirstProviderWins(t, openSpan(t, id, name)))
  ensures (inv(t) ==> canOpenSpan(t, id, name) ==> stepMarksRetainFirstValue(t, openSpan(t, id, name)))
{
  if inv(t) && canOpenSpan(t, id, name) {
    var after := openSpan(t, id, name);
    TimerFilters(t); TimerFilters(after);
    forall closer | closer in after.closers
      ensures |ProofLib.Filter((other: SpanCloser) => (other.id == closer.id), after.closers)| == 1
    {
      ProofLib.FilterAppend((other: SpanCloser) => (other.id == closer.id), t.closers, SpanCloser(id, name, t.now, false));
      if closer.id == id {
        ProofLib.FilterNone((other: SpanCloser) => (other.id == closer.id), t.closers);
      } else { assert closer in t.closers; }
    }
  }
}

lemma closeSpan_ensures(t: Timer, id: string)
  ensures (inv(t) ==> canCloseSpan(t, id) ==> alwaysOpenTimerHasNoDuration(closeSpan(t, id)))
  ensures (inv(t) ==> canCloseSpan(t, id) ==> alwaysSpanCapacity(closeSpan(t, id)))
  ensures (inv(t) ==> canCloseSpan(t, id) ==> alwaysCloserIdentityUnique(closeSpan(t, id)))
  ensures (inv(t) ==> canCloseSpan(t, id) ==> alwaysMarksAreUnique(closeSpan(t, id)))
  ensures (inv(t) ==> canCloseSpan(t, id) ==> alwaysUnstartedTimerIsEmpty(closeSpan(t, id)))
  ensures (inv(t) ==> canCloseSpan(t, id) ==> stepCloseTimeIsStable(t, closeSpan(t, id)))
  ensures (inv(t) ==> canCloseSpan(t, id) ==> stepFirstProviderWins(t, closeSpan(t, id)))
  ensures (inv(t) ==> canCloseSpan(t, id) ==> stepMarksRetainFirstValue(t, closeSpan(t, id)))
{
  if inv(t) && canCloseSpan(t, id) {
    var after := closeSpan(t, id);
    TimerFilters(t); TimerFilters(after);
    assert |t.closers| == |after.closers|;
    forall i | 0 <= i < |t.closers|
      ensures t.closers[i].id == after.closers[i].id
    {}
    forall closer | closer in after.closers
      ensures |ProofLib.Filter((other: SpanCloser) => (other.id == closer.id), after.closers)| == 1
    {
      var i :| 0 <= i < |after.closers| && after.closers[i] == closer;
      assert t.closers[i] in t.closers && t.closers[i].id == closer.id;
      ProofLib.FilterLengthPointwise((other: SpanCloser) => (other.id == closer.id), (other: SpanCloser) => (other.id == closer.id), t.closers, after.closers);
    }
  }
}

lemma markTime_ensures(t: Timer, name: string, at: int)
  ensures (inv(t) ==> canMarkTime(t, name, at) ==> alwaysOpenTimerHasNoDuration(markTime(t, name, at)))
  ensures (inv(t) ==> canMarkTime(t, name, at) ==> alwaysSpanCapacity(markTime(t, name, at)))
  ensures (inv(t) ==> canMarkTime(t, name, at) ==> alwaysCloserIdentityUnique(markTime(t, name, at)))
  ensures (inv(t) ==> canMarkTime(t, name, at) ==> alwaysMarksAreUnique(markTime(t, name, at)))
  ensures (inv(t) ==> canMarkTime(t, name, at) ==> alwaysUnstartedTimerIsEmpty(markTime(t, name, at)))
  ensures (inv(t) ==> canMarkTime(t, name, at) ==> stepCloseTimeIsStable(t, markTime(t, name, at)))
  ensures (inv(t) ==> canMarkTime(t, name, at) ==> stepFirstProviderWins(t, markTime(t, name, at)))
  ensures (inv(t) ==> canMarkTime(t, name, at) ==> stepMarksRetainFirstValue(t, markTime(t, name, at)))
{
  if inv(t) && canMarkTime(t, name, at) {
    var after := markTime(t, name, at);
    TimerFilters(t); TimerFilters(after);
    if !(exists mark :: mark in t.marks && mark.name == name) {
      forall mark | mark in after.marks
        ensures |ProofLib.Filter((other: TimingMark) => (other.name == mark.name), after.marks)| == 1
      {
        ProofLib.FilterAppend((other: TimingMark) => (other.name == mark.name), t.marks, TimingMark(name, at));
        if mark.name == name {
          ProofLib.FilterNone((other: TimingMark) => (other.name == mark.name), t.marks);
        } else { assert mark in t.marks; }
      }
    }
  }
}
