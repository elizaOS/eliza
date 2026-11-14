lemma receivePage_ensures(s: TaskReader, ticket: int, incoming: TaskPage, readSucceeded: bool)
  ensures (inv(s) ==> canReceivePage(s, ticket) ==> alwaysTimerOwnsLiveReader(receivePage(s, ticket, incoming, readSucceeded)))
  ensures (inv(s) ==> canReceivePage(s, ticket) ==> alwaysPendingHasOwner(receivePage(s, ticket, incoming, readSucceeded)))
  ensures (inv(s) ==> canReceivePage(s, ticket) ==> alwaysReaderPhaseOwnsPending(receivePage(s, ticket, incoming, readSucceeded)))
  ensures (inv(s) ==> canReceivePage(s, ticket) ==> alwaysFinishRearmIsValid(receivePage(s, ticket, incoming, readSucceeded)))
  ensures (inv(s) ==> canReceivePage(s, ticket) ==> alwaysRetainedHistoryValid(receivePage(s, ticket, incoming, readSucceeded)))
{
  if inv(s) && canReceivePage(s, ticket) && readSucceeded && acceptsPage(s.task, s.page, incoming) {
    var input := s.page.events + incoming.events;
    var accepted := mergedEvents(s.task, s.page.events, incoming.events);
    assert accepted.valid;
    assert incoming.task == s.task;
    TaskHistoryFoldDefinition(s.task, input);
    assert mergedEvents(s.task, [], input) == accepted;
    TaskHistoryFoldReplay(s.task, input);
    assert mergedEvents(s.task, [], accepted.events) == accepted;
    assert mergedEvents(incoming.task, [], accepted.events).valid;
  }
}

lemma TaskHistoryFoldReplay(task: string, input: seq<TaskEvent>)
  ensures mergedEvents(task, [], input).valid ==> mergedEvents(task, [], mergedEvents(task, [], input).events) == mergedEvents(task, [], input)
  decreases |input|
{
  if |input| > 0 {
    var prefix := input[..|input|-1];
    var lastEvent := input[|input|-1];
    var merge := (merged: MergeState, activity: TaskEvent) => appendEvent(merged, task, activity);
    var start := MergeState([], true);
    assert input == prefix + [lastEvent];
    ProofLib.FoldLeftAppend(merge, start, prefix, lastEvent);
    var before := mergedEvents(task, [], prefix);
    var after := mergedEvents(task, [], input);
    TaskHistoryFoldDefinition(task, prefix);
    TaskHistoryFoldDefinition(task, input);
    assert merge == ((merged: MergeState, activity: TaskEvent) => appendEvent(merged, task, activity));
    assert after == appendEvent(before, task, lastEvent);
    if after.valid {
      assert before.valid;
      TaskHistoryFoldReplay(task, prefix);
      if after.events == before.events {
        assert mergedEvents(task, [], after.events) == before;
        assert after == before;
      } else {
        assert after.events == before.events + [lastEvent];
        ProofLib.FoldLeftAppend(merge, start, before.events, lastEvent);
        TaskHistoryFoldDefinition(task, before.events);
        TaskHistoryFoldDefinition(task, after.events);
        assert mergedEvents(task, [], before.events) == before;
        assert mergedEvents(task, [], after.events) == appendEvent(before, task, lastEvent);
      }
    }
  }
}

lemma TaskHistoryFoldDefinition(task: string, input: seq<TaskEvent>)
  ensures mergedEvents(task, [], input) == Std.Collections.Seq.FoldLeft((merged: MergeState, activity: TaskEvent) => appendEvent(merged, task, activity), MergeState([], true), input)
{
  assert [] + input == input;
}
