// Proofs that every request the server answers keeps its rules. `request`
// appends one entry to the log, through `commit` when it applies the edit and
// through `refusal` when not; `CommitKeeps` and `RefusalKeeps` do the work.

// The rules, with ProofLib.Filter in place of the opaque library filter.
lemma VersionBridge(s: Server)
  ensures alwaysTheVersionCountsTheChanges(s) == (s.version == |ProofLib.Filter((h: Answered) => h.ok, s.log)|)
{ }

lemma OnceBridge(s: Server)
  ensures alwaysNoRequestIsAnsweredTwice(s) == !(exists a :: a in s.log && !(|ProofLib.Filter((b: Answered) => ((b.client == a.client) && (b.seq_ == a.seq_)), s.log)| == 1))
{ }

lemma IdsBridge(s: Server)
  ensures alwaysIdsAreUnique(s) == !(exists t :: t in s.todos && !(|ProofLib.Filter((u: todo_Todo) => (u.id == t.id), s.todos)| == 1))
{ }

// A log entry for a request the log does not hold keeps every request answered once.
lemma OnceAppend(log: seq<Answered>, x: Answered)
  requires !(exists a :: a in log && !(|ProofLib.Filter((b: Answered) => ((b.client == a.client) && (b.seq_ == a.seq_)), log)| == 1))
  requires forall h :: h in log ==> !((h.client == x.client) && (h.seq_ == x.seq_))
  ensures !(exists a :: a in log + [x] && !(|ProofLib.Filter((b: Answered) => ((b.client == a.client) && (b.seq_ == a.seq_)), log + [x])| == 1))
{
  var log2 := log + [x];
  forall i | 0 <= i < |log2|
    ensures |ProofLib.Filter((b: Answered) => ((b.client == log2[i].client) && (b.seq_ == log2[i].seq_)), log2)| == 1
  {
    var a := log2[i];
    var p := (b: Answered) => ((b.client == a.client) && (b.seq_ == a.seq_));
    ProofLib.FilterAppend(p, log, x);
    if i < |log| {
      assert a == log[i];
      assert a in log;
      assert |ProofLib.Filter(p, log)| == 1;
      assert !p(x);
    } else {
      assert a == x;
      ProofLib.FilterNone(p, log);
      assert forall j :: 0 <= j < |log| ==> !p(log[j]) by {
        forall j | 0 <= j < |log| ensures !p(log[j]) { assert log[j] in log; }
      }
    }
  }
}

// A to-do with an id the list does not hold keeps ids unique.
lemma IdsAppend(todos: seq<todo_Todo>, x: todo_Todo)
  requires !(exists t :: t in todos && !(|ProofLib.Filter((u: todo_Todo) => (u.id == t.id), todos)| == 1))
  requires forall t :: t in todos ==> t.id != x.id
  ensures !(exists t :: t in todos + [x] && !(|ProofLib.Filter((u: todo_Todo) => (u.id == t.id), todos + [x])| == 1))
{
  var all := todos + [x];
  forall i | 0 <= i < |all|
    ensures |ProofLib.Filter((u: todo_Todo) => (u.id == all[i].id), all)| == 1
  {
    var a := all[i];
    var p := (u: todo_Todo) => (u.id == a.id);
    ProofLib.FilterAppend(p, todos, x);
    if i < |todos| {
      assert a == todos[i];
      assert a in todos;
      assert |ProofLib.Filter(p, todos)| == 1;
      assert !p(x);
    } else {
      assert a == x;
      ProofLib.FilterNone(p, todos);
      assert forall j :: 0 <= j < |todos| ==> !p(todos[j]) by {
        forall j | 0 <= j < |todos| ensures !p(todos[j]) { assert todos[j] in todos; }
      }
    }
  }
}

// An edit other than a creation keeps every id where it was, and every removed to-do removed.
lemma IdsEdit(todos: seq<todo_Todo>, op: todo_Op)
  requires op.kind != "create"
  requires !(exists t :: t in todos && !(|ProofLib.Filter((u: todo_Todo) => (u.id == t.id), todos)| == 1))
  ensures |todo_applyOp(todos, op)| == |todos|
  ensures forall i :: 0 <= i < |todos| ==> todo_applyOp(todos, op)[i].id == todos[i].id
  ensures forall i :: 0 <= i < |todos| ==> todos[i].deleted ==> todo_applyOp(todos, op)[i].deleted
  ensures !(exists t :: t in todo_applyOp(todos, op) && !(|ProofLib.Filter((u: todo_Todo) => (u.id == t.id), todo_applyOp(todos, op))| == 1))
{
  var after := todo_applyOp(todos, op);
  assert |after| == |todos|;
  forall i | 0 <= i < |todos| ensures after[i].id == todos[i].id && (todos[i].deleted ==> after[i].deleted) { }
  forall i | 0 <= i < |after|
    ensures |ProofLib.Filter((u: todo_Todo) => (u.id == after[i].id), after)| == 1
  {
    var p := (u: todo_Todo) => (u.id == todos[i].id);
    var q := (u: todo_Todo) => (u.id == after[i].id);
    ProofLib.FilterLengthPointwise(p, q, todos, after);
    assert |ProofLib.Filter(p, todos)| == 1;
  }
}

