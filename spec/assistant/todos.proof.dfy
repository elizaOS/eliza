lemma KeysBridge(s: Todos)
  ensures alwaysKeysAreUnique(s) <==> ProofLib.DistinctBy(s.mutations, (o: MutationRecord) => o.key)
{
  var ms := s.mutations;
  assert alwaysKeysAreUnique(s) <==> forall m :: m in ms ==> |ProofLib.Filter((o: MutationRecord) => (o.key == m.key), ms)| == 1;
  forall i | 0 <= i < |ms|
    ensures |ProofLib.Filter((o: MutationRecord) => (o.key == ms[i].key), ms)| == 1 <==> forall j :: 0 <= j < |ms| && j != i ==> ms[j].key != ms[i].key
  {
    ProofLib.FilterCountOneIffUnique((o: MutationRecord) => (o.key == ms[i].key), ms, (o: MutationRecord) => o.key, i);
  }
  if ProofLib.DistinctBy(ms, (o: MutationRecord) => o.key) {
    forall m | m in ms ensures |ProofLib.Filter((o: MutationRecord) => (o.key == m.key), ms)| == 1 {
      var i :| 0 <= i < |ms| && ms[i] == m;
    }
  }
}

lemma IdsBridge(s: Todos)
  ensures alwaysTodoIdsAreUnique(s) <==> (forall t :: t in s.todos ==> t.todoId > 0 && t.todoId < s.nextId) && ProofLib.DistinctBy(s.todos, (o: Todo) => o.todoId)
{
  var ts := s.todos;
  assert alwaysTodoIdsAreUnique(s) <==> forall t :: t in ts ==> t.todoId > 0 && t.todoId < s.nextId && |ProofLib.Filter((o: Todo) => (o.todoId == t.todoId), ts)| == 1;
  forall i | 0 <= i < |ts|
    ensures |ProofLib.Filter((o: Todo) => (o.todoId == ts[i].todoId), ts)| == 1 <==> forall j :: 0 <= j < |ts| && j != i ==> ts[j].todoId != ts[i].todoId
  {
    ProofLib.FilterCountOneIffUnique((o: Todo) => (o.todoId == ts[i].todoId), ts, (o: Todo) => o.todoId, i);
  }
  if ProofLib.DistinctBy(ts, (o: Todo) => o.todoId) {
    forall t | t in ts ensures |ProofLib.Filter((o: Todo) => (o.todoId == t.todoId), ts)| == 1 {
      var i :| 0 <= i < |ts| && ts[i] == t;
    }
  }
}

lemma FreshStatusKey(s: Todos, key: string, request: TodoRequest, verdict: TodoOutcome, targetId: int, at: int)
  requires alwaysKeysAreUnique(s) && !replayed(s, key)
  ensures alwaysKeysAreUnique(recordStatusMutation(key, request, s, verdict, targetId, at))
  ensures recordStatusMutation(key, request, s, verdict, targetId, at).todos == s.todos
{
  KeysBridge(s);
  KeysBridge(recordStatusMutation(key, request, s, verdict, targetId, at));
  ProofLib.DistinctByConcat(s.mutations, [MutationRecord(key, request, targetId, at, verdict.Applied? && targetId > 0)], (o: MutationRecord) => o.key);
}

lemma FreshKey(s: Todos, key: string, request: TodoRequest, verdict: TodoOutcome)
  requires alwaysKeysAreUnique(s) && !replayed(s, key)
  ensures alwaysKeysAreUnique(recordMutation(key, request, s, verdict))
  ensures recordMutation(key, request, s, verdict).todos == s.todos
{
  FreshStatusKey(s, key, request, verdict, 0, 0);
}

lemma FilterKeepsTodos(s: Todos, p: Todo -> bool, after: Todos)
  requires inv(s) && after.todos == ProofLib.Filter(p, s.todos) && after.nextId == s.nextId
  ensures alwaysTodoIdsAreUnique(after) && alwaysCompletionTimeMatchesStatus(after)
{
  IdsBridge(s);
  IdsBridge(after);
  ProofLib.FilterKeepsDistinctBy(p, s.todos, (o: Todo) => o.todoId);
  ProofLib.FilterSubset(p, s.todos);
}

