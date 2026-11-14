lemma LogRetentionFold(f: (seq<LogRecord>, LogRecord) -> seq<LogRecord>, logs: seq<LogRecord>, capacity: int, kept: seq<LogRecord>)
  requires capacity > 0 && |kept| <= capacity
  requires forall accumulated, entry :: |accumulated| <= capacity ==> |f(accumulated, entry)| <= capacity
  requires forall accumulated, entry, valueLog :: valueLog in f(accumulated, entry) ==> valueLog in accumulated || valueLog == entry
  ensures |Std.Collections.Seq.FoldLeft(f, kept, logs)| <= capacity
  ensures forall valueLog :: valueLog in Std.Collections.Seq.FoldLeft(f, kept, logs) ==> valueLog in kept || valueLog in logs
  decreases |logs|
{
  if |logs| > 0 {
    var advanced := f(kept, logs[0]);
    assert |advanced| <= capacity;
    LogRetentionFold(f, logs[1..], capacity, advanced);
    assert Std.Collections.Seq.FoldLeft(f, kept, logs) == Std.Collections.Seq.FoldLeft(f, advanced, logs[1..]);
    forall valueLog | valueLog in Std.Collections.Seq.FoldLeft(f, kept, logs)
      ensures valueLog in kept || valueLog in logs
    {
      if valueLog in advanced {
        assert valueLog in kept || valueLog == logs[0];
      }
    }
  }
}

lemma LogRetentionFacts(logs: seq<LogRecord>, capacity: int)
  requires capacity > 0
  ensures |retained(logs, capacity)| <= capacity
  ensures forall valueLog :: valueLog in retained(logs, capacity) ==> valueLog in logs
{
  var f := (kept: seq<LogRecord>, entry: LogRecord) => (if (capacity <= 0) then [] else (if (|kept| >= capacity) then ((if ((0 <= 0) && (0 < |kept|)) then (kept[0..0] + kept[(0 + 1)..]) else kept) + [entry]) else (kept + [entry])));
  forall accumulated, entry | |accumulated| <= capacity
    ensures |f(accumulated, entry)| <= capacity
  {}
  forall accumulated, entry, valueLog | valueLog in f(accumulated, entry)
    ensures valueLog in accumulated || valueLog == entry
  {}
  LogRetentionFold(f, logs, capacity, []);
}

lemma LogListenerFilter(s: LogSink)
  ensures alwaysListenerIdentityUnique(s) == (forall listener :: listener in s.listeners ==> listener != "" && |ProofLib.Filter((other: string) => (other == listener), s.listeners)| == 1)
{}

lemma LogRemovedListeners(s: LogSink, listener: string)
  ensures removeListener(s, listener).listeners == ProofLib.Filter((existing: string) => (existing != listener), s.listeners)
{}

lemma writeLog_ensures(s: LogSink, text: string)
  ensures (inv(s) ==> alwaysRetainedWithinCapacity(writeLog(s, text)))
  ensures (inv(s) ==> alwaysFreshEntryIdentities(writeLog(s, text)))
  ensures (inv(s) ==> alwaysListenerIdentityUnique(writeLog(s, text)))
  ensures (inv(s) ==> alwaysDeliveredListenersLeaveTheirFrame(writeLog(s, text)))
  ensures (inv(s) ==> alwaysWarningsNonnegative(writeLog(s, text)))
  ensures (inv(s) ==> alwaysDeliverySnapshotIdentity(writeLog(s, text)))
{
  if inv(s) {
    LogRetentionFacts(s.logs + [LogRecord(s.nextEntry, text)], s.capacity);
  }
}

lemma resize_ensures(s: LogSink, capacity: int)
  ensures (inv(s) ==> alwaysRetainedWithinCapacity(resize(s, capacity)))
  ensures (inv(s) ==> alwaysFreshEntryIdentities(resize(s, capacity)))
  ensures (inv(s) ==> alwaysListenerIdentityUnique(resize(s, capacity)))
  ensures (inv(s) ==> alwaysDeliveredListenersLeaveTheirFrame(resize(s, capacity)))
  ensures (inv(s) ==> alwaysWarningsNonnegative(resize(s, capacity)))
  ensures (inv(s) ==> alwaysDeliverySnapshotIdentity(resize(s, capacity)))
{
  if inv(s) && capacity > 0 { LogRetentionFacts(s.logs, capacity); }
}

