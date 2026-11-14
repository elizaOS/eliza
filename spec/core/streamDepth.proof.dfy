lemma StreamDepthFacts(s: StreamDepth)
  ensures alwaysContinuationIdentity(s) ==
    (forall row :: row in s.continuations ==> |ProofLib.Filter((other: ChunkContinuation) => other.id == row.id, s.continuations)| == 1)
  ensures alwaysDepthNonnegative(s) ==
    (forall row :: row in s.continuations ==> (row.depth >= 0 && (forall level :: level in row.stack ==> level >= 0)))
{}

lemma StreamDepthAppend(s: StreamDepth, after: StreamDepth, added: ChunkContinuation)
  requires inv(s)
  requires after.continuations == s.continuations + [added]
  requires added.depth >= 0 && |added.stack| == 0
  requires forall row :: row in s.continuations ==> row.id != added.id
  ensures alwaysDepthNonnegative(after) && alwaysContinuationIdentity(after)
{
  StreamDepthFacts(s);
  StreamDepthFacts(after);
  forall row | row in after.continuations
    ensures row.depth >= 0 && (forall level :: level in row.stack ==> level >= 0)
    ensures |ProofLib.Filter((other: ChunkContinuation) => other.id == row.id, after.continuations)| == 1
  {
    var matches := (candidate: ChunkContinuation) => candidate.id == row.id;
    ProofLib.FilterAppend(matches, s.continuations, added);
    if row == added { ProofLib.FilterNone(matches, s.continuations); }
    else { assert row in s.continuations; }
  }
}

lemma StreamDepthMap(s: StreamDepth, after: StreamDepth)
  requires inv(s)
  requires |after.continuations| == |s.continuations|
  requires forall i :: 0 <= i < |s.continuations| ==>
    (after.continuations[i].id == s.continuations[i].id && after.continuations[i].depth >= 0 &&
     (forall level :: level in after.continuations[i].stack ==> level >= 0))
  ensures alwaysDepthNonnegative(after) && alwaysContinuationIdentity(after)
{
  StreamDepthFacts(s);
  StreamDepthFacts(after);
  forall row | row in after.continuations
    ensures row.depth >= 0 && (forall level :: level in row.stack ==> level >= 0)
    ensures |ProofLib.Filter((other: ChunkContinuation) => other.id == row.id, after.continuations)| == 1
  {
    var index :| 0 <= index < |after.continuations| && after.continuations[index] == row;
    assert s.continuations[index] in s.continuations;
    var matches := (candidate: ChunkContinuation) => candidate.id == row.id;
    ProofLib.FilterLengthPointwise(matches, matches, s.continuations, after.continuations);
  }
}

lemma createRoot_ensures(s: StreamDepth, id: string)
  ensures (inv(s) ==> canCreateRoot(s, id) ==> alwaysDepthNonnegative(createRoot(s, id)))
  ensures (inv(s) ==> canCreateRoot(s, id) ==> alwaysContinuationIdentity(createRoot(s, id)))
{
  if inv(s) && canCreateRoot(s, id) {
    StreamDepthAppend(s, createRoot(s, id), ChunkContinuation(id, 0, []));
  }
}

lemma fork_ensures(s: StreamDepth, parentId: string, childId: string)
  ensures (inv(s) ==> canFork(s, parentId, childId) ==> alwaysDepthNonnegative(fork(s, parentId, childId)))
  ensures (inv(s) ==> canFork(s, parentId, childId) ==> alwaysContinuationIdentity(fork(s, parentId, childId)))
{
  if inv(s) && canFork(s, parentId, childId) {
    var matches := (candidate: ChunkContinuation) => candidate.id == parentId;
    var parents := ProofLib.Filter(matches, s.continuations);
    StreamDepthFacts(s);
    if |parents| > 0 {
      assert parents[0] in parents;
      ProofLib.FilterMember(matches, s.continuations, parents[0]);
      assert parents[0].depth >= 0;
    }
    StreamDepthAppend(s, fork(s, parentId, childId), ChunkContinuation(childId, chunkDepth(s, parentId), []));
  }
}

