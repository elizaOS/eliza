lemma admit_ensures(t: TopicService, capturedGeneration: int, callId: string, readOnly: bool, incoming: seq<string>)
  ensures (inv(t) ==> canAdmit(t, capturedGeneration, callId, readOnly, incoming) ==> alwaysOnlyHeadIsActive(admit(t, capturedGeneration, callId, readOnly, incoming)))
  ensures (inv(t) ==> canAdmit(t, capturedGeneration, callId, readOnly, incoming) ==> alwaysTopicCapacity(admit(t, capturedGeneration, callId, readOnly, incoming)))
  ensures (inv(t) ==> canAdmit(t, capturedGeneration, callId, readOnly, incoming) ==> alwaysTopicCacheOwnership(admit(t, capturedGeneration, callId, readOnly, incoming)))
  ensures (inv(t) ==> canAdmit(t, capturedGeneration, callId, readOnly, incoming) ==> alwaysUnhydratedHasNoCache(admit(t, capturedGeneration, callId, readOnly, incoming)))
  ensures (inv(t) ==> canAdmit(t, capturedGeneration, callId, readOnly, incoming) ==> alwaysCallIdsUnique(admit(t, capturedGeneration, callId, readOnly, incoming)))
  ensures (inv(t) ==> canAdmit(t, capturedGeneration, callId, readOnly, incoming) ==> alwaysQueueOwnsCalls(admit(t, capturedGeneration, callId, readOnly, incoming)))
  ensures (inv(t) ==> canAdmit(t, capturedGeneration, callId, readOnly, incoming) ==> alwaysRetiredServiceJoined(admit(t, capturedGeneration, callId, readOnly, incoming)))
  ensures (inv(t) ==> canAdmit(t, capturedGeneration, callId, readOnly, incoming) ==> alwaysActiveCallMatchesHydration(admit(t, capturedGeneration, callId, readOnly, incoming)))
{
  if inv(t) && canAdmit(t, capturedGeneration, callId, readOnly, incoming) {
    var after := admit(t, capturedGeneration, callId, readOnly, incoming);
    var added := TopicCall(callId, readOnly, incoming, TopicCallPhase.TopicQueued, []);
    TopicCallKeys(t);
    assert callId !in t.queue by {
      if callId in t.queue { var own :| own in t.calls && own.id == callId && !callFinished(own); }
    }
    ProofLib.DistinctByConcat(t.calls, [added], (call: TopicCall) => call.id);
    TopicCallKeys(after);
    TopicQueueDistinct(t.queue);
    ProofLib.DistinctByConcat(t.queue, [callId], (id: string) => id);
    TopicQueueDistinct(after.queue);
    forall id | id in after.queue ensures exists call :: call in after.calls && call.id == id && !callFinished(call) {
      if id != callId { var own :| own in t.calls && own.id == id && !callFinished(own); }
    }
  }
}

lemma claimHead_ensures(t: TopicService)
  ensures (inv(t) ==> canClaimHead(t) ==> alwaysOnlyHeadIsActive(claimHead(t)))
  ensures (inv(t) ==> canClaimHead(t) ==> alwaysTopicCapacity(claimHead(t)))
  ensures (inv(t) ==> canClaimHead(t) ==> alwaysTopicCacheOwnership(claimHead(t)))
  ensures (inv(t) ==> canClaimHead(t) ==> alwaysUnhydratedHasNoCache(claimHead(t)))
  ensures (inv(t) ==> canClaimHead(t) ==> alwaysCallIdsUnique(claimHead(t)))
  ensures (inv(t) ==> canClaimHead(t) ==> alwaysQueueOwnsCalls(claimHead(t)))
  ensures (inv(t) ==> canClaimHead(t) ==> alwaysRetiredServiceJoined(claimHead(t)))
  ensures (inv(t) ==> canClaimHead(t) ==> alwaysActiveCallMatchesHydration(claimHead(t)))
{
  if inv(t) && canClaimHead(t) {
    var phase := if t.hydrated then TopicCallPhase.TopicReady else TopicCallPhase.HydratingTopics;
    TopicHead(t);
    TopicChangedHead(t, claimHead(t), phase, [], false);
  }
}

