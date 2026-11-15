# To-dos

The owner's to-do list: items that are pending, in progress, completed or
cancelled. The agent changes it on the owner's behalf through mutations,
each carrying an idempotency key, so a retried request never applies
twice. A mutation that names an item by its text applies only when exactly
one item matches. This machine follows one owner's list.

## Story: Keep my to-do list as I asked, once

> As an owner, I want my to-dos changed exactly as I asked, never twice
> for a retried request, never on a guess between two items, and never
> cleared without my confirmation.

### A mutation is applied once per idempotency key

A key seen before with the same request replays the recorded result and
changes nothing. A key seen before with a different request is refused.

```quint
type TodoStatus = TodoPending | TodoInProgress | TodoCompleted | TodoCancelled
type Todo = { todoId: int, content: str, todoStatus: TodoStatus, completedAt: bool }
type TodoOp = CreateOp | StatusOp | DeleteOp | PreviewClearOp | ConfirmClearOp
type TodoRequest = { op: TodoOp, requestContent: str, requestStatus: TodoStatus, affirmed: bool }
type MutationRecord = { key: str, request: TodoRequest }
type TodoOutcome = NoOutcome | Applied | Missed | Duplicate
type Todos = { todos: List[Todo], nextId: int, mutations: List[MutationRecord], clearPreviewed: bool, previewIds: Set[int], lastOutcome: TodoOutcome }
pure val initial: Todos = { todos: List(), nextId: 1, mutations: List(), clearPreviewed: false, previewIds: Set(), lastOutcome: NoOutcome }
pure val keyValues = Set("k1", "k2", "k3", "k4", "k5")
pure val contentValues = Set("milk", "call mom")
pure def keyAdmits(s: Todos, key: str, request: TodoRequest): bool = s.mutations.every(m => m.key != key or m.request == request)
pure def replayed(s: Todos, key: str): bool = s.mutations.some(m => m.key == key)
pure def recordMutation(key: str, request: TodoRequest, s: Todos, outcome: TodoOutcome): Todos =
  { ...s, mutations: s.mutations.append({ key: key, request: request }), lastOutcome: outcome }
pure def alwaysKeysAreUnique(s: Todos): bool = s.mutations.every(m => s.mutations.select(o => o.key == m.key).length() == 1)
```

### An item is added unless an open item already says the same, unless the owner confirms the duplicate

```quint
pure def createRequest(content: str, affirmed: bool): TodoRequest = { op: CreateOp, requestContent: content, requestStatus: TodoPending, affirmed: affirmed }
pure def openWith(s: Todos, content: str): bool = s.todos.some(t => t.content == content and (t.todoStatus == TodoPending or t.todoStatus == TodoInProgress))
pure def canCreateTodo(s: Todos, key: str, content: str, affirmed: bool): bool = keyAdmits(s, key, createRequest(content, affirmed))
pure def createTodo(s: Todos, key: str, content: str, affirmed: bool): Todos =
  if (replayed(s, key)) s
  else if (openWith(s, content) and not(affirmed)) recordMutation(key, createRequest(content, affirmed), s, Duplicate)
  else recordMutation(key, createRequest(content, affirmed), { ...s, todos: s.todos.append({ todoId: s.nextId, content: content, todoStatus: TodoPending, completedAt: false }), nextId: s.nextId + 1 }, Applied)
pure def alwaysTodoIdsAreUnique(s: Todos): bool = s.todos.every(t => t.todoId > 0 and t.todoId < s.nextId and s.todos.select(o => o.todoId == t.todoId).length() == 1)
```

### A change by text applies only when exactly one item matches

When no item or several items match, nothing changes and the result names
the miss, with the candidates when there are several.

```quint
pure def matching(s: Todos, content: str): List[Todo] = s.todos.select(t => t.content == content)
pure def statusRequest(content: str, status: TodoStatus): TodoRequest = { op: StatusOp, requestContent: content, requestStatus: status, affirmed: false }
pure def canSetTodoStatus(s: Todos, key: str, content: str, status: TodoStatus): bool = keyAdmits(s, key, statusRequest(content, status))
pure def setTodoStatus(s: Todos, key: str, content: str, status: TodoStatus): Todos =
  if (replayed(s, key)) s
  else if (matching(s, content).length() != 1) recordMutation(key, statusRequest(content, status), s, Missed)
  else recordMutation(key, statusRequest(content, status),
    { ...s, todos: s.todos.listMap(t => if (t.content == content) { ...t, todoStatus: status, completedAt: status == TodoCompleted } else t) }, Applied)
pure def deleteRequest(content: str): TodoRequest = { op: DeleteOp, requestContent: content, requestStatus: TodoPending, affirmed: false }
pure def canDeleteTodo(s: Todos, key: str, content: str): bool = keyAdmits(s, key, deleteRequest(content))
pure def deleteTodo(s: Todos, key: str, content: str): Todos =
  if (replayed(s, key)) s
  else if (matching(s, content).length() != 1) recordMutation(key, deleteRequest(content), s, Missed)
  else recordMutation(key, deleteRequest(content), { ...s, todos: s.todos.select(t => t.content != content) }, Applied)
pure def stepMissChangesNoItem(before: Todos, after: Todos): bool =
  (after.lastOutcome == Missed and after.mutations.length() > before.mutations.length()) implies after.todos == before.todos
```

### An item's completion time is set exactly while it is completed

```quint
pure def alwaysCompletionTimeMatchesStatus(s: Todos): bool = s.todos.every(t => t.completedAt == (t.todoStatus == TodoCompleted))
```

### Clearing the list removes only the previewed items, and only after the owner confirms

A clear asked for by the agent first records a preview of the items it
would remove. Only an affirmative reply to that preview removes them;
any other reply cancels the clear. Items added after the preview stay.

```quint
pure val previewRequest: TodoRequest = { op: PreviewClearOp, requestContent: "", requestStatus: TodoPending, affirmed: false }
pure def confirmRequest(affirmed: bool): TodoRequest = { op: ConfirmClearOp, requestContent: "", requestStatus: TodoPending, affirmed: affirmed }
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
```

### To-dos survive the move to their own store

To-dos and their mutation records that an earlier version kept in the
shared assistant store are copied once into the to-do store, under the
[goals' rule for such moves](./goals.md).

```quint
import goals as G from "./goals"
pure def todoMove(sourcePresent: bool, targetEmpty: bool, moveReceipt: bool): G::MoveOutcome = G::moveOutcome(sourcePresent, targetEmpty, moveReceipt)
pure def lawTodoMoveNeverOverwrites(sourcePresent: bool, targetEmpty: bool, moveReceipt: bool): bool =
  todoMove(sourcePresent, targetEmpty, moveReceipt) == G::MovedCopied implies (targetEmpty and not(moveReceipt))
```
