# Todo list

The shared vocabulary of the to-do application: what a to-do is, which edits
exist, when an edit makes sense and what it does. It has no state of its own;
the server, the client and the whole system import it, so all three apply an
edit in exactly the same way.

## Domain

### A to-do has an id, a title, a done mark and a deleted mark

The id is chosen by the client that creates the to-do, so that a client can
create a to-do while offline and keep editing it before the server has seen
it. A removed to-do stays in the list as a tombstone with `deleted` set, so an
id is never used for a second to-do.

```quint
type Todo = { id: str, title: str, done: bool, deleted: bool }
```

### An edit creates a to-do, sets its done mark, renames it or removes it

Each kind of edit carries the id of its to-do and only what it needs besides.
Setting the done mark carries the value to set, not "flip it", so that an
edit applied twice has the same effect as once.

```quint
type Op = Create({ id: str, title: str }) | SetDone({ id: str, done: bool }) | Rename({ id: str, title: str }) | Remove({ id: str })
```

### What the simulator tries

For the laws: edits of every kind, a few to-dos and lists of them.

```quint
pure val changeValues =
  Set(Create({ id: "x", title: "milk" }))
    .union(Set(Create({ id: "y", title: "" })))
    .union(Set(SetDone({ id: "x", done: true })))
    .union(Set(Rename({ id: "x", title: "eggs" })))
    .union(Set(Remove({ id: "x" })))
pure val tValues =
  Set({ id: "x", title: "milk", done: false, deleted: false })
    .union(Set({ id: "x", title: "eggs", done: true, deleted: true }))
pure val xsValues =
  Set(List()).union(Set(List({ id: "x", title: "milk", done: false, deleted: false })))
    .union(Set(List({ id: "x", title: "milk", done: true, deleted: false }, { id: "y", title: "eggs", done: false, deleted: true })))
```

## Story: Keep a shared list of things to do

> As a member of a household, I want to add things to do, tick them off,
> rename them and remove them, so that everyone sees what is left.

### A to-do can be found by its id

`live` means it is there and not removed.

```quint
pure def has(todos: List[Todo], id: str): bool = todos.some(t => t.id == id)
pure def live(todos: List[Todo], id: str): bool = todos.some(t => t.id == id and not(t.deleted))
```

### A new to-do needs a title and an id never used before; other edits need a live to-do

A rename also needs a title. An id that was removed stays used.

```quint
pure def opAllowed(todos: List[Todo], op: Op): bool =
  match op {
    | Create(x) => x.title != "" and not(has(todos, x.id))
    | SetDone(x) => live(todos, x.id)
    | Rename(x) => x.title != "" and live(todos, x.id)
    | Remove(x) => live(todos, x.id)
  }
```

### Applying an edit changes only the to-do it names

A new to-do is added at the end, not done. Creating an id that already exists
changes nothing. Setting the done mark sets it to the value the edit carries,
a rename sets the title, and removing sets the deleted mark.

```quint
pure def edit(t: Todo, op: Op): Todo =
  match op {
    | Create(x) => t
    | SetDone(x) => if (t.id == x.id) { ...t, done: x.done } else t
    | Rename(x) => if (t.id == x.id) { ...t, title: x.title } else t
    | Remove(x) => if (t.id == x.id) { ...t, deleted: true } else t
  }

pure def applyOp(todos: List[Todo], op: Op): List[Todo] =
  match op {
    | Create(x) => if (has(todos, x.id)) todos else todos.append({ id: x.id, title: x.title, done: false, deleted: false })
    | _ => todos.listMap(t => edit(t, op))
  }
```

## Story: Edits survive being sent twice

> As someone on a bad connection, I want an edit that reaches the server twice
> to count once, so that a retry never undoes or doubles my change.

### Applying an edit to a to-do twice is the same as applying it once

```quint
pure def lawEditingTwiceIsEditingOnce(t: Todo, change: Op): bool =
  edit(edit(t, change), change) == edit(t, change)
```

### Creating a to-do twice adds it once

```quint
pure def lawCreatingTwiceAddsOnce(xs: List[Todo], change: Op): bool =
  match change {
    | Create(x) => applyOp(applyOp(xs, change), change).length() == applyOp(xs, change).length()
    | _ => true
  }
```

### An edit other than a creation never changes the number of to-dos

```quint
pure def lawAnEditKeepsTheLength(xs: List[Todo], change: Op): bool =
  match change {
    | Create(x) => true
    | _ => applyOp(xs, change).length() == xs.length()
  }
```
