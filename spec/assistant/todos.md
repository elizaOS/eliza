# To-dos

The owner's to-do list: items that are pending, in progress, completed or
cancelled. The agent changes it on the owner's behalf through mutations,
each carrying an idempotency key, so a retried request never applies
twice. A mutation that names an item by its text applies only when exactly
one item matches. This machine follows one owner's list.

## Story: Keep my to-do list as I asked, once

> As an owner, I want my to-dos changed exactly as I asked, renamed when
> I say so, never twice for a retried request, never on a guess between
> two items, and never cleared without my confirmation.

### A mutation is applied once per idempotency key

A key seen before with the same request confirms it was recorded and
changes nothing. A key seen before with a different request is refused.

```quint
type TodoStatus = TodoPending | TodoInProgress | TodoCompleted | TodoCancelled
type Todo = { todoId: int, content: str, todoStatus: TodoStatus, completedAt: int }
type TodoOp = CreateOp | StatusOp | RenameOp | DeleteOp | PreviewClearOp | ConfirmClearOp
type TodoRequest = { op: TodoOp, requestContent: str, requestItem: int, requestStatus: TodoStatus, affirmed: bool, requestRenamed: str }
type MutationRecord = { key: str, request: TodoRequest, statusItemId: int, statusAppliedAt: int, appliedStatus: bool }
type TodoOutcome = NoOutcome | Applied | Missed | Duplicate | AlreadySet | ReplayedStatus
type Todos = { todos: List[Todo], nextId: int, mutations: List[MutationRecord], clearPreviewed: bool, previewIds: Set[int], lastOutcome: TodoOutcome }
pure val initial: Todos = { todos: List(), nextId: 1, mutations: List(), clearPreviewed: false, previewIds: Set(), lastOutcome: NoOutcome }
pure val keyValues = Set("k1", "k2", "k3", "k4", "k5")
pure val contentValues = Set("milk", "call mom")
pure def keyAdmits(s: Todos, key: str, request: TodoRequest): bool = s.mutations.every(m => m.key != key or m.request == request)
pure def replayed(s: Todos, key: str): bool = s.mutations.some(m => m.key == key)
pure def recordStatusMutation(key: str, request: TodoRequest, s: Todos, verdict: TodoOutcome, itemId: int, appliedAt: int): Todos =
  { ...s, mutations: s.mutations.append({ key: key, request: request, statusItemId: itemId, statusAppliedAt: appliedAt, appliedStatus: verdict == Applied and itemId > 0 }), lastOutcome: verdict }
pure def recordMutation(key: str, request: TodoRequest, s: Todos, verdict: TodoOutcome): Todos =
  recordStatusMutation(key, request, s, verdict, 0, 0)
pure def alwaysKeysAreUnique(s: Todos): bool = s.mutations.every(m => s.mutations.select(o => o.key == m.key).length() == 1)
```

### An item is added unless an open item already says the same, unless the owner confirms the duplicate

Each new item takes the next id, counting up from one, so no two items
share an id. An open item says the same when its text matches apart from
case, punctuation and spacing: the shell then asks about the new item
with that open item's text, so "buy milk." is a duplicate of "Buy milk".

```quint
pure def createRequest(content: str, affirmed: bool): TodoRequest = { op: CreateOp, requestContent: content, requestItem: 0, requestStatus: TodoPending, affirmed: affirmed, requestRenamed: "" }
pure def openWith(s: Todos, content: str): bool = s.todos.some(t => t.content == content and (t.todoStatus == TodoPending or t.todoStatus == TodoInProgress))
pure def canCreateTodo(s: Todos, key: str, content: str, affirmed: bool): bool = keyAdmits(s, key, createRequest(content, affirmed))
pure def createTodo(s: Todos, key: str, content: str, affirmed: bool): Todos =
  if (replayed(s, key)) s
  else if (openWith(s, content) and not(affirmed)) recordMutation(key, createRequest(content, affirmed), s, Duplicate)
  else recordMutation(key, createRequest(content, affirmed), { ...s, todos: s.todos.append({ todoId: s.nextId, content: content, todoStatus: TodoPending, completedAt: 0 }), nextId: s.nextId + 1 }, Applied)
pure def alwaysTodoIdsAreUnique(s: Todos): bool = s.todos.every(t => t.todoId > 0 and t.todoId < s.nextId and s.todos.select(o => o.todoId == t.todoId).length() == 1)
pure def alwaysNextIdIsPositive(s: Todos): bool = s.nextId > 0
```

