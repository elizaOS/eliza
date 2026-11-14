lemma EventRunFacts(s: EventState)
  ensures alwaysRunSequencesNonnegative(s) ==
    (forall row :: row in s.runs ==> (row.sequence >= 0 &&
      |ProofLib.Filter((peer: RunClock) => (peer.id == row.id), s.runs)| == 1))
{}

lemma EventRunSequence(s: EventState, runId: string)
  requires alwaysRunSequencesNonnegative(s)
  ensures eventRun(s, runId) >= 0
{
  EventRunFacts(s);
  var key := (r: RunClock) => (r.id == runId);
  var retained := ProofLib.Filter(key, s.runs);
  if |retained| > 0 {
    ProofLib.FilterMember(key, s.runs, retained[0]);
  }
}

lemma EventAppendRun(s: EventState, after: EventState, added: RunClock)
  requires alwaysRunSequencesNonnegative(s)
  requires !(exists row :: row in s.runs && row.id == added.id)
  requires added.sequence >= 0 && after.runs == s.runs + [added]
  ensures alwaysRunSequencesNonnegative(after)
{
  EventRunFacts(s);
  EventRunFacts(after);
  forall row | row in after.runs
    ensures row.sequence >= 0 &&
      |ProofLib.Filter((peer: RunClock) => (peer.id == row.id), after.runs)| == 1
  {
    var key := (peer: RunClock) => (peer.id == row.id);
    ProofLib.FilterAppend(key, s.runs, added);
    if row == added {
      ProofLib.FilterNone(key, s.runs);
    } else {
      assert row in s.runs;
    }
  }
}

lemma EventUpdateRuns(s: EventState, after: EventState)
  requires alwaysRunSequencesNonnegative(s)
  requires |after.runs| == |s.runs|
  requires forall i :: 0 <= i < |s.runs| ==> after.runs[i].id == s.runs[i].id && after.runs[i].sequence >= 0
  ensures alwaysRunSequencesNonnegative(after)
{
  EventRunFacts(s);
  EventRunFacts(after);
  forall row | row in after.runs
    ensures row.sequence >= 0 &&
      |ProofLib.Filter((peer: RunClock) => (peer.id == row.id), after.runs)| == 1
  {
    var i :| 0 <= i < |after.runs| && after.runs[i] == row;
    assert s.runs[i] in s.runs;
    var key := (peer: RunClock) => (peer.id == row.id);
    ProofLib.FilterLengthPointwise(key, key, s.runs, after.runs);
  }
}

lemma EventPushAgent(s: EventState, input: EventInput, kind: EmissionKind, parent: int, errorCount: int)
  requires alwaysRunSequencesNonnegative(s) && alwaysAllocatedSequencesArePositive(s)
  ensures alwaysRunSequencesNonnegative(pushAgent(input, kind, parent, errorCount, s))
  ensures alwaysAllocatedSequencesArePositive(pushAgent(input, kind, parent, errorCount, s))
{
  var after := pushAgent(input, kind, parent, errorCount, s);
  var sequence := eventRun(s, input.runId) + 1;
  EventRunSequence(s, input.runId);
  EventRunFacts(s);
  if exists r :: r in s.runs && (r.id == input.runId) {
    forall i | 0 <= i < |s.runs|
      ensures after.runs[i].id == s.runs[i].id && after.runs[i].sequence >= 0
    {
      assert s.runs[i] in s.runs;
    }
    EventUpdateRuns(s, after);
  } else {
    EventAppendRun(s, after, RunClock(input.runId, 1, emptyContext));
  }
}

lemma EventListenerFacts(s: EventState)
  ensures alwaysOneCurrentRegistration(s) ==
    (s.nextGeneration > 0 && (forall row :: row in s.listeners ==> (row.callback > 0 &&
      0 < row.generation < s.nextGeneration &&
      |ProofLib.Filter((peer: Subscription) => ((peer.callback == row.callback) && (peer.channel == row.channel)), s.listeners)| == 1)))
{}