lemma ContentSplit(xs: seq<Todo>, content: string)
  ensures |ProofLib.Filter((t: Todo) => (t.content != content), xs)| + |ProofLib.Filter((t: Todo) => (t.content == content), xs)| == |xs|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil((t: Todo) => (t.content != content), xs);
    ProofLib.FilterNil((t: Todo) => (t.content == content), xs);
  } else {
    ProofLib.FilterCons((t: Todo) => (t.content != content), xs);
    ProofLib.FilterCons((t: Todo) => (t.content == content), xs);
    ContentSplit(xs[1..], content);
  }
}

lemma createTodo_ensures(s: Todos, key: string, content: string, affirmed: bool)
  ensures (inv(s) ==> canCreateTodo(s, key, content, affirmed) ==> alwaysKeysAreUnique(createTodo(s, key, content, affirmed)))
  ensures (inv(s) ==> canCreateTodo(s, key, content, affirmed) ==> alwaysTodoIdsAreUnique(createTodo(s, key, content, affirmed)))
  ensures (inv(s) ==> canCreateTodo(s, key, content, affirmed) ==> alwaysNextIdIsPositive(createTodo(s, key, content, affirmed)))
  ensures (inv(s) ==> canCreateTodo(s, key, content, affirmed) ==> alwaysCompletionTimeMatchesStatus(createTodo(s, key, content, affirmed)))
  ensures (inv(s) ==> canCreateTodo(s, key, content, affirmed) ==> stepNoChangeKeepsItems(s, createTodo(s, key, content, affirmed)))
  ensures (inv(s) ==> canCreateTodo(s, key, content, affirmed) ==> stepItemsLeaveOnlyByDeleteOrConfirmedClear(s, "createTodo", createTodo(s, key, content, affirmed)))
  ensures (inv(s) ==> canCreateTodo(s, key, content, affirmed) ==> stepClearKeepsUnpreviewedItems(s, "createTodo", createTodo(s, key, content, affirmed)))
{
  if inv(s) && canCreateTodo(s, key, content, affirmed) && !replayed(s, key) {
    var mid := s.(todos := (s.todos + [Todo(s.nextId, content, TodoStatus.TodoPending, 0)]), nextId := (s.nextId + 1));
    FreshKey(s, key, createRequest(content, affirmed), TodoOutcome.Duplicate);
    IdsBridge(s);
    IdsBridge(mid);
    ProofLib.DistinctByConcat(s.todos, [Todo(s.nextId, content, TodoStatus.TodoPending, 0)], (o: Todo) => o.todoId);
    FreshKey(mid, key, createRequest(content, affirmed), TodoOutcome.Applied);
  }
}

lemma setTodoStatus_ensures(s: Todos, key: string, content: string, targetId: int, status: TodoStatus, at: int)
  ensures (inv(s) ==> canSetTodoStatus(s, key, content, targetId, status, at) ==> alwaysKeysAreUnique(setTodoStatus(s, key, content, targetId, status, at)))
  ensures (inv(s) ==> canSetTodoStatus(s, key, content, targetId, status, at) ==> alwaysTodoIdsAreUnique(setTodoStatus(s, key, content, targetId, status, at)))
  ensures (inv(s) ==> canSetTodoStatus(s, key, content, targetId, status, at) ==> alwaysNextIdIsPositive(setTodoStatus(s, key, content, targetId, status, at)))
  ensures (inv(s) ==> canSetTodoStatus(s, key, content, targetId, status, at) ==> alwaysCompletionTimeMatchesStatus(setTodoStatus(s, key, content, targetId, status, at)))
  ensures (inv(s) ==> canSetTodoStatus(s, key, content, targetId, status, at) ==> stepNoChangeKeepsItems(s, setTodoStatus(s, key, content, targetId, status, at)))
  ensures (inv(s) ==> canSetTodoStatus(s, key, content, targetId, status, at) ==> stepItemsLeaveOnlyByDeleteOrConfirmedClear(s, "setTodoStatus", setTodoStatus(s, key, content, targetId, status, at)))
  ensures (inv(s) ==> canSetTodoStatus(s, key, content, targetId, status, at) ==> stepClearKeepsUnpreviewedItems(s, "setTodoStatus", setTodoStatus(s, key, content, targetId, status, at)))
{
  if inv(s) && canSetTodoStatus(s, key, content, targetId, status, at) && !replayed(s, key) {
    var request := statusRequest(content, targetId, status);
    var targets := statusTargets(s, content, targetId);
    if |targets| != 1 {
      FreshKey(s, key, request, TodoOutcome.Missed);
    } else {
      var target := targets[0];
      if target.todoStatus == status {
        var prior := if status.TodoCompleted? || status.TodoCancelled? then appliedStatusTime(s, request, target.todoId) else 0;
        if prior > 0 {
          FreshStatusKey(s, key, request, TodoOutcome.ReplayedStatus, target.todoId, prior);
        } else {
          FreshKey(s, key, request, TodoOutcome.AlreadySet);
        }
      } else {
        var mid := s.(todos := seq(|s.todos|, i requires 0 <= i < |s.todos| =>
          var t := s.todos[i]; if statusMatches(t, content, targetId) then t.(todoStatus := status, completedAt := (if status.TodoCompleted? then at else 0)) else t));
        IdsBridge(s);
        IdsBridge(mid);
        assert forall i :: 0 <= i < |s.todos| ==> mid.todos[i].todoId == s.todos[i].todoId;
        FreshStatusKey(mid, key, request, TodoOutcome.Applied, target.todoId, at);
      }
    }
  }
}