lemma addListener_ensures(s: LogSink, listener: string)
  ensures (inv(s) ==> canAddListener(s, listener) ==> alwaysRetainedWithinCapacity(addListener(s, listener)))
  ensures (inv(s) ==> canAddListener(s, listener) ==> alwaysFreshEntryIdentities(addListener(s, listener)))
  ensures (inv(s) ==> canAddListener(s, listener) ==> alwaysListenerIdentityUnique(addListener(s, listener)))
  ensures (inv(s) ==> canAddListener(s, listener) ==> alwaysDeliveredListenersLeaveTheirFrame(addListener(s, listener)))
  ensures (inv(s) ==> canAddListener(s, listener) ==> alwaysWarningsNonnegative(addListener(s, listener)))
  ensures (inv(s) ==> canAddListener(s, listener) ==> alwaysDeliverySnapshotIdentity(addListener(s, listener)))
{
  if inv(s) && canAddListener(s, listener) {
    var after := addListener(s, listener);
    LogListenerFilter(s); LogListenerFilter(after);
    if !(listener in s.listeners) {
      forall candidate | candidate in after.listeners
        ensures candidate != "" && |ProofLib.Filter((other: string) => (other == candidate), after.listeners)| == 1
      {
        ProofLib.FilterAppend((other: string) => (other == candidate), s.listeners, listener);
        if candidate == listener {
          ProofLib.FilterNone((other: string) => (other == candidate), s.listeners);
        } else { assert candidate in s.listeners; }
      }
    }
  }
}

lemma removeListener_ensures(s: LogSink, listener: string)
  ensures (inv(s) ==> alwaysRetainedWithinCapacity(removeListener(s, listener)))
  ensures (inv(s) ==> alwaysFreshEntryIdentities(removeListener(s, listener)))
  ensures (inv(s) ==> alwaysListenerIdentityUnique(removeListener(s, listener)))
  ensures (inv(s) ==> alwaysDeliveredListenersLeaveTheirFrame(removeListener(s, listener)))
  ensures (inv(s) ==> alwaysWarningsNonnegative(removeListener(s, listener)))
  ensures (inv(s) ==> alwaysDeliverySnapshotIdentity(removeListener(s, listener)))
{
  if inv(s) {
    var after := removeListener(s, listener);
    LogListenerFilter(s); LogListenerFilter(after);
    LogRemovedListeners(s, listener);
    forall candidate | candidate in after.listeners
      ensures candidate != "" && |ProofLib.Filter((other: string) => (other == candidate), after.listeners)| == 1
    {
      ProofLib.FilterMember((existing: string) => (existing != listener), s.listeners, candidate);
      ProofLib.FilterOfFilterShorter((existing: string) => (existing != listener), (other: string) => (other == candidate), s.listeners);
      ProofLib.FilterMember((other: string) => (other == candidate), after.listeners, candidate);
    }
  }
}

lemma LogRemainingDistinct(xs: seq<string>)
  ensures (forall listener :: listener in xs ==> |ProofLib.Filter((other: string) => (other == listener), xs)| == 1) <==> ProofLib.DistinctBy(xs, (x: string) => x)
{
  if forall listener :: listener in xs ==> |ProofLib.Filter((other: string) => (other == listener), xs)| == 1 {
    forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j ensures xs[i] != xs[j] {
      var listener := xs[i];
      assert listener in xs;
      assert |ProofLib.Filter((other: string) => (other == listener), xs)| == 1;
      if xs[i] == xs[j] {
        ProofLib.FilterTwo((other: string) => (other == listener), xs, i, j);
      }
    }
  } else if ProofLib.DistinctBy(xs, (x: string) => x) {
    forall listener | listener in xs ensures |ProofLib.Filter((other: string) => (other == listener), xs)| == 1 {
      var i :| 0 <= i < |xs| && xs[i] == listener;
      ProofLib.FilterOne((other: string) => (other == listener), xs, i);
    }
  }
}

lemma LogSnapshotTail(xs: seq<string>)
  requires |xs| > 0
  requires forall listener :: listener in xs ==> listener != "" && |ProofLib.Filter((other: string) => (other == listener), xs)| == 1
  ensures !(xs[0] in xs[1..])
  ensures forall listener :: listener in xs[1..] ==> listener != "" && |ProofLib.Filter((other: string) => (other == listener), xs[1..])| == 1
{
  LogRemainingDistinct(xs); LogRemainingDistinct(xs[1..]);
  forall i, j | 0 <= i < |xs[1..]| && 0 <= j < |xs[1..]| && i != j ensures xs[1..][i] != xs[1..][j] {
    assert xs[1..][i] == xs[i + 1] && xs[1..][j] == xs[j + 1];
  }
  if xs[0] in xs[1..] {
    var i :| 0 <= i < |xs[1..]| && xs[1..][i] == xs[0];
    assert xs[i + 1] == xs[0];
  }
  forall listener | listener in xs[1..] ensures listener != "" {
    assert listener in xs;
  }
}

