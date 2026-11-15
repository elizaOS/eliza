// Proofs that the queue keeps its numbering rules. A user edit appends an
// edit numbered one above every number given before; an answer filters the
// queue, which keeps what was true of each edit left in it.

lemma DistinctBridge(c: Client)
  ensures alwaysQueuedEditsHaveDistinctNumbers(c) == !(exists p :: p in c.pending && !(|ProofLib.Filter((q: Pending) => (q.seq_ == p.seq_), c.pending)| == 1))
{ }

lemma WithoutBridge(ps: seq<Pending>, seq_: int)
  ensures without(ps, seq_) == ProofLib.Filter((p: Pending) => (p.seq_ != seq_), ps)
{ }

lemma queue_ensures(c: Client, op: todo_Op)
  ensures (inv(c) ==> canQueue(c, op) ==> alwaysEveryQueuedEditWasNumberedHere(queue(c, op)))
  ensures (inv(c) ==> canQueue(c, op) ==> alwaysQueuedEditsHaveDistinctNumbers(queue(c, op)))
  ensures (inv(c) ==> canQueue(c, op) ==> alwaysTheEditCountIsNotNegative(queue(c, op)))
  ensures (inv(c) ==> canQueue(c, op) ==> alwaysTheConfirmedVersionIsNotNegative(queue(c, op)))
  ensures (inv(c) ==> canQueue(c, op) ==> stepTheConfirmedVersionNeverGoesBack(c, queue(c, op)))
  ensures (inv(c) ==> canQueue(c, op) ==> stepASnapshotLeavesTheQueueAlone(c, "queue", queue(c, op)))
{
  if inv(c) {
    var after := queue(c, op);
    var x := Pending(c.made + 1, op);
    assert after.pending == c.pending + [x];
    assert forall p :: p in c.pending ==> p.seq_ <= c.made by {
      forall p | p in c.pending ensures p.seq_ <= c.made {
        var i :| 0 <= i < |c.pending| && c.pending[i] == p;
      }
    }
    DistinctBridge(c);
    DistinctBridge(after);
    var all := after.pending;
    forall i | 0 <= i < |all|
      ensures |ProofLib.Filter((q: Pending) => (q.seq_ == all[i].seq_), all)| == 1
    {
      var a := all[i];
      var p := (q: Pending) => (q.seq_ == a.seq_);
      ProofLib.FilterAppend(p, c.pending, x);
      if i < |c.pending| {
        assert a == c.pending[i];
        assert a in c.pending;
        assert |ProofLib.Filter(p, c.pending)| == 1;
        assert !p(x);
      } else {
        assert a == x;
        ProofLib.FilterNone(p, c.pending);
        assert forall j :: 0 <= j < |c.pending| ==> !p(c.pending[j]) by {
          forall j | 0 <= j < |c.pending| ensures !p(c.pending[j]) { assert c.pending[j] in c.pending; }
        }
      }
    }
  }
}

// Taking edits out of the queue keeps both numbering rules.
lemma FilterKeeps(c: Client, d: Client, seq_: int)
  requires inv(c)
  requires d.pending == without(c.pending, seq_) && d.made == c.made
  ensures alwaysEveryQueuedEditWasNumberedHere(d)
  ensures alwaysQueuedEditsHaveDistinctNumbers(d)
{
  var r := (p: Pending) => (p.seq_ != seq_);
  WithoutBridge(c.pending, seq_);
  var kept := d.pending;
  assert kept == ProofLib.Filter(r, c.pending);
  ProofLib.FilterSubset(r, c.pending);
  forall i | 0 <= i < |kept| ensures kept[i] in c.pending { }
  forall i | 0 <= i < |kept| ensures kept[i].seq_ >= 1 && kept[i].seq_ <= d.made {
    var j :| 0 <= j < |c.pending| && c.pending[j] == kept[i];
  }
  DistinctBridge(c);
  DistinctBridge(d);
  forall i | 0 <= i < |kept|
    ensures |ProofLib.Filter((q: Pending) => (q.seq_ == kept[i].seq_), kept)| == 1
  {
    var a := kept[i];
    var same := (q: Pending) => (q.seq_ == a.seq_);
    var j :| 0 <= j < |c.pending| && c.pending[j] == a;
    assert |ProofLib.Filter(same, c.pending)| == 1;
    ProofLib.FilterOfFilterShorter(r, same, c.pending);
    ProofLib.FilterMember(same, kept, a);
    assert a in ProofLib.Filter(same, kept);
  }
}

lemma receiveAck_ensures(c: Client, seq_: int, version: int, todos: seq<todo_Todo>)
  ensures (inv(c) ==> canReceiveAck(c, seq_, version, todos) ==> alwaysEveryQueuedEditWasNumberedHere(receiveAck(c, seq_, version, todos)))
  ensures (inv(c) ==> canReceiveAck(c, seq_, version, todos) ==> alwaysQueuedEditsHaveDistinctNumbers(receiveAck(c, seq_, version, todos)))
  ensures (inv(c) ==> canReceiveAck(c, seq_, version, todos) ==> alwaysTheEditCountIsNotNegative(receiveAck(c, seq_, version, todos)))
  ensures (inv(c) ==> canReceiveAck(c, seq_, version, todos) ==> alwaysTheConfirmedVersionIsNotNegative(receiveAck(c, seq_, version, todos)))
  ensures (inv(c) ==> canReceiveAck(c, seq_, version, todos) ==> stepTheConfirmedVersionNeverGoesBack(c, receiveAck(c, seq_, version, todos)))
  ensures (inv(c) ==> canReceiveAck(c, seq_, version, todos) ==> stepASnapshotLeavesTheQueueAlone(c, "receiveAck", receiveAck(c, seq_, version, todos)))
{
  if inv(c) { FilterKeeps(c, receiveAck(c, seq_, version, todos), seq_); }
}

lemma receiveRefusal_ensures(c: Client, seq_: int, version: int, todos: seq<todo_Todo>)
  ensures (inv(c) ==> canReceiveRefusal(c, seq_, version, todos) ==> alwaysEveryQueuedEditWasNumberedHere(receiveRefusal(c, seq_, version, todos)))
  ensures (inv(c) ==> canReceiveRefusal(c, seq_, version, todos) ==> alwaysQueuedEditsHaveDistinctNumbers(receiveRefusal(c, seq_, version, todos)))
  ensures (inv(c) ==> canReceiveRefusal(c, seq_, version, todos) ==> alwaysTheEditCountIsNotNegative(receiveRefusal(c, seq_, version, todos)))
  ensures (inv(c) ==> canReceiveRefusal(c, seq_, version, todos) ==> alwaysTheConfirmedVersionIsNotNegative(receiveRefusal(c, seq_, version, todos)))
  ensures (inv(c) ==> canReceiveRefusal(c, seq_, version, todos) ==> stepTheConfirmedVersionNeverGoesBack(c, receiveRefusal(c, seq_, version, todos)))
  ensures (inv(c) ==> canReceiveRefusal(c, seq_, version, todos) ==> stepASnapshotLeavesTheQueueAlone(c, "receiveRefusal", receiveRefusal(c, seq_, version, todos)))
{
  if inv(c) { FilterKeeps(c, receiveRefusal(c, seq_, version, todos), seq_); }
}