lemma EventKeepAllListeners(rows: seq<Subscription>)
  ensures ProofLib.Filter((h: Subscription) => true, rows) == rows
  decreases |rows|
{
  if |rows| == 0 {
    ProofLib.FilterNil((h: Subscription) => true, rows);
  } else {
    ProofLib.FilterCons((h: Subscription) => true, rows);
    EventKeepAllListeners(rows[1..]);
    assert [rows[0]] + rows[1..] == rows;
  }
}

lemma EventMonotonicFold(rows: seq<Subscription>, cursor: int)
  ensures (Std.Collections.Seq.FoldLeft((priorGeneration: int, h: Subscription) => (if ((priorGeneration >= 0) && (h.generation > priorGeneration)) then h.generation else -1), cursor, rows) >= 0)
    == (cursor >= 0 && (forall i :: 0 <= i < |rows| ==> cursor < rows[i].generation) &&
        (forall i, j :: 0 <= i < j < |rows| ==> rows[i].generation < rows[j].generation))
  decreases |rows|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |rows| > 0 {
    var first := rows[0].generation;
    var next := if cursor >= 0 && first > cursor then first else -1;
    assert forall i :: 0 <= i < |rows[1..]| ==> rows[1..][i] == rows[i + 1];
    EventMonotonicFold(rows[1..], next);
    if next >= 0 {
      if forall i :: 0 <= i < |rows[1..]| ==> next < rows[1..][i].generation {
        forall i | 0 <= i < |rows|
          ensures cursor < rows[i].generation
        {
          if i > 0 { assert rows[i] == rows[1..][i - 1]; }
        }
        if forall i, j :: 0 <= i < j < |rows[1..]| ==> rows[1..][i].generation < rows[1..][j].generation {
          forall i, j | 0 <= i < j < |rows|
            ensures rows[i].generation < rows[j].generation
          {
            assert rows[j] == rows[1..][j - 1];
            if i > 0 { assert rows[i] == rows[1..][i - 1]; }
          }
        }
      }
      if (forall i, j :: 0 <= i < j < |rows| ==> rows[i].generation < rows[j].generation) {
        forall i | 0 <= i < |rows[1..]|
          ensures next < rows[1..][i].generation
        {
          assert rows[0].generation < rows[i + 1].generation;
        }
        forall i, j | 0 <= i < j < |rows[1..]|
          ensures rows[1..][i].generation < rows[1..][j].generation
        {
          assert rows[i + 1].generation < rows[j + 1].generation;
        }
      }
    }
  }
}

lemma EventMonotonicFilter(rows: seq<Subscription>, keep: Subscription -> bool)
  requires forall i, j :: 0 <= i < j < |rows| ==> rows[i].generation < rows[j].generation
  ensures forall i, j :: 0 <= i < j < |ProofLib.Filter(keep, rows)| ==>
    ProofLib.Filter(keep, rows)[i].generation < ProofLib.Filter(keep, rows)[j].generation
  decreases |rows|
{
  if |rows| > 0 {
    var rest := rows[1..];
    assert forall i :: 0 <= i < |rest| ==> rest[i] == rows[i + 1];
    forall i, j | 0 <= i < j < |rest|
      ensures rest[i].generation < rest[j].generation
    {
      assert rows[i + 1].generation < rows[j + 1].generation;
    }
    EventMonotonicFilter(rest, keep);
    ProofLib.FilterCons(keep, rows);
    var tail := ProofLib.Filter(keep, rest);
    var retained := ProofLib.Filter(keep, rows);
    if keep(rows[0]) {
      forall i, j | 0 <= i < j < |retained|
        ensures retained[i].generation < retained[j].generation
      {
        assert retained[j] == tail[j - 1];
        if i == 0 {
          ProofLib.FilterMember(keep, rest, retained[j]);
          var k :| 0 <= k < |rest| && rest[k] == retained[j];
          assert rows[0].generation < rows[k + 1].generation;
        } else {
          assert retained[i] == tail[i - 1];
        }
      }
    }
  }
}