lemma LogSnapshotFilters(s: LogSink)
  ensures alwaysDeliverySnapshotIdentity(s) == (forall frame :: frame in s.deliveries ==> ((forall listener :: listener in frame.remaining ==> listener != "" && |ProofLib.Filter((other: string) => (other == listener), frame.remaining)| == 1) && (frame.active != "" ==> !(frame.active in frame.remaining)) && !("" in frame.delivered)))
{}

lemma startCallback_ensures(s: LogSink)
  ensures (inv(s) ==> canStartCallback(s) ==> alwaysRetainedWithinCapacity(startCallback(s)))
  ensures (inv(s) ==> canStartCallback(s) ==> alwaysFreshEntryIdentities(startCallback(s)))
  ensures (inv(s) ==> canStartCallback(s) ==> alwaysListenerIdentityUnique(startCallback(s)))
  ensures (inv(s) ==> canStartCallback(s) ==> alwaysDeliveredListenersLeaveTheirFrame(startCallback(s)))
  ensures (inv(s) ==> canStartCallback(s) ==> alwaysWarningsNonnegative(startCallback(s)))
  ensures (inv(s) ==> canStartCallback(s) ==> alwaysDeliverySnapshotIdentity(startCallback(s)))
{
  if inv(s) && canStartCallback(s) {
    var frame := topDelivery(s);
    assert frame in s.deliveries;
    LogSnapshotFilters(s);
    LogSnapshotTail(frame.remaining);
    var after := startCallback(s);
    assert after.deliveries[|after.deliveries| - 1].remaining == frame.remaining[1..];
    assert |after.deliveries| == |s.deliveries|;
    forall i | 0 <= i < |after.deliveries|
      ensures i < |after.deliveries| - 1 ==> after.deliveries[i] == s.deliveries[i]
    {
      if i < |after.deliveries| - 1 { assert after.deliveries[i] == s.deliveries[i]; }
    }
  }
}

lemma finishCallback_ensures(s: LogSink, succeeded: bool)
  ensures (inv(s) ==> canFinishCallback(s, succeeded) ==> alwaysRetainedWithinCapacity(finishCallback(s, succeeded)))
  ensures (inv(s) ==> canFinishCallback(s, succeeded) ==> alwaysFreshEntryIdentities(finishCallback(s, succeeded)))
  ensures (inv(s) ==> canFinishCallback(s, succeeded) ==> alwaysListenerIdentityUnique(finishCallback(s, succeeded)))
  ensures (inv(s) ==> canFinishCallback(s, succeeded) ==> alwaysDeliveredListenersLeaveTheirFrame(finishCallback(s, succeeded)))
  ensures (inv(s) ==> canFinishCallback(s, succeeded) ==> alwaysWarningsNonnegative(finishCallback(s, succeeded)))
  ensures (inv(s) ==> canFinishCallback(s, succeeded) ==> alwaysDeliverySnapshotIdentity(finishCallback(s, succeeded)))
{
  if inv(s) && canFinishCallback(s, succeeded) {
    var frame := topDelivery(s);
    assert frame in s.deliveries;
    assert !(frame.active in frame.remaining);
    assert frame.active != "";
    assert !(frame.active in frame.delivered);
    assert !("" in frame.delivered);
    LogFinishParts(s, succeeded);
    ProofLib.FilterCons((set_x: string) => !((set_x in frame.delivered)), [frame.active]);
    ProofLib.FilterNil((set_x: string) => !((set_x in frame.delivered)), []);
    var after := finishCallback(s, succeeded);
    assert after.deliveries[|after.deliveries| - 1].remaining == frame.remaining;
    assert after.deliveries[|after.deliveries| - 1].active == "";
    assert after.deliveries[|after.deliveries| - 1].delivered == frame.delivered + [frame.active];
    assert !("" in after.deliveries[|after.deliveries| - 1].delivered);
    forall listener | listener in frame.remaining
      ensures !(listener in after.deliveries[|after.deliveries| - 1].delivered)
    {}
    assert |after.deliveries| == |s.deliveries|;
    forall i | 0 <= i < |after.deliveries|
      ensures i < |after.deliveries| - 1 ==> after.deliveries[i] == s.deliveries[i]
    {
      if i < |after.deliveries| - 1 { assert after.deliveries[i] == s.deliveries[i]; }
    }
  }
}

lemma LogFinishParts(s: LogSink, succeeded: bool)
  requires canFinishCallback(s, succeeded)
  ensures topDelivery(finishCallback(s, succeeded)).delivered == topDelivery(s).delivered + ProofLib.Filter((set_x: string) => !((set_x in topDelivery(s).delivered)), [topDelivery(s).active])
{}