### A change by text applies only when exactly one item matches

The owner's words name an item by its t-N reference, or by its text
apart from case, punctuation and spacing, so "complete buy milk" names
"Buy milk."; the change then carries that item's exact text, and words
that match several different texts change nothing and ask which one was
meant. An item matches only when its text is the text of the change, so a
change never lands on a near miss: "Read the new" never names "Read the
news", and "Pay water bill" never names "Pay electricity bill". When no
item or several items match, nothing changes and the result names the
miss, with the candidates when there are several. If the one
matching item already has the requested status, or a rename already has
the new text, the request is recorded and the item stays as it was. A
rename gives the one matching item its new, nonblank text and keeps its
status.

An exact t-N status request uses that item even if another to-do has the
same title. When a completion or cancellation changes nothing, it is a
replayed result only if an earlier applied request in this owner's list
had the same selector and status and changed that exact item. The item's
value and completion time stay as they were. An older mutation record
without an item and applied time cannot prove a replay.

```quint
pure def matching(s: Todos, content: str): List[Todo] = s.todos.select(t => t.content == content)
pure def statusMatches(t: Todo, content: str, targetId: int): bool = if (targetId > 0) t.todoId == targetId else t.content == content
pure def statusTargets(s: Todos, content: str, targetId: int): List[Todo] = s.todos.select(t => statusMatches(t, content, targetId))
pure def statusRequest(content: str, targetId: int, status: TodoStatus): TodoRequest = { op: StatusOp, requestContent: content, requestItem: targetId, requestStatus: status, affirmed: false, requestRenamed: "" }
pure def appliedStatusTime(s: Todos, request: TodoRequest, itemId: int): int =
  s.mutations.foldl(0, (time, m) => if (m.appliedStatus and m.request == request and m.statusItemId == itemId) m.statusAppliedAt else time)
pure def canSetTodoStatus(s: Todos, key: str, content: str, targetId: int, status: TodoStatus, at: int): bool =
  targetId >= 0 and keyAdmits(s, key, statusRequest(content, targetId, status)) and at > 0
pure def setUniqueTodoStatus(key: str, request: TodoRequest, target: Todo, at: int, s: Todos): Todos = {
  val status = request.requestStatus
  val prior = if (status == TodoCompleted or status == TodoCancelled) appliedStatusTime(s, request, target.todoId) else 0
  if (target.todoStatus != status) recordStatusMutation(key, request,
    { ...s, todos: s.todos.listMap(t => if (statusMatches(t, request.requestContent, request.requestItem)) { ...t, todoStatus: status, completedAt: if (status == TodoCompleted) at else 0 } else t) },
    Applied, target.todoId, at)
  else if (prior > 0) recordStatusMutation(key, request, s, ReplayedStatus, target.todoId, prior)
  else recordMutation(key, request, s, AlreadySet)
}
pure def setTodoStatus(s: Todos, key: str, content: str, targetId: int, status: TodoStatus, at: int): Todos = {
  val request = statusRequest(content, targetId, status)
  val targets = statusTargets(s, content, targetId)
  if (replayed(s, key)) s
  else if (targets.length() != 1) recordMutation(key, request, s, Missed)
  else setUniqueTodoStatus(key, request, targets.nth(0), at, s)
}
pure val targetIdValues = Set(0, 1, 2, 3)
pure val renamedValues = Set("oat milk", "milk")
pure def renameRequest(content: str, renamed: str): TodoRequest = { op: RenameOp, requestContent: content, requestItem: 0, requestStatus: TodoPending, affirmed: false, requestRenamed: renamed }
pure def canRenameTodo(s: Todos, key: str, content: str, renamed: str): bool = keyAdmits(s, key, renameRequest(content, renamed)) and renamed != ""
pure def renameTodo(s: Todos, key: str, content: str, renamed: str): Todos =
  if (replayed(s, key)) s
  else if (matching(s, content).length() != 1) recordMutation(key, renameRequest(content, renamed), s, Missed)
  else if (renamed == content) recordMutation(key, renameRequest(content, renamed), s, AlreadySet)
  else recordMutation(key, renameRequest(content, renamed), { ...s, todos: s.todos.listMap(t => if (t.content == content) { ...t, content: renamed } else t) }, Applied)
pure def deleteRequest(content: str): TodoRequest = { op: DeleteOp, requestContent: content, requestItem: 0, requestStatus: TodoPending, affirmed: false, requestRenamed: "" }
pure def canDeleteTodo(s: Todos, key: str, content: str): bool = keyAdmits(s, key, deleteRequest(content))
pure def deleteTodo(s: Todos, key: str, content: str): Todos =
  if (replayed(s, key)) s
  else if (matching(s, content).length() != 1) recordMutation(key, deleteRequest(content), s, Missed)
  else recordMutation(key, deleteRequest(content), { ...s, todos: s.todos.select(t => t.content != content) }, Applied)
pure def stepNoChangeKeepsItems(before: Todos, after: Todos): bool =
  ((after.lastOutcome == Missed or after.lastOutcome == AlreadySet or after.lastOutcome == ReplayedStatus)
    and after.mutations.length() > before.mutations.length()) implies after.todos == before.todos
pure def sometimesStatusAlreadySet(s: Todos): bool = s.lastOutcome == AlreadySet
```