lemma registerRun_ensures(s: EventState, runId: string, context: RunContext)
  ensures (inv(s) ==> canRegisterRun(s, runId, context) ==> alwaysSessionUsesCallerOrRun(registerRun(s, runId, context)))
  ensures (inv(s) ==> canRegisterRun(s, runId, context) ==> alwaysRunSequencesNonnegative(registerRun(s, runId, context)))
  ensures (inv(s) ==> canRegisterRun(s, runId, context) ==> alwaysOneCurrentRegistration(registerRun(s, runId, context)))
  ensures (inv(s) ==> canRegisterRun(s, runId, context) ==> alwaysListenerOrderIsMonotonic(registerRun(s, runId, context)))
  ensures (inv(s) ==> canRegisterRun(s, runId, context) ==> alwaysListenerCursorIsValid(registerRun(s, runId, context)))
  ensures (inv(s) ==> canRegisterRun(s, runId, context) ==> alwaysReportCursorIsValid(registerRun(s, runId, context)))
  ensures (inv(s) ==> canRegisterRun(s, runId, context) ==> alwaysDiagnosticsFollowOriginal(registerRun(s, runId, context)))
  ensures (inv(s) ==> canRegisterRun(s, runId, context) ==> alwaysAllocatedSequencesArePositive(registerRun(s, runId, context)))
  ensures (inv(s) ==> canRegisterRun(s, runId, context) ==> alwaysHeartbeatIndicatorAgrees(registerRun(s, runId, context)))
  ensures (inv(s) ==> canRegisterRun(s, runId, context) ==> stepEmissionAllocatesRunSequence(s, "registerRun", registerRun(s, runId, context)))
  ensures (inv(s) ==> canRegisterRun(s, runId, context) ==> stepListenerBeginsAtNextPosition(s, "registerRun", registerRun(s, runId, context)))
  ensures (inv(s) ==> canRegisterRun(s, runId, context) ==> stepEventStopClearsIndexes(s, "registerRun", registerRun(s, runId, context)))
{
  if inv(s) && canRegisterRun(s, runId, context) {
    var after := registerRun(s, runId, context);
    EventRunFacts(s);
    if exists r :: r in s.runs && (r.id == runId) {
      forall i | 0 <= i < |s.runs|
        ensures after.runs[i].id == s.runs[i].id && after.runs[i].sequence >= 0
      {
        assert s.runs[i] in s.runs;
      }
      EventUpdateRuns(s, after);
    } else {
      EventAppendRun(s, after, RunClock(runId, 0, context));
    }
  }
}

lemma clearRun_ensures(s: EventState, runId: string)
  ensures (inv(s) ==> alwaysSessionUsesCallerOrRun(clearRun(s, runId)))
  ensures (inv(s) ==> alwaysRunSequencesNonnegative(clearRun(s, runId)))
  ensures (inv(s) ==> alwaysOneCurrentRegistration(clearRun(s, runId)))
  ensures (inv(s) ==> alwaysListenerOrderIsMonotonic(clearRun(s, runId)))
  ensures (inv(s) ==> alwaysListenerCursorIsValid(clearRun(s, runId)))
  ensures (inv(s) ==> alwaysReportCursorIsValid(clearRun(s, runId)))
  ensures (inv(s) ==> alwaysDiagnosticsFollowOriginal(clearRun(s, runId)))
  ensures (inv(s) ==> alwaysAllocatedSequencesArePositive(clearRun(s, runId)))
  ensures (inv(s) ==> alwaysHeartbeatIndicatorAgrees(clearRun(s, runId)))
  ensures (inv(s) ==> stepEmissionAllocatesRunSequence(s, "clearRun", clearRun(s, runId)))
  ensures (inv(s) ==> stepListenerBeginsAtNextPosition(s, "clearRun", clearRun(s, runId)))
  ensures (inv(s) ==> stepEventStopClearsIndexes(s, "clearRun", clearRun(s, runId)))
{
  if inv(s) {
    var after := clearRun(s, runId);
    var keep := (r: RunClock) => (r.id != runId);
    EventRunFacts(s);
    EventRunFacts(after);
    forall row | row in after.runs
      ensures row.sequence >= 0 && |ProofLib.Filter((peer: RunClock) => (peer.id == row.id), after.runs)| == 1
    {
      var key := (peer: RunClock) => (peer.id == row.id);
      ProofLib.FilterMember(keep, s.runs, row);
      ProofLib.FilterOfFilterShorter(keep, key, s.runs);
      ProofLib.FilterMember(key, after.runs, row);
    }
  }
}