lemma renameTodo_ensures(s: Todos, key: string, content: string, renamed: string)
  ensures (inv(s) ==> canRenameTodo(s, key, content, renamed) ==> alwaysKeysAreUnique(renameTodo(s, key, content, renamed)))
  ensures (inv(s) ==> canRenameTodo(s, key, content, renamed) ==> alwaysTodoIdsAreUnique(renameTodo(s, key, content, renamed)))
  ensures (inv(s) ==> canRenameTodo(s, key, content, renamed) ==> alwaysNextIdIsPositive(renameTodo(s, key, content, renamed)))
  ensures (inv(s) ==> canRenameTodo(s, key, content, renamed) ==> alwaysCompletionTimeMatchesStatus(renameTodo(s, key, content, renamed)))
  ensures (inv(s) ==> canRenameTodo(s, key, content, renamed) ==> stepNoChangeKeepsItems(s, renameTodo(s, key, content, renamed)))
  ensures (inv(s) ==> canRenameTodo(s, key, content, renamed) ==> stepItemsLeaveOnlyByDeleteOrConfirmedClear(s, "renameTodo", renameTodo(s, key, content, renamed)))
  ensures (inv(s) ==> canRenameTodo(s, key, content, renamed) ==> stepClearKeepsUnpreviewedItems(s, "renameTodo", renameTodo(s, key, content, renamed)))
{
  if inv(s) && canRenameTodo(s, key, content, renamed) && !replayed(s, key) {
    var mid := s.(todos := (var s_map := s.todos; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var t := s_map[i_map]; (if (t.content == content) then t.(content := renamed) else t))));
    FreshKey(s, key, renameRequest(content, renamed), TodoOutcome.Missed);
    FreshKey(s, key, renameRequest(content, renamed), TodoOutcome.AlreadySet);
    IdsBridge(s);
    IdsBridge(mid);
    assert forall i :: 0 <= i < |s.todos| ==> mid.todos[i].todoId == s.todos[i].todoId;
    FreshKey(mid, key, renameRequest(content, renamed), TodoOutcome.Applied);
  }
}

lemma deleteTodo_ensures(s: Todos, key: string, content: string)
  ensures (inv(s) ==> canDeleteTodo(s, key, content) ==> alwaysKeysAreUnique(deleteTodo(s, key, content)))
  ensures (inv(s) ==> canDeleteTodo(s, key, content) ==> alwaysTodoIdsAreUnique(deleteTodo(s, key, content)))
  ensures (inv(s) ==> canDeleteTodo(s, key, content) ==> alwaysNextIdIsPositive(deleteTodo(s, key, content)))
  ensures (inv(s) ==> canDeleteTodo(s, key, content) ==> alwaysCompletionTimeMatchesStatus(deleteTodo(s, key, content)))
  ensures (inv(s) ==> canDeleteTodo(s, key, content) ==> stepNoChangeKeepsItems(s, deleteTodo(s, key, content)))
  ensures (inv(s) ==> canDeleteTodo(s, key, content) ==> stepItemsLeaveOnlyByDeleteOrConfirmedClear(s, "deleteTodo", deleteTodo(s, key, content)))
  ensures (inv(s) ==> canDeleteTodo(s, key, content) ==> stepClearKeepsUnpreviewedItems(s, "deleteTodo", deleteTodo(s, key, content)))
{
  if inv(s) && canDeleteTodo(s, key, content) && !replayed(s, key) {
    var mid := s.(todos := ProofLib.Filter((t: Todo) => (t.content != content), s.todos));
    FreshKey(s, key, deleteRequest(content), TodoOutcome.Missed);
    FilterKeepsTodos(s, (t: Todo) => (t.content != content), mid);
    ContentSplit(s.todos, content);
    FreshKey(mid, key, deleteRequest(content), TodoOutcome.Applied);
  }
}