lemma hydrate_ensures(t: TopicService, hydration: TopicHydration)
  ensures (inv(t) ==> canHydrate(t, hydration) ==> alwaysOnlyHeadIsActive(hydrate(t, hydration)))
  ensures (inv(t) ==> canHydrate(t, hydration) ==> alwaysTopicCapacity(hydrate(t, hydration)))
  ensures (inv(t) ==> canHydrate(t, hydration) ==> alwaysTopicCacheOwnership(hydrate(t, hydration)))
  ensures (inv(t) ==> canHydrate(t, hydration) ==> alwaysUnhydratedHasNoCache(hydrate(t, hydration)))
  ensures (inv(t) ==> canHydrate(t, hydration) ==> alwaysCallIdsUnique(hydrate(t, hydration)))
  ensures (inv(t) ==> canHydrate(t, hydration) ==> alwaysQueueOwnsCalls(hydrate(t, hydration)))
  ensures (inv(t) ==> canHydrate(t, hydration) ==> alwaysRetiredServiceJoined(hydrate(t, hydration)))
  ensures (inv(t) ==> canHydrate(t, hydration) ==> alwaysActiveCallMatchesHydration(hydrate(t, hydration)))
{
  if inv(t) && canHydrate(t, hydration) {
    TopicHead(t);
    var succeeded := hydrationSucceeded(hydration);
    var phase := if succeeded then TopicCallPhase.TopicReady else TopicCallPhase.TopicFailed;
    TopicChangedHead(t, hydrate(t, hydration), phase, [], !succeeded);
  }
}

lemma persist_ensures(t: TopicService, persistence: TopicPersistence)
  ensures (inv(t) ==> canPersist(t) ==> alwaysOnlyHeadIsActive(persist(t, persistence)))
  ensures (inv(t) ==> canPersist(t) ==> alwaysTopicCapacity(persist(t, persistence)))
  ensures (inv(t) ==> canPersist(t) ==> alwaysTopicCacheOwnership(persist(t, persistence)))
  ensures (inv(t) ==> canPersist(t) ==> alwaysUnhydratedHasNoCache(persist(t, persistence)))
  ensures (inv(t) ==> canPersist(t) ==> alwaysCallIdsUnique(persist(t, persistence)))
  ensures (inv(t) ==> canPersist(t) ==> alwaysQueueOwnsCalls(persist(t, persistence)))
  ensures (inv(t) ==> canPersist(t) ==> alwaysRetiredServiceJoined(persist(t, persistence)))
  ensures (inv(t) ==> canPersist(t) ==> alwaysActiveCallMatchesHydration(persist(t, persistence)))
{
  if inv(t) && canPersist(t) {
    TopicHead(t);
    var phase := if persistence.TopicCommitted? then TopicCallPhase.TopicSaved else if persistence.TopicRoomMissing? then TopicCallPhase.TopicMissingRoom else TopicCallPhase.TopicFailed;
    TopicChangedHead(t, persist(t, persistence), phase, headCall(t).result, true);
  }
}

lemma start_ensures(t: TopicService)
  ensures (inv(t) ==> canStart(t) ==> alwaysOnlyHeadIsActive(start(t)))
  ensures (inv(t) ==> canStart(t) ==> alwaysTopicCapacity(start(t)))
  ensures (inv(t) ==> canStart(t) ==> alwaysTopicCacheOwnership(start(t)))
  ensures (inv(t) ==> canStart(t) ==> alwaysUnhydratedHasNoCache(start(t)))
  ensures (inv(t) ==> canStart(t) ==> alwaysCallIdsUnique(start(t)))
  ensures (inv(t) ==> canStart(t) ==> alwaysQueueOwnsCalls(start(t)))
  ensures (inv(t) ==> canStart(t) ==> alwaysRetiredServiceJoined(start(t)))
  ensures (inv(t) ==> canStart(t) ==> alwaysActiveCallMatchesHydration(start(t)))
{
  if inv(t) && canStart(t) {
    TopicHead(t);
    var own := headCall(t);
    if own.readOnly {
      TopicChangedHead(t, start(t), TopicCallPhase.TopicRead, t.localTopics, true);
    } else {
      TopicFoldCapacity(t.localTopics, own.incoming);
      var f := (topics: seq<string>, topic: string) => refreshTopic(topics, topic);
      var updated := Std.Collections.Seq.FoldLeft(f, t.localTopics, own.incoming);
      TopicChangedHead(t, start(t), TopicCallPhase.PersistingTopics, updated, false);
    }
  }
}