lemma admitEvent_ensures(s: EventState, input: EventInput)
  ensures (inv(s) ==> canAdmitEvent(s) ==> alwaysSessionUsesCallerOrRun(admitEvent(s, input)))
  ensures (inv(s) ==> canAdmitEvent(s) ==> alwaysRunSequencesNonnegative(admitEvent(s, input)))
  ensures (inv(s) ==> canAdmitEvent(s) ==> alwaysOneCurrentRegistration(admitEvent(s, input)))
  ensures (inv(s) ==> canAdmitEvent(s) ==> alwaysListenerOrderIsMonotonic(admitEvent(s, input)))
  ensures (inv(s) ==> canAdmitEvent(s) ==> alwaysListenerCursorIsValid(admitEvent(s, input)))
  ensures (inv(s) ==> canAdmitEvent(s) ==> alwaysReportCursorIsValid(admitEvent(s, input)))
  ensures (inv(s) ==> canAdmitEvent(s) ==> alwaysDiagnosticsFollowOriginal(admitEvent(s, input)))
  ensures (inv(s) ==> canAdmitEvent(s) ==> alwaysAllocatedSequencesArePositive(admitEvent(s, input)))
  ensures (inv(s) ==> canAdmitEvent(s) ==> alwaysHeartbeatIndicatorAgrees(admitEvent(s, input)))
  ensures (inv(s) ==> canAdmitEvent(s) ==> stepEmissionAllocatesRunSequence(s, "admitEvent", admitEvent(s, input)))
  ensures (inv(s) ==> canAdmitEvent(s) ==> stepListenerBeginsAtNextPosition(s, "admitEvent", admitEvent(s, input)))
  ensures (inv(s) ==> canAdmitEvent(s) ==> stepEventStopClearsIndexes(s, "admitEvent", admitEvent(s, input)))
{
  if inv(s) && canAdmitEvent(s) {
    EventPushAgent(s, input, agentEmission, top(s).envelope.emissionId, 0);
  }
}

