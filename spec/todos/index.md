# To-do storage and views

The [assistant to-do model](../assistant/todos.md) owns list mutations and their idempotency. The To-dos plugin exposes the tenant store and dashboard and uses that policy for edits through either interface.

## Story: Read my to-do list from the dashboard or the agent

> As an owner, I can list my items by their status and find a particular item without seeing another owner's list.

### A list includes only items belonging to the requesting owner and the selected status

```quint
import todos as TodoPolicy from "../assistant/todos"
type TodoListFilter = EveryTodo | SelectedTodoStatus({ wantedStatus: TodoPolicy::TodoStatus })
type TodoViewRow = { listOwner: str, value: TodoPolicy::Todo }
pure def matchesTodoStatus(status: TodoPolicy::TodoStatus, statusGroup: TodoListFilter): bool = match statusGroup {
  | EveryTodo => true
  | SelectedTodoStatus(wanted) => status == wanted.wantedStatus
}
pure def listOwnerTodos(rows: List[TodoViewRow], ownerId: str, statusGroup: TodoListFilter): List[TodoViewRow] =
  rows.select(row => row.listOwner == ownerId and matchesTodoStatus(row.value.todoStatus, statusGroup))
pure def lawTodoListIsOwnerScoped(rows: List[TodoViewRow], ownerId: str, statusGroup: TodoListFilter): bool =
  listOwnerTodos(rows, ownerId, statusGroup).every(row => row.listOwner == ownerId)
```

### A lookup uses the owner and the item identifier together

```quint
pure def findOwnerTodo(rows: List[TodoViewRow], ownerId: str, todoId: int): List[TodoViewRow] =
  rows.select(row => row.listOwner == ownerId and row.value.todoId == todoId)
pure def lawTodoLookupKeepsRequestedIdentity(rows: List[TodoViewRow], ownerId: str, todoId: int): bool =
  findOwnerTodo(rows, ownerId, todoId).every(row => row.listOwner == ownerId and row.value.todoId == todoId)
pure val rowsValues = Set(List(), List({ listOwner: "owner", value: { todoId: 1, content: "Meet Pat", todoStatus: TodoPolicy::TodoPending, completedAt: 0 } }, { listOwner: "other", value: { todoId: 1, content: "Read mail", todoStatus: TodoPolicy::TodoCompleted, completedAt: 1 } }))
pure val statusGroupValues = Set(EveryTodo, SelectedTodoStatus({ wantedStatus: TodoPolicy::TodoPending }), SelectedTodoStatus({ wantedStatus: TodoPolicy::TodoCompleted }))
```
