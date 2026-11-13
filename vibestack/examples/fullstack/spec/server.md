# Todo server

The backend: one shared list of to-dos behind an HTTP API. Every request
names the client that sent it and that client's sequence number for it, so a
request that arrives twice, because the client retried after a lost reply,
is recognised, provided it carries the same edit. The server answers each
request once and remembers the answer and the edit it answered. Every
accepted edit raises the version by one, even if it leaves the list unchanged;
clients use the version to tell an old copy of the list from a newer one.

## Domain

### The server holds the list, its version and a log of every request it answered

Each entry of the log records the client, the number, the edit the request
carried and whether it was accepted, so that a later request with the same
number can be told apart from a retry.

```quint
import todo.* from "./todo"

type Answered = { client: str, seq: int, op: Op, ok: bool }
type Server = {
  todos: List[Todo],
  version: int,
  log: List[Answered],
}
```

### A new server has an empty list at version 0

```quint
pure val initial: Server = { todos: List(), version: 0, log: List() }
```

### What the simulator tries

Two clients, the first three sequence numbers of each, and an edit of every
kind: the creation of either of two to-dos, and each other kind on the first.

```quint
pure val clientValues = Set("a", "b")
pure val seqValues = Set(1, 2, 3)
pure val opValues =
  Set(Create({ id: "x", title: "milk" }))
    .union(Set(Create({ id: "y", title: "" })))
    .union(Set(SetDone({ id: "x", done: true })))
    .union(Set(Rename({ id: "x", title: "eggs" })))
    .union(Set(Remove({ id: "x" })))
```

## Story: Change the list over HTTP

> As a client of the API, I want to create, tick off, rename and remove
> to-dos with one request each, so that the browser never has to send the
> whole list.

### The log tells which requests were answered, and with which edit each was accepted

A request the log already holds is not applied again. It is a retry only if
it carries the edit the log records for its client and number: the shell
answers it as accepted only if that edit was accepted, and refuses a request
that reuses a number for a different edit.

```quint
pure def answered(s: Server, client: str, seq: int): bool =
  s.log.some(h => h.client == client and h.seq == seq)

pure def acceptedAs(s: Server, client: str, seq: int, op: Op): bool =
  s.log.some(h => h.client == client and h.seq == seq and h.ok and h.op == op)
```

### A new request whose edit makes sense is applied, raising the version by one

New means the log holds no request with its client and number. The request is
logged as accepted, with its edit.

```quint
pure def allows(s: Server, client: str, seq: int, op: Op): bool =
  not(answered(s, client, seq)) and opAllowed(s.todos, op)

pure def commit(client: str, s: Server, seq: int, op: Op): Server =
  { todos: applyOp(s.todos, op), version: s.version + 1, log: s.log.append({ client: client, seq: seq, op: op, ok: true }) }
```

### A new request whose edit does not make sense is refused, which is logged with its edit and changes nothing else

Such as ticking off a to-do another client has just removed.

```quint
pure def refusal(client: str, s: Server, seq: int, op: Op): Server =
  { ...s, log: s.log.append({ client: client, seq: seq, op: op, ok: false }) }
```

### Every new request is answered by applying its edit if it makes sense and refusing it if not

The edit and the list alone decide which: a client cannot ask for refusal.
A request the log already holds is not taken again; the shell answers it from
the log.

```quint
pure def canRequest(s: Server, client: str, seq: int): bool = not(answered(s, client, seq))
pure def request(s: Server, client: str, seq: int, op: Op): Server =
  if (allows(s, client, seq, op)) commit(client, s, seq, op) else refusal(client, s, seq, op)
```

### The version counts the changes

A change here means one accepted edit, including setting a field to its
current value. Refused requests and retries do not increment the version.

```quint
pure def alwaysTheVersionCountsTheChanges(s: Server): bool =
  s.version == s.log.select(h => h.ok).length()
```

### No request is answered twice

```quint
pure def alwaysNoRequestIsAnsweredTwice(s: Server): bool =
  s.log.every(a => s.log.select(b => b.client == a.client and b.seq == a.seq).length() == 1)
```

### Each request is logged once and raises the version by at most one

```quint
pure def stepEachRequestRaisesTheVersionByAtMostOne(before: Server, after: Server): bool =
  after.log.length() == before.log.length() + 1
    and (after.version == before.version or after.version == before.version + 1)
```

### Two clients can both change the list, and a server that has accepted a change can also hold a refusal

The refusal is asked of a server that has also accepted an edit, before or
after it, so that it is not witnessed by a server that only ever refuses.

```quint
pure def sometimesTwoClientsChangedIt(s: Server): bool =
  s.log.some(h => h.client == "a" and h.ok) and s.log.some(h => h.client == "b" and h.ok)

pure def sometimesARefusal(s: Server): bool = s.log.some(h => not(h.ok)) and s.version >= 1
```

## Story: A to-do keeps its id for ever

> As a user who mentions a to-do by its id, I want an id to stand for one
> to-do only, even after it is removed, so that an old link never leads to a
> different to-do.

### No two to-dos share an id

```quint
pure def alwaysIdsAreUnique(s: Server): bool =
  s.todos.every(t => s.todos.select(u => u.id == t.id).length() == 1)
```

### A to-do is never taken out of the list, and a removed one stays removed

```quint
pure def stepNoToDoIsForgotten(before: Server, after: Server): bool =
  before.todos.every(t => after.todos.some(u => u.id == t.id and (u.deleted or not(t.deleted))))
```

### A to-do can be removed, leaving a tombstone

```quint
pure def sometimesATombstone(s: Server): bool = s.todos.some(t => t.deleted)
```