lemma subscribe_ensures(s: EventState, callback: int, channel: ListenerChannel)
  ensures (inv(s) ==> canSubscribe(s, callback, channel) ==> alwaysSessionUsesCallerOrRun(subscribe(s, callback, channel)))
  ensures (inv(s) ==> canSubscribe(s, callback, channel) ==> alwaysRunSequencesNonnegative(subscribe(s, callback, channel)))
  ensures (inv(s) ==> canSubscribe(s, callback, channel) ==> alwaysOneCurrentRegistration(subscribe(s, callback, channel)))
  ensures (inv(s) ==> canSubscribe(s, callback, channel) ==> alwaysListenerOrderIsMonotonic(subscribe(s, callback, channel)))
  ensures (inv(s) ==> canSubscribe(s, callback, channel) ==> alwaysListenerCursorIsValid(subscribe(s, callback, channel)))
  ensures (inv(s) ==> canSubscribe(s, callback, channel) ==> alwaysReportCursorIsValid(subscribe(s, callback, channel)))
  ensures (inv(s) ==> canSubscribe(s, callback, channel) ==> alwaysDiagnosticsFollowOriginal(subscribe(s, callback, channel)))
  ensures (inv(s) ==> canSubscribe(s, callback, channel) ==> alwaysAllocatedSequencesArePositive(subscribe(s, callback, channel)))
  ensures (inv(s) ==> canSubscribe(s, callback, channel) ==> alwaysHeartbeatIndicatorAgrees(subscribe(s, callback, channel)))
  ensures (inv(s) ==> canSubscribe(s, callback, channel) ==> stepEmissionAllocatesRunSequence(s, "subscribe", subscribe(s, callback, channel)))
  ensures (inv(s) ==> canSubscribe(s, callback, channel) ==> stepListenerBeginsAtNextPosition(s, "subscribe", subscribe(s, callback, channel)))
  ensures (inv(s) ==> canSubscribe(s, callback, channel) ==> stepEventStopClearsIndexes(s, "subscribe", subscribe(s, callback, channel)))
{
  if inv(s) && canSubscribe(s, callback, channel) && !(exists h :: h in s.listeners && ((h.callback == callback) && (h.channel == channel))) {
    var after := subscribe(s, callback, channel);
    var added := Subscription(callback, channel, s.nextGeneration);
    EventListenerFacts(s);
    EventListenerFacts(after);
    forall row | row in after.listeners
      ensures row.callback > 0 && 0 < row.generation < after.nextGeneration &&
        |ProofLib.Filter((peer: Subscription) => ((peer.callback == row.callback) && (peer.channel == row.channel)), after.listeners)| == 1
    {
      var key := (peer: Subscription) => ((peer.callback == row.callback) && (peer.channel == row.channel));
      ProofLib.FilterAppend(key, s.listeners, added);
      if row == added {
        ProofLib.FilterNone(key, s.listeners);
      } else {
        assert row in s.listeners;
      }
    }
    EventMonotonicFold(s.listeners, 0);
    forall i, j | 0 <= i < j < |after.listeners|
      ensures after.listeners[i].generation < after.listeners[j].generation
    {
      if j == |s.listeners| { assert s.listeners[i] in s.listeners; }
    }
    forall i | 0 <= i < |after.listeners|
      ensures 0 < after.listeners[i].generation
    {
      assert after.listeners[i] in after.listeners;
    }
    EventMonotonicFold(after.listeners, 0);
  }
}

lemma detach_ensures(s: EventState, callback: int, channel: ListenerChannel, generation: int)
  ensures (inv(s) ==> canDetach(s, callback, channel, generation) ==> alwaysSessionUsesCallerOrRun(detach(s, callback, channel, generation)))
  ensures (inv(s) ==> canDetach(s, callback, channel, generation) ==> alwaysRunSequencesNonnegative(detach(s, callback, channel, generation)))
  ensures (inv(s) ==> canDetach(s, callback, channel, generation) ==> alwaysOneCurrentRegistration(detach(s, callback, channel, generation)))
  ensures (inv(s) ==> canDetach(s, callback, channel, generation) ==> alwaysListenerOrderIsMonotonic(detach(s, callback, channel, generation)))
  ensures (inv(s) ==> canDetach(s, callback, channel, generation) ==> alwaysListenerCursorIsValid(detach(s, callback, channel, generation)))
  ensures (inv(s) ==> canDetach(s, callback, channel, generation) ==> alwaysReportCursorIsValid(detach(s, callback, channel, generation)))
  ensures (inv(s) ==> canDetach(s, callback, channel, generation) ==> alwaysDiagnosticsFollowOriginal(detach(s, callback, channel, generation)))
  ensures (inv(s) ==> canDetach(s, callback, channel, generation) ==> alwaysAllocatedSequencesArePositive(detach(s, callback, channel, generation)))
  ensures (inv(s) ==> canDetach(s, callback, channel, generation) ==> alwaysHeartbeatIndicatorAgrees(detach(s, callback, channel, generation)))
  ensures (inv(s) ==> canDetach(s, callback, channel, generation) ==> stepEmissionAllocatesRunSequence(s, "detach", detach(s, callback, channel, generation)))
  ensures (inv(s) ==> canDetach(s, callback, channel, generation) ==> stepListenerBeginsAtNextPosition(s, "detach", detach(s, callback, channel, generation)))
  ensures (inv(s) ==> canDetach(s, callback, channel, generation) ==> stepEventStopClearsIndexes(s, "detach", detach(s, callback, channel, generation)))
{
  if inv(s) && canDetach(s, callback, channel, generation) {
    var after := detach(s, callback, channel, generation);
    var keep := (h: Subscription) => (((h.callback != callback) || (h.channel != channel)) || (h.generation != generation));
    EventListenerFacts(s);
    EventListenerFacts(after);
    forall row | row in after.listeners
      ensures row.callback > 0 && 0 < row.generation < after.nextGeneration &&
        |ProofLib.Filter((peer: Subscription) => ((peer.callback == row.callback) && (peer.channel == row.channel)), after.listeners)| == 1
    {
      var key := (peer: Subscription) => ((peer.callback == row.callback) && (peer.channel == row.channel));
      ProofLib.FilterMember(keep, s.listeners, row);
      ProofLib.FilterOfFilterShorter(keep, key, s.listeners);
      ProofLib.FilterMember(key, after.listeners, row);
    }
    EventMonotonicFold(s.listeners, 0);
    EventMonotonicFilter(s.listeners, keep);
    assert after.listeners == ProofLib.Filter(keep, s.listeners);
    forall i, j | 0 <= i < j < |after.listeners|
      ensures after.listeners[i].generation < after.listeners[j].generation
    {
      assert ProofLib.Filter(keep, s.listeners)[i].generation < ProofLib.Filter(keep, s.listeners)[j].generation;
    }
    forall i | 0 <= i < |after.listeners|
      ensures 0 < after.listeners[i].generation
    {
      assert after.listeners[i] in after.listeners;
    }
    EventMonotonicFold(after.listeners, 0);
  }
}