lemma previewClear_ensures(s: Todos, key: string)
  ensures (inv(s) ==> canPreviewClear(s, key) ==> alwaysKeysAreUnique(previewClear(s, key)))
  ensures (inv(s) ==> canPreviewClear(s, key) ==> alwaysTodoIdsAreUnique(previewClear(s, key)))
  ensures (inv(s) ==> canPreviewClear(s, key) ==> alwaysNextIdIsPositive(previewClear(s, key)))
  ensures (inv(s) ==> canPreviewClear(s, key) ==> alwaysCompletionTimeMatchesStatus(previewClear(s, key)))
  ensures (inv(s) ==> canPreviewClear(s, key) ==> stepNoChangeKeepsItems(s, previewClear(s, key)))
  ensures (inv(s) ==> canPreviewClear(s, key) ==> stepItemsLeaveOnlyByDeleteOrConfirmedClear(s, "previewClear", previewClear(s, key)))
  ensures (inv(s) ==> canPreviewClear(s, key) ==> stepClearKeepsUnpreviewedItems(s, "previewClear", previewClear(s, key)))
{
  if inv(s) && canPreviewClear(s, key) && !replayed(s, key) {
    FreshKey(s.(clearPreviewed := true, previewIds := Std.Collections.Seq.FoldLeft((ids: seq<int>, t: Todo) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [t.todoId])), [], s.todos)), key, previewRequest, TodoOutcome.Applied);
  }
}

lemma confirmClear_ensures(s: Todos, key: string, affirmed: bool)
  ensures (inv(s) ==> canConfirmClear(s, key, affirmed) ==> alwaysKeysAreUnique(confirmClear(s, key, affirmed)))
  ensures (inv(s) ==> canConfirmClear(s, key, affirmed) ==> alwaysTodoIdsAreUnique(confirmClear(s, key, affirmed)))
  ensures (inv(s) ==> canConfirmClear(s, key, affirmed) ==> alwaysNextIdIsPositive(confirmClear(s, key, affirmed)))
  ensures (inv(s) ==> canConfirmClear(s, key, affirmed) ==> alwaysCompletionTimeMatchesStatus(confirmClear(s, key, affirmed)))
  ensures (inv(s) ==> canConfirmClear(s, key, affirmed) ==> stepNoChangeKeepsItems(s, confirmClear(s, key, affirmed)))
  ensures (inv(s) ==> canConfirmClear(s, key, affirmed) ==> stepItemsLeaveOnlyByDeleteOrConfirmedClear(s, "confirmClear", confirmClear(s, key, affirmed)))
  ensures (inv(s) ==> canConfirmClear(s, key, affirmed) ==> stepClearKeepsUnpreviewedItems(s, "confirmClear", confirmClear(s, key, affirmed)))
{
  if inv(s) && canConfirmClear(s, key, affirmed) && !replayed(s, key) {
    var kept := if affirmed then ProofLib.Filter((t: Todo) => !((t.todoId in s.previewIds)), s.todos) else s.todos;
    var mid := s.(clearPreviewed := false, previewIds := [], todos := kept);
    if affirmed {
      FilterKeepsTodos(s, (t: Todo) => !((t.todoId in s.previewIds)), mid);
      forall t | t in s.todos && !(t.todoId in s.previewIds) ensures t in kept {
        ProofLib.FilterMember((t: Todo) => !((t.todoId in s.previewIds)), s.todos, t);
      }
    }
    FreshKey(mid, key, confirmRequest(affirmed), TodoOutcome.Applied);
  }
}
