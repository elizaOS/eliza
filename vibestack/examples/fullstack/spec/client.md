# Todo client

The frontend: one browser tab. It keeps the last copy of the list the server
confirmed, the version of that copy, and a queue of the user's edits that the
server has not answered yet. What the user sees is the queue applied over the
confirmed copy, so an edit shows at once, online or not. The browser page uses
`step` from this spec to update its state: every user action and every message
from the server is an event.

## Domain

### A client holds a confirmed copy, its version, and a queue of unanswered edits

Each queued edit carries the number the client gave it, which the server
uses to recognise a retry. `made` counts the edits the client has numbered.
The client also holds whether it is online, and `refusals` counts the
refusals it was told of.

```quint
import todo.* from "./todo"

type Pending = { seq: int, op: Op }
type Client = {
  confirmed: List[Todo],
  seen: int, pending: List[Pending], online: bool, made: int, refusals: int,
}
```

### A new client is online, has seen version 0 and has nothing queued

Its confirmed copy is empty, and it has numbered no edits and been told of no
refusals.

```quint
pure val initial: Client =
  { confirmed: List(), seen: 0, pending: List(), online: true, made: 0, refusals: 0 }
```

### What the simulator tries

Two ids, an empty and a real title, the first versions and sequence numbers,
and a few lists the server might send.

```quint
pure val idValues = Set("x", "y")
pure val titleValues = Set("", "milk")
pure val seqValues = Set(1, 2, 3)
pure val versionValues = Set(0, 1, 2, 3)
pure val todosValues =
  Set(List()).union(Set(List({ id: "x", title: "milk", done: false, deleted: false })))
    .union(Set(List({ id: "x", title: "milk", done: true, deleted: false }, { id: "y", title: "eggs", done: false, deleted: true })))
pure val psValues =
  Set(List()).union(Set(List({ seq: 1, op: { kind: "create", id: "x", title: "milk", done: false } })))
    .union(Set(List({ seq: 1, op: { kind: "create", id: "x", title: "milk", done: false } }, { seq: 2, op: { kind: "remove", id: "x", title: "", done: false } })))
```

## Story: Edit the list in the browser

> As a user, I want my edit to show the moment I make it, even when the
> server has not answered yet or I am offline, so that the page never feels
> slow.

### The user sees the queued edits applied over the confirmed copy, in order

A removed to-do is not shown.

```quint
pure def view(c: Client): List[Todo] = c.pending.foldl(c.confirmed, (acc, p) => applyOp(acc, p.op))
pure def visible(c: Client): List[Todo] = view(c).select(t => not(t.deleted))
```

### An edit the user makes is checked against what they see, numbered and queued

```quint
pure def queue(op: Op, c: Client): Client =
  { ...c, made: c.made + 1, pending: c.pending.append({ seq: c.made + 1, op: op }) }

pure def canCreate(c: Client, id: str, title: str): bool =
  opAllowed(view(c), { kind: "create", id: id, title: title, done: false })
pure def create(c: Client, id: str, title: str): Client =
  queue({ kind: "create", id: id, title: title, done: false }, c)

pure def canSetDone(c: Client, id: str, done: bool): bool =
  opAllowed(view(c), { kind: "done", id: id, title: "", done: done })
pure def setDone(c: Client, id: str, done: bool): Client =
  queue({ kind: "done", id: id, title: "", done: done }, c)

pure def canRename(c: Client, id: str, title: str): bool =
  opAllowed(view(c), { kind: "rename", id: id, title: title, done: false })
pure def rename(c: Client, id: str, title: str): Client =
  queue({ kind: "rename", id: id, title: title, done: false }, c)

pure def canRemove(c: Client, id: str): bool =
  opAllowed(view(c), { kind: "remove", id: id, title: "", done: false })
pure def remove(c: Client, id: str): Client =
  queue({ kind: "remove", id: id, title: "", done: false }, c)
```

### Every queued edit was numbered here, and no two share a number

```quint
pure def alwaysEveryQueuedEditWasNumberedHere(c: Client): bool =
  c.pending.every(p => p.seq >= 1 and p.seq <= c.made)

pure def alwaysQueuedEditsHaveDistinctNumbers(c: Client): bool =
  c.pending.every(p => c.pending.select(q => q.seq == p.seq).length() == 1)
```

### The count of numbered edits is never negative

Discovered by the proof: nothing said so, and a client whose count was
negative would give its next edit a number below 1.

```quint
pure def alwaysTheEditCountIsNotNegative(c: Client): bool = c.made >= 0
```

### A tab can go offline and back online, and queue edits while offline

Whether an edit is allowed never depends on being online: offline, each of
the four edits is allowed exactly when it would be online, and it joins the
queue of a client that stays offline.