lemma advanceRoom_ensures(t: TopicService, hydration: TopicHydration, persistence: TopicPersistence)
  ensures (inv(t) ==> canAdvanceRoom(t, hydration) ==> alwaysOnlyHeadIsActive(advanceRoom(t, hydration, persistence)))
  ensures (inv(t) ==> canAdvanceRoom(t, hydration) ==> alwaysTopicCapacity(advanceRoom(t, hydration, persistence)))
  ensures (inv(t) ==> canAdvanceRoom(t, hydration) ==> alwaysTopicCacheOwnership(advanceRoom(t, hydration, persistence)))
  ensures (inv(t) ==> canAdvanceRoom(t, hydration) ==> alwaysUnhydratedHasNoCache(advanceRoom(t, hydration, persistence)))
  ensures (inv(t) ==> canAdvanceRoom(t, hydration) ==> alwaysCallIdsUnique(advanceRoom(t, hydration, persistence)))
  ensures (inv(t) ==> canAdvanceRoom(t, hydration) ==> alwaysQueueOwnsCalls(advanceRoom(t, hydration, persistence)))
  ensures (inv(t) ==> canAdvanceRoom(t, hydration) ==> alwaysRetiredServiceJoined(advanceRoom(t, hydration, persistence)))
  ensures (inv(t) ==> canAdvanceRoom(t, hydration) ==> alwaysActiveCallMatchesHydration(advanceRoom(t, hydration, persistence)))
{
  if inv(t) && canAdvanceRoom(t, hydration) {
    if canClaimHead(t) { claimHead_ensures(t); }
    else if isHydrating(t) { hydrate_ensures(t, hydration); }
    else if canStart(t) { start_ensures(t); }
    else { persist_ensures(t, persistence); }
  }
}

lemma TopicCallKeys(t: TopicService)
  ensures alwaysCallIdsUnique(t) <==> ProofLib.DistinctBy(t.calls, (call: TopicCall) => call.id) && (forall call :: call in t.calls ==> call.id != "")
{
  var key := (call: TopicCall) => call.id;
  if alwaysCallIdsUnique(t) {
    forall i, j | 0 <= i < |t.calls| && 0 <= j < |t.calls| && i != j ensures key(t.calls[i]) != key(t.calls[j]) {
      var matches := (other: TopicCall) => other.id == t.calls[i].id;
      ProofLib.FilterCountOneIffUnique(matches, t.calls, key, i);
    }
  } else if ProofLib.DistinctBy(t.calls, key) && (forall call :: call in t.calls ==> call.id != "") {
    forall call | call in t.calls ensures |ProofLib.Filter((other: TopicCall) => other.id == call.id, t.calls)| == 1 {
      var i :| 0 <= i < |t.calls| && t.calls[i] == call;
      ProofLib.FilterCountOneIffUnique((other: TopicCall) => other.id == call.id, t.calls, key, i);
    }
  }
}

lemma TopicQueueDistinct(queue: seq<string>)
  ensures ProofLib.DistinctBy(queue, (id: string) => id) <==>
    (forall id :: id in queue ==> |ProofLib.Filter((other: string) => other == id, queue)| == 1)
{
  var key := (id: string) => id;
  if ProofLib.DistinctBy(queue, key) {
    forall id | id in queue ensures |ProofLib.Filter((other: string) => other == id, queue)| == 1 {
      var i :| 0 <= i < |queue| && queue[i] == id;
      ProofLib.FilterCountOneIffUnique((other: string) => other == id, queue, key, i);
    }
  } else if forall id :: id in queue ==> |ProofLib.Filter((other: string) => other == id, queue)| == 1 {
    forall i, j | 0 <= i < |queue| && 0 <= j < |queue| && i != j ensures queue[i] != queue[j] {
      assert queue[i] in queue;
      var matches := (other: string) => other == queue[i];
      assert |ProofLib.Filter(matches, queue)| == 1;
      ProofLib.FilterCountOneIffUnique(matches, queue, key, i);
    }
  }
}

lemma TopicHead(t: TopicService)
  requires inv(t) && roomEligible(t)
  ensures |t.queue| > 0 && headCall(t) in t.calls && headCall(t).id == t.queue[0]
  ensures t.owner != TopicOwner.Retired
{
  var id := if |t.queue| > 0 then t.queue[0] else "";
  var matches := (call: TopicCall) => call.id == id;
  var rows := ProofLib.Filter(matches, t.calls);
  assert |rows| > 0 by {
    if |rows| == 0 { assert headCall(t) == noCall; }
  }
  ProofLib.FilterMember(matches, t.calls, rows[0]);
  assert headCall(t) == rows[0];
}