lemma lawStaleHandleKeepsRegistrations_ensures(s: EventState, callback: int, channel: ListenerChannel, generation: int)
  ensures (lawStaleHandleKeepsRegistrations(s, callback, channel, generation) == true)
{
  if !(exists h :: h in s.listeners && h.callback == callback && h.channel == channel && h.generation == generation) {
    var keep := (h: Subscription) => (((h.callback != callback) || (h.channel != channel)) || (h.generation != generation));
    forall i | 0 <= i < |s.listeners|
      ensures keep(s.listeners[i]) == true
    {
      assert s.listeners[i] in s.listeners;
    }
    ProofLib.FilterSamePredicate(keep, (h: Subscription) => true, s.listeners);
    EventKeepAllListeners(s.listeners);
  }
}

lemma beginListener_ensures(s: EventState)
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysSessionUsesCallerOrRun(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysRunSequencesNonnegative(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysOneCurrentRegistration(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysListenerOrderIsMonotonic(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysListenerCursorIsValid(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysReportCursorIsValid(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysDiagnosticsFollowOriginal(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysAllocatedSequencesArePositive(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysHeartbeatIndicatorAgrees(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> stepEmissionAllocatesRunSequence(s, "beginListener", beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> stepListenerBeginsAtNextPosition(s, "beginListener", beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> stepEventStopClearsIndexes(s, "beginListener", beginListener(s)))
{
  if inv(s) && canBeginListener(s) {
    var frame := top(s);
    var key := (h: Subscription) => ((h.channel == listenerChannel(frame)) && (h.generation > frame.cursor));
    var chosen := nextListener(s);
    assert |ProofLib.Filter(key, s.listeners)| > 0;
    assert chosen == ProofLib.Filter(key, s.listeners)[0];
    ProofLib.FilterMember(key, s.listeners, chosen);
    EventListenerFacts(s);
    assert 0 < chosen.generation < s.nextGeneration;
    assert frame.phase == visitingListeners;
  }
}

lemma finishOriginal_ensures(s: EventState)
  ensures (inv(s) ==> canFinishOriginal(s) ==> alwaysSessionUsesCallerOrRun(finishOriginal(s)))
  ensures (inv(s) ==> canFinishOriginal(s) ==> alwaysRunSequencesNonnegative(finishOriginal(s)))
  ensures (inv(s) ==> canFinishOriginal(s) ==> alwaysOneCurrentRegistration(finishOriginal(s)))
  ensures (inv(s) ==> canFinishOriginal(s) ==> alwaysListenerOrderIsMonotonic(finishOriginal(s)))
  ensures (inv(s) ==> canFinishOriginal(s) ==> alwaysListenerCursorIsValid(finishOriginal(s)))
  ensures (inv(s) ==> canFinishOriginal(s) ==> alwaysReportCursorIsValid(finishOriginal(s)))
  ensures (inv(s) ==> canFinishOriginal(s) ==> alwaysDiagnosticsFollowOriginal(finishOriginal(s)))
  ensures (inv(s) ==> canFinishOriginal(s) ==> alwaysAllocatedSequencesArePositive(finishOriginal(s)))
  ensures (inv(s) ==> canFinishOriginal(s) ==> alwaysHeartbeatIndicatorAgrees(finishOriginal(s)))
  ensures (inv(s) ==> canFinishOriginal(s) ==> stepEmissionAllocatesRunSequence(s, "finishOriginal", finishOriginal(s)))
  ensures (inv(s) ==> canFinishOriginal(s) ==> stepListenerBeginsAtNextPosition(s, "finishOriginal", finishOriginal(s)))
  ensures (inv(s) ==> canFinishOriginal(s) ==> stepEventStopClearsIndexes(s, "finishOriginal", finishOriginal(s)))
{
  if inv(s) && canFinishOriginal(s) {
    var frame := top(s);
    var after := finishOriginal(s);
    var added := frame.envelope.emissionId;
    var keep := (set_x: int) => !((set_x in s.fanoutFinished));
    ProofLib.FilterCons(keep, [added]);
    ProofLib.FilterNil(keep, [added][1..]);
    assert added in after.fanoutFinished;
    forall entry | entry in after.frames
      ensures (entry.kind == agentWarning ==> entry.parent in after.fanoutFinished) &&
        (entry.kind != heartbeatEmission && entry.phase != visitingListeners ==> entry.envelope.emissionId in after.fanoutFinished)
    {
      if entry in s.frames {
        assert entry.kind == agentWarning ==> entry.parent in s.fanoutFinished;
        assert entry.kind != heartbeatEmission && entry.phase != visitingListeners ==> entry.envelope.emissionId in s.fanoutFinished;
      } else {
        assert entry == top(after);
        assert frame in s.frames;
        assert entry.parent == frame.parent;
        assert entry.kind == frame.kind;
        assert entry.envelope.emissionId == added;
      }
    }
  }
}

lemma emitListenerWarning_ensures(s: EventState, timestamp: int)
  ensures (inv(s) ==> canEmitListenerWarning(s) ==> alwaysSessionUsesCallerOrRun(emitListenerWarning(s, timestamp)))
  ensures (inv(s) ==> canEmitListenerWarning(s) ==> alwaysRunSequencesNonnegative(emitListenerWarning(s, timestamp)))
  ensures (inv(s) ==> canEmitListenerWarning(s) ==> alwaysOneCurrentRegistration(emitListenerWarning(s, timestamp)))
  ensures (inv(s) ==> canEmitListenerWarning(s) ==> alwaysListenerOrderIsMonotonic(emitListenerWarning(s, timestamp)))
  ensures (inv(s) ==> canEmitListenerWarning(s) ==> alwaysListenerCursorIsValid(emitListenerWarning(s, timestamp)))
  ensures (inv(s) ==> canEmitListenerWarning(s) ==> alwaysReportCursorIsValid(emitListenerWarning(s, timestamp)))
  ensures (inv(s) ==> canEmitListenerWarning(s) ==> alwaysDiagnosticsFollowOriginal(emitListenerWarning(s, timestamp)))
  ensures (inv(s) ==> canEmitListenerWarning(s) ==> alwaysAllocatedSequencesArePositive(emitListenerWarning(s, timestamp)))
  ensures (inv(s) ==> canEmitListenerWarning(s) ==> alwaysHeartbeatIndicatorAgrees(emitListenerWarning(s, timestamp)))
  ensures (inv(s) ==> canEmitListenerWarning(s) ==> stepEmissionAllocatesRunSequence(s, "emitListenerWarning", emitListenerWarning(s, timestamp)))
  ensures (inv(s) ==> canEmitListenerWarning(s) ==> stepListenerBeginsAtNextPosition(s, "emitListenerWarning", emitListenerWarning(s, timestamp)))
  ensures (inv(s) ==> canEmitListenerWarning(s) ==> stepEventStopClearsIndexes(s, "emitListenerWarning", emitListenerWarning(s, timestamp)))
{
  if inv(s) && canEmitListenerWarning(s) {
    var frame := top(s);
    var input := EventInput(frame.envelope.runId, frame.envelope.requestedSession, "error", 0, "", "", timestamp);
    var prior := withTop(frame.(warningStarted := true), s);
    EventPushAgent(prior, input, agentWarning, frame.envelope.emissionId, |frame.failures|);
  }
}

lemma reportListenerError_ensures(s: EventState, timestamp: int, canForward: bool)
  ensures (inv(s) ==> canReportListenerError(s) ==> alwaysSessionUsesCallerOrRun(reportListenerError(s, timestamp, canForward)))
  ensures (inv(s) ==> canReportListenerError(s) ==> alwaysRunSequencesNonnegative(reportListenerError(s, timestamp, canForward)))
  ensures (inv(s) ==> canReportListenerError(s) ==> alwaysOneCurrentRegistration(reportListenerError(s, timestamp, canForward)))
  ensures (inv(s) ==> canReportListenerError(s) ==> alwaysListenerOrderIsMonotonic(reportListenerError(s, timestamp, canForward)))
  ensures (inv(s) ==> canReportListenerError(s) ==> alwaysListenerCursorIsValid(reportListenerError(s, timestamp, canForward)))
  ensures (inv(s) ==> canReportListenerError(s) ==> alwaysReportCursorIsValid(reportListenerError(s, timestamp, canForward)))
  ensures (inv(s) ==> canReportListenerError(s) ==> alwaysDiagnosticsFollowOriginal(reportListenerError(s, timestamp, canForward)))
  ensures (inv(s) ==> canReportListenerError(s) ==> alwaysAllocatedSequencesArePositive(reportListenerError(s, timestamp, canForward)))
  ensures (inv(s) ==> canReportListenerError(s) ==> alwaysHeartbeatIndicatorAgrees(reportListenerError(s, timestamp, canForward)))
  ensures (inv(s) ==> canReportListenerError(s) ==> stepEmissionAllocatesRunSequence(s, "reportListenerError", reportListenerError(s, timestamp, canForward)))
  ensures (inv(s) ==> canReportListenerError(s) ==> stepListenerBeginsAtNextPosition(s, "reportListenerError", reportListenerError(s, timestamp, canForward)))
  ensures (inv(s) ==> canReportListenerError(s) ==> stepEventStopClearsIndexes(s, "reportListenerError", reportListenerError(s, timestamp, canForward)))
{
  if inv(s) && canReportListenerError(s) && !reportingLatched(s) && canForward {
    var frame := top(s);
    var fault := frame.failures[frame.reportCursor];
    var cursor := frame.reportCursor + 1;
    var phase := if frame.kind == heartbeatEmission then visitingListeners else if cursor < |frame.failures| then reportingErrors else readyToFinish;
    var progressed := withTop(frame.(reportCursor := cursor, phase := phase), s);
    var observed := progressed.(reported := s.reported + [fault]);
    var runId := if frame.kind == heartbeatEmission then "runtime" else frame.envelope.runId;
    var input := EventInput(runId, "", "error", fault.errorRef, "", "", timestamp);
    EventPushAgent(observed, input, agentDiagnostic, frame.envelope.emissionId, 0);
  }
}