### An item's completion time is set exactly while it is completed

The completion time is the instant the owner's change completed it, so an
evening brief can tell what was finished today; reopening or cancelling
the item clears it.

```quint
pure def alwaysCompletionTimeMatchesStatus(s: Todos): bool = s.todos.every(t => t.completedAt >= 0 and ((t.completedAt > 0) == (t.todoStatus == TodoCompleted)))
```

### Clearing the list removes only the previewed items, and only after the owner confirms

A clear asked for by the agent first records a preview of the items it
would remove. Only an affirmative reply to that preview removes them;
any other reply cancels the clear. Items added after the preview stay.

```quint
pure val previewRequest: TodoRequest = { op: PreviewClearOp, requestContent: "", requestItem: 0, requestStatus: TodoPending, affirmed: false, requestRenamed: "" }
pure def confirmRequest(affirmed: bool): TodoRequest = { op: ConfirmClearOp, requestContent: "", requestItem: 0, requestStatus: TodoPending, affirmed: affirmed, requestRenamed: "" }
pure def canPreviewClear(s: Todos, key: str): bool = keyAdmits(s, key, previewRequest)
pure def previewClear(s: Todos, key: str): Todos =
  if (replayed(s, key)) s
  else recordMutation(key, previewRequest, { ...s, clearPreviewed: true, previewIds: s.todos.foldl(Set(), (ids, t) => ids.union(Set(t.todoId))) }, Applied)
pure def canConfirmClear(s: Todos, key: str, affirmed: bool): bool = s.clearPreviewed and keyAdmits(s, key, confirmRequest(affirmed))
pure def confirmClear(s: Todos, key: str, affirmed: bool): Todos =
  if (replayed(s, key)) s
  else recordMutation(key, confirmRequest(affirmed),
    { ...s, clearPreviewed: false, previewIds: Set(), todos: if (affirmed) s.todos.select(t => not(s.previewIds.contains(t.todoId))) else s.todos }, Applied)
pure def stepItemsLeaveOnlyByDeleteOrConfirmedClear(before: Todos, via: str, after: Todos): bool =
  after.todos.length() < before.todos.length() implies
    ((via == "deleteTodo" and after.todos.length() == before.todos.length() - 1) or (via == "confirmClear" and before.clearPreviewed))
pure def stepClearKeepsUnpreviewedItems(before: Todos, via: str, after: Todos): bool =
  via == "confirmClear" implies before.todos.every(t => before.previewIds.contains(t.todoId) or after.todos.includes(t))
```

### A list can hold a confirmed duplicate, refuse an ambiguous change, and be cleared after confirmation

```quint
pure def sometimesConfirmedDuplicate(s: Todos): bool = s.todos.some(t => s.todos.select(o => o.content == t.content).length() == 2)
pure def sometimesAmbiguousChangeMissed(s: Todos): bool = s.lastOutcome == Missed and s.todos.length() >= 2
pure def sometimesClearedAfterConfirmation(s: Todos): bool = s.mutations.some(m => m.request.op == ConfirmClearOp and m.request.affirmed) and s.todos.length() == 0 and s.nextId > 2
pure def sometimesCompleted(s: Todos): bool = s.todos.some(t => t.todoStatus == TodoCompleted)
pure def sometimesRenamed(s: Todos): bool = s.todos.some(t => t.content == "oat milk") and s.mutations.some(m => m.request.op == RenameOp)
```