lemma CommitKeeps(s: Server, client: string, seq_: int, op: todo_Op)
  requires inv(s) && allows(s, client, seq_, op)
  ensures alwaysTheVersionCountsTheChanges(commit(client, s, seq_, op))
  ensures alwaysNoRequestIsAnsweredTwice(commit(client, s, seq_, op))
  ensures alwaysIdsAreUnique(commit(client, s, seq_, op))
  ensures stepNoToDoIsForgotten(s, commit(client, s, seq_, op))
{
  var after := commit(client, s, seq_, op);
  var x := Answered(client, seq_, op, true);
  VersionBridge(s);
  VersionBridge(after);
  ProofLib.FilterAppend((h: Answered) => h.ok, s.log, x);
  OnceBridge(s);
  OnceBridge(after);
  OnceAppend(s.log, x);
  IdsBridge(s);
  IdsBridge(after);
  if op.kind == "create" {
    var t := todo_Todo(op.id, op.title, false, false);
    IdsAppend(s.todos, t);
    assert after.todos == s.todos + [t];
    forall i | 0 <= i < |s.todos| ensures exists u :: u in after.todos && u.id == s.todos[i].id && (u.deleted || !s.todos[i].deleted) {
      assert after.todos[i] in after.todos;
    }
  } else {
    IdsEdit(s.todos, op);
    forall i | 0 <= i < |s.todos| ensures exists u :: u in after.todos && u.id == s.todos[i].id && (u.deleted || !s.todos[i].deleted) {
      assert after.todos[i] in after.todos;
    }
  }
}

lemma request_ensures(s: Server, client: string, seq_: int, op: todo_Op)
  ensures (inv(s) ==> canRequest(s, client, seq_) ==> alwaysTheVersionCountsTheChanges(request(s, client, seq_, op)))
  ensures (inv(s) ==> canRequest(s, client, seq_) ==> alwaysNoRequestIsAnsweredTwice(request(s, client, seq_, op)))
  ensures (inv(s) ==> canRequest(s, client, seq_) ==> alwaysIdsAreUnique(request(s, client, seq_, op)))
  ensures (inv(s) ==> canRequest(s, client, seq_) ==> stepEachRequestRaisesTheVersionByAtMostOne(s, request(s, client, seq_, op)))
  ensures (inv(s) ==> canRequest(s, client, seq_) ==> stepNoToDoIsForgotten(s, request(s, client, seq_, op)))
{
  if inv(s) && canRequest(s, client, seq_) { RequestKeeps(s, client, seq_, op); }
}

lemma RequestKeeps(s: Server, client: string, seq_: int, op: todo_Op)
  requires inv(s) && canRequest(s, client, seq_)
  ensures alwaysTheVersionCountsTheChanges(request(s, client, seq_, op))
  ensures alwaysNoRequestIsAnsweredTwice(request(s, client, seq_, op))
  ensures alwaysIdsAreUnique(request(s, client, seq_, op))
  ensures stepNoToDoIsForgotten(s, request(s, client, seq_, op))
{
  if allows(s, client, seq_, op) { CommitKeeps(s, client, seq_, op); } else { RefusalKeeps(s, client, seq_, op); }
}

lemma RefusalKeeps(s: Server, client: string, seq_: int, op: todo_Op)
  requires inv(s) && !answered(s, client, seq_)
  ensures alwaysTheVersionCountsTheChanges(refusal(client, s, seq_, op))
  ensures alwaysNoRequestIsAnsweredTwice(refusal(client, s, seq_, op))
  ensures alwaysIdsAreUnique(refusal(client, s, seq_, op))
  ensures stepNoToDoIsForgotten(s, refusal(client, s, seq_, op))
{
  var after := refusal(client, s, seq_, op);
  var x := Answered(client, seq_, op, false);
  VersionBridge(s);
  VersionBridge(after);
  ProofLib.FilterAppend((h: Answered) => h.ok, s.log, x);
  OnceBridge(s);
  OnceBridge(after);
  OnceAppend(s.log, x);
  assert after.todos == s.todos;
  forall i | 0 <= i < |s.todos| ensures exists u :: u in after.todos && u.id == s.todos[i].id && (u.deleted || !s.todos[i].deleted) {
    assert after.todos[i] in after.todos;
  }
}

lemma lawARequestKeepsTheRules_ensures(s: Server, client: string, seq_: int, op: todo_Op)
  ensures (lawARequestKeepsTheRules(s, client, seq_, op) == true)
{
  if rulesHold(s) && canRequest(s, client, seq_) { RequestKeeps(s, client, seq_, op); }
}
