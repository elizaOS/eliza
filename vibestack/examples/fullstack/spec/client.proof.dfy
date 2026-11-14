// Proofs that the queue keeps its numbering rules. A user edit appends an
// edit numbered one above every number given before; an answer filters the
// queue, which keeps what was true of each edit left in it.

lemma DistinctBridge(c: Client)
  ensures alwaysQueuedEditsHaveDistinctNumbers(c) == !(exists p :: p in c.pending && !(|ProofLib.Filter((q: Pending) => (q.seq_ == p.seq_), c.pending)| == 1))
{ }

lemma WithoutBridge(ps: seq<Pending>, seq_: int)
  ensures without(ps, seq_) == ProofLib.Filter((p: Pending) => (p.seq_ != seq_), ps)
{ }

lemma QueueKeeps(op: todo_Op, c: Client)
  requires inv(c)
  ensures alwaysEveryQueuedEditWasNumberedHere(queue(op, c))
  ensures alwaysQueuedEditsHaveDistinctNumbers(queue(op, c))
  ensures alwaysTheEditCountIsNotNegative(queue(op, c))
{
  var after := queue(op, c);
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

lemma create_ensures(c: Client, id: string, title: string)
  ensures (inv(c) ==> canCreate(c, id, title) ==> alwaysEveryQueuedEditWasNumberedHere(create(c, id, title)))
  ensures (inv(c) ==> canCreate(c, id, title) ==> alwaysQueuedEditsHaveDistinctNumbers(create(c, id, title)))
  ensures (inv(c) ==> canCreate(c, id, title) ==> alwaysTheEditCountIsNotNegative(create(c, id, title)))
  ensures (inv(c) ==> canCreate(c, id, title) ==> alwaysTheConfirmedVersionIsNotNegative(create(c, id, title)))
  ensures (inv(c) ==> canCreate(c, id, title) ==> stepTheConfirmedVersionNeverGoesBack(c, create(c, id, title)))
  ensures (inv(c) ==> canCreate(c, id, title) ==> stepASnapshotLeavesTheQueueAlone(c, "create", create(c, id, title)))
{
  if inv(c) { QueueKeeps(todo_Op("create", id, title, false), c); }
}

lemma setDone_ensures(c: Client, id: string, done: bool)
  ensures (inv(c) ==> canSetDone(c, id, done) ==> alwaysEveryQueuedEditWasNumberedHere(setDone(c, id, done)))
  ensures (inv(c) ==> canSetDone(c, id, done) ==> alwaysQueuedEditsHaveDistinctNumbers(setDone(c, id, done)))
  ensures (inv(c) ==> canSetDone(c, id, done) ==> alwaysTheEditCountIsNotNegative(setDone(c, id, done)))
  ensures (inv(c) ==> canSetDone(c, id, done) ==> alwaysTheConfirmedVersionIsNotNegative(setDone(c, id, done)))
  ensures (inv(c) ==> canSetDone(c, id, done) ==> stepTheConfirmedVersionNeverGoesBack(c, setDone(c, id, done)))
  ensures (inv(c) ==> canSetDone(c, id, done) ==> stepASnapshotLeavesTheQueueAlone(c, "setDone", setDone(c, id, done)))
{
  if inv(c) { QueueKeeps(todo_Op("done", id, "", done), c); }
}

lemma rename_ensures(c: Client, id: string, title: string)
  ensures (inv(c) ==> canRename(c, id, title) ==> alwaysEveryQueuedEditWasNumberedHere(rename(c, id, title)))
  ensures (inv(c) ==> canRename(c, id, title) ==> alwaysQueuedEditsHaveDistinctNumbers(rename(c, id, title)))
  ensures (inv(c) ==> canRename(c, id, title) ==> alwaysTheEditCountIsNotNegative(rename(c, id, title)))
  ensures (inv(c) ==> canRename(c, id, title) ==> alwaysTheConfirmedVersionIsNotNegative(rename(c, id, title)))
  ensures (inv(c) ==> canRename(c, id, title) ==> stepTheConfirmedVersionNeverGoesBack(c, rename(c, id, title)))
  ensures (inv(c) ==> canRename(c, id, title) ==> stepASnapshotLeavesTheQueueAlone(c, "rename", rename(c, id, title)))
{
  if inv(c) { QueueKeeps(todo_Op("rename", id, title, false), c); }
}

lemma remove_ensures(c: Client, id: string)
  ensures (inv(c) ==> canRemove(c, id) ==> alwaysEveryQueuedEditWasNumberedHere(remove(c, id)))
  ensures (inv(c) ==> canRemove(c, id) ==> alwaysQueuedEditsHaveDistinctNumbers(remove(c, id)))
  ensures (inv(c) ==> canRemove(c, id) ==> alwaysTheEditCountIsNotNegative(remove(c, id)))
  ensures (inv(c) ==> canRemove(c, id) ==> alwaysTheConfirmedVersionIsNotNegative(remove(c, id)))
  ensures (inv(c) ==> canRemove(c, id) ==> stepTheConfirmedVersionNeverGoesBack(c, remove(c, id)))
  ensures (inv(c) ==> canRemove(c, id) ==> stepASnapshotLeavesTheQueueAlone(c, "remove", remove(c, id)))
{
  if inv(c) { QueueKeeps(todo_Op("remove", id, "", false), c); }
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

lemma lawQueueingKeepsTheRules_ensures(c: Client, op: todo_Op)
  ensures (lawQueueingKeepsTheRules(c, op) == true)
{
  if rulesHold(c) { QueueKeeps(op, c); }
}

lemma lawAnAnswerKeepsTheRules_ensures(c: Client, seq_: int, version: int, todos: seq<todo_Todo>)
  ensures (lawAnAnswerKeepsTheRules(c, seq_, version, todos) == true)
{
  if rulesHold(c) {
    FilterKeeps(c, receiveAck(c, seq_, version, todos), seq_);
    FilterKeeps(c, receiveRefusal(c, seq_, version, todos), seq_);
  }
}