lemma lawEnterThenLeave_ensures(s: StreamDepth, id: string)
  ensures (lawEnterThenLeave(s, id) == true)
{
  var entered := enterChunk(s, id);
  var after := leaveChunk(entered, id);
  forall i | 0 <= i < |s.continuations| ensures after.continuations[i] == s.continuations[i] {
    var prior := s.continuations[i];
    if prior.id == id {
      var pushed := entered.continuations[i];
      assert pushed.stack == prior.stack + [prior.depth];
      assert pushed.stack[|prior.stack|] == prior.depth;
      assert pushed.stack[..|prior.stack|] == prior.stack;
    }
  }
  assert after.continuations == s.continuations;
}

lemma lawPeerDepthStable_ensures(s: StreamDepth, id: string, peerId: string)
  ensures (lawPeerDepthStable(s, id, peerId) == true)
{
  if id != peerId {
    var entered := enterChunk(s, id);
    var matches := (candidate: ChunkContinuation) => candidate.id == peerId;
    forall i | 0 <= i < |s.continuations|
      ensures matches(s.continuations[i]) == matches(entered.continuations[i])
      ensures matches(s.continuations[i]) ==> s.continuations[i].depth == entered.continuations[i].depth
    {}
    ProofLib.FilterPointwise(matches, matches, (left: ChunkContinuation, right: ChunkContinuation) => matches(left) ==> left.depth == right.depth, s.continuations, entered.continuations);
    var beforeRows := ProofLib.Filter(matches, s.continuations);
    var afterRows := ProofLib.Filter(matches, entered.continuations);
    if |beforeRows| > 0 {
      assert beforeRows[0] in beforeRows;
      ProofLib.FilterMember(matches, s.continuations, beforeRows[0]);
      assert beforeRows[0].depth == afterRows[0].depth;
    }
  }
}

lemma enterChunk_ensures(s: StreamDepth, id: string)
  ensures (inv(s) ==> canEnterChunk(s, id) ==> alwaysDepthNonnegative(enterChunk(s, id)))
  ensures (inv(s) ==> canEnterChunk(s, id) ==> alwaysContinuationIdentity(enterChunk(s, id)))
{
  if inv(s) && canEnterChunk(s, id) {
    var after := enterChunk(s, id);
    StreamDepthFacts(s);
    forall i | 0 <= i < |s.continuations|
      ensures after.continuations[i].id == s.continuations[i].id
      ensures after.continuations[i].depth >= 0
      ensures forall level :: level in after.continuations[i].stack ==> level >= 0
    {
      var prior := s.continuations[i];
      assert prior in s.continuations;
      if prior.id == id {
        assert after.continuations[i].stack == prior.stack + [prior.depth];
      }
    }
    StreamDepthMap(s, after);
  }
}

lemma leaveChunk_ensures(s: StreamDepth, id: string)
  ensures (inv(s) ==> canLeaveChunk(s, id) ==> alwaysDepthNonnegative(leaveChunk(s, id)))
  ensures (inv(s) ==> canLeaveChunk(s, id) ==> alwaysContinuationIdentity(leaveChunk(s, id)))
{
  if inv(s) && canLeaveChunk(s, id) {
    var after := leaveChunk(s, id);
    StreamDepthFacts(s);
    forall i | 0 <= i < |s.continuations|
      ensures after.continuations[i].id == s.continuations[i].id
      ensures after.continuations[i].depth >= 0
      ensures forall level :: level in after.continuations[i].stack ==> level >= 0
    {
      var prior := s.continuations[i];
      assert prior in s.continuations;
      if prior.id == id && |prior.stack| > 0 {
        var updated := after.continuations[i];
        assert prior.stack[|prior.stack| - 1] in prior.stack;
        assert prior.stack[|prior.stack|..] == [];
        assert updated.stack == prior.stack[..|prior.stack| - 1];
        forall level | level in updated.stack ensures level >= 0 {
          assert level in prior.stack;
        }
      } else {
        assert after.continuations[i] == prior;
      }
    }
    StreamDepthMap(s, after);
  }
}