lemma TopicChangedHead(before: TopicService, after: TopicService, phase: TopicCallPhase, result: seq<string>, popped: bool)
  requires inv(before) && roomEligible(before)
  requires |result| <= 20
  requires |before.queue| > 0 && headCall(before) in before.calls && headCall(before).id == before.queue[0]
  requires |after.calls| == |before.calls|
  requires after.queue == (if popped then before.queue[1..] else before.queue)
  requires forall i :: 0 <= i < |before.calls| ==> after.calls[i] == withHeadPhase(before.calls[i], before.queue[0], phase, result)
  requires callFinished(withHeadPhase(headCall(before), before.queue[0], phase, result)) == popped
  ensures alwaysCallIdsUnique(after)
  ensures alwaysQueueOwnsCalls(after)
  ensures forall call :: call in after.calls ==> |call.result| <= 20
{
  TopicCallKeys(before);
  TopicQueueDistinct(before.queue);
  if popped {
    assert ProofLib.DistinctBy(after.queue, (id: string) => id) by {
      forall i, j | 0 <= i < |after.queue| && 0 <= j < |after.queue| && i != j ensures after.queue[i] != after.queue[j] {
        assert after.queue[i] == before.queue[i+1] && after.queue[j] == before.queue[j+1];
      }
    }
  }
  TopicQueueDistinct(after.queue);
  var id := before.queue[0];
  assert ProofLib.DistinctBy(after.calls, (call: TopicCall) => call.id) by {
    forall i, j | 0 <= i < |after.calls| && 0 <= j < |after.calls| && i != j ensures after.calls[i].id != after.calls[j].id {
      assert after.calls[i].id == before.calls[i].id;
      assert after.calls[j].id == before.calls[j].id;
    }
  }
  forall call | call in after.calls ensures call.id != "" && |call.result| <= 20 {
    var i :| 0 <= i < |after.calls| && after.calls[i] == call;
    assert before.calls[i] in before.calls;
  }
  TopicCallKeys(after);
  forall queueId | queueId in after.queue ensures exists call :: call in after.calls && call.id == queueId && !callFinished(call) {
    assert queueId in before.queue by {
      if popped {
        var qi :| 0 <= qi < |after.queue| && after.queue[qi] == queueId;
        assert before.queue[qi+1] == queueId;
      }
    }
    var own :| own in before.calls && own.id == queueId && !callFinished(own);
    var i :| 0 <= i < |before.calls| && before.calls[i] == own;
    if queueId == id {
      assert !popped by {
        if popped {
          var j :| 0 <= j < |after.queue| && after.queue[j] == queueId;
          assert before.queue[j + 1] == before.queue[0];
        }
      }
      assert !callFinished(after.calls[i]);
    } else {
      assert after.calls[i] == own;
    }
    assert after.calls[i] in after.calls;
  }
  forall call | call in after.calls && !callFinished(call) ensures call.id in after.queue {
    var i :| 0 <= i < |after.calls| && after.calls[i] == call;
    var own := before.calls[i];
    if call.id == id {
      assert !popped;
    } else {
      assert own == call && own in before.calls;
      assert call.id in before.queue;
      if popped {
        var j :| 0 <= j < |before.queue| && before.queue[j] == call.id;
        assert 0 <= j - 1 < |after.queue| && after.queue[j-1] == call.id;
      }
    }
  }
}

lemma TopicRefreshCapacity(topics: seq<string>, topic: string)
  requires |topics| <= 20
  ensures |refreshTopic(topics, topic)| <= 20
{
  if topic != "" {
    var keep := (previous: string) => previous != topic;
    ProofLib.FilterImpLength(keep, (previous: string) => true, topics);
    ProofLib.FilterSamePredicate((previous: string) => true, (previous: string) => previous == previous, topics);
    TopicIdentityFilter(topics);
  }
}

lemma TopicIdentityFilter(topics: seq<string>)
  ensures ProofLib.Filter((previous: string) => true, topics) == topics
  decreases |topics|
{
  if |topics| == 0 {
    ProofLib.FilterNil((previous: string) => true, topics);
  } else {
    ProofLib.FilterCons((previous: string) => true, topics);
    TopicIdentityFilter(topics[1..]);
    assert topics == [topics[0]] + topics[1..];
  }
}

lemma TopicFoldCapacity(topics: seq<string>, incoming: seq<string>)
  requires |topics| <= 20
  ensures |Std.Collections.Seq.FoldLeft((topics: seq<string>, topic: string) => refreshTopic(topics, topic), topics, incoming)| <= 20
  decreases |incoming|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |incoming| > 0 {
    TopicRefreshCapacity(topics, incoming[0]);
    TopicFoldCapacity(refreshTopic(topics, incoming[0]), incoming[1..]);
  }
}