```quint
pure def canGoOffline(c: Client): bool = c.online
pure def goOffline(c: Client): Client = { ...c, online: false }
pure def canGoOnline(c: Client): bool = not(c.online)
pure def goOnline(c: Client): Client = { ...c, online: true }

pure def sometimesQueuedWhileOffline(c: Client): bool = not(c.online) and c.pending.length() >= 2

pure def lawAnEditIsAllowedOfflineExactlyWhenOnline(c: Client, id: str, title: str, done: bool): bool =
  val off = { ...c, online: false }
  val on = { ...c, online: true }
  and {
    canCreate(off, id, title) iff canCreate(on, id, title),
    canSetDone(off, id, done) iff canSetDone(on, id, done),
    canRename(off, id, title) iff canRename(on, id, title),
    canRemove(off, id) iff canRemove(on, id),
  }

pure def lawAnOfflineEditJoinsTheQueue(c: Client, op: Op): bool =
  val after = queue(op, { ...c, online: false })
  not(after.online) and after.pending.length() == c.pending.length() + 1
```

## Story: Hear back from the server

> As a user, I want my page to follow the server's answers and other
> people's changes, and to tell me when an edit of mine was refused.

### An answer takes its edit out of the queue

The server answers an edit, accepted or refused, with the list as it now is.

```quint
pure def without(ps: List[Pending], seq: int): List[Pending] = ps.select(p => p.seq != seq)
pure def waiting(c: Client, seq: int): bool = c.pending.some(p => p.seq == seq)

pure def lawAnAnsweredEditLeavesTheQueue(ps: List[Pending], seq: int): bool =
  not(without(ps, seq).some(p => p.seq == seq))
```

### A copy of the list replaces the confirmed copy only if it is newer

Messages can arrive out of order; an older copy is ignored.

```quint
pure def catchUp(version: int, todos: List[Todo], c: Client): Client =
  if (version > c.seen) { ...c, confirmed: todos, seen: version } else c

pure def stepTheConfirmedVersionNeverGoesBack(before: Client, after: Client): bool =
  after.seen >= before.seen
```

### The confirmed version is never negative

The server's versions start at 0.

```quint
pure def alwaysTheConfirmedVersionIsNotNegative(c: Client): bool = c.seen >= 0
```

### The client hears answers and other people's changes only while online

A refusal of an edit that is still queued is counted, so that the page can
tell the user.

```quint
pure def canReceiveAck(c: Client, seq: int, version: int, todos: List[Todo]): bool = c.online
pure def receiveAck(c: Client, seq: int, version: int, todos: List[Todo]): Client =
  catchUp(version, todos, { ...c, pending: without(c.pending, seq) })

pure def canReceiveRefusal(c: Client, seq: int, version: int, todos: List[Todo]): bool = c.online
pure def receiveRefusal(c: Client, seq: int, version: int, todos: List[Todo]): Client =
  catchUp(version, todos, {
    ...c, pending: without(c.pending, seq), refusals: c.refusals + (if (waiting(c, seq)) 1 else 0),
  })

pure def canReceiveSnapshot(c: Client, version: int, todos: List[Todo]): bool = c.online
pure def receiveSnapshot(c: Client, version: int, todos: List[Todo]): Client = catchUp(version, todos, c)
```

### A copy of the list leaves the queue alone

A copy of the list that arrives on its own, not as the answer to an edit,
leaves the queue exactly as it was.

```quint
pure def stepASnapshotLeavesTheQueueAlone(before: Client, via: str, after: Client): bool =
  via == "receiveSnapshot" implies after.pending == before.pending
```

### A client can catch up after editing, and can be told of a refusal

```quint
pure def sometimesCaughtUpAfterEditing(c: Client): bool =
  c.made >= 1 and c.pending.length() == 0 and c.seen >= 1

pure def sometimesRefused(c: Client): bool = c.refusals >= 1
```

## Story: Other specs can rely on the client's rules

> As the author of a spec that runs clients inside a larger system, I want
> the client's state invariants stated as laws, so that my proofs can use
> them rather than prove them again.

### Queueing an edit or hearing an answer keeps the client's state invariants

For these laws, the client's rules are its four state invariants: every
queued edit carries a number from 1 to the edit count, no two share one, and
the edit count and confirmed version are nonnegative. Step and reachability rules are checked separately. What
is proved about imported transitions can be called when their obligations
were proved in the same run. These laws also cover helpers such as `queue`,
which are not transitions.

```quint
pure val cValues =
  Set(initial).union(Set({
    ...initial,
    made: 2,
    seen: 1,
    pending: List({ seq: 2, op: { kind: "done", id: "x", title: "", done: true } }),
  }))
pure val opValues =
  Set({ kind: "create", id: "y", title: "eggs", done: false })
    .union(Set({ kind: "done", id: "x", title: "", done: true }))

pure def rulesHold(c: Client): bool = and {
  alwaysEveryQueuedEditWasNumberedHere(c),
  alwaysQueuedEditsHaveDistinctNumbers(c),
  alwaysTheEditCountIsNotNegative(c),
  alwaysTheConfirmedVersionIsNotNegative(c),
}

pure def lawQueueingKeepsTheRules(c: Client, op: Op): bool =
  rulesHold(c) implies rulesHold(queue(op, c))

pure def lawAnAnswerKeepsTheRules(c: Client, seq: int, version: int, todos: List[Todo]): bool =
  rulesHold(c) implies and {
    rulesHold(receiveAck(c, seq, version, todos)),
    rulesHold(receiveRefusal(c, seq, version, todos)),
    rulesHold(receiveSnapshot(c, version, todos)),
  }
```
