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

Five edits, the first versions and sequence numbers, a few lists the server
might send, a few queues, and for the laws a new client and one with an edit
queued.

```quint
pure val opValues =
  Set(Create({ id: "x", title: "milk" }))
    .union(Set(Create({ id: "y", title: "" })))
    .union(Set(SetDone({ id: "x", done: true })))
    .union(Set(Rename({ id: "x", title: "eggs" })))
    .union(Set(Remove({ id: "x" })))
pure val cValues =
  Set(initial).union(Set({ ...initial, made: 2, seen: 1, pending: List({ seq: 2, op: SetDone({ id: "x", done: true }) }) }))
pure val seqValues = Set(1, 2, 3)
pure val versionValues = Set(0, 1, 2, 3)
pure val todosValues =
  Set(List()).union(Set(List({ id: "x", title: "milk", done: false, deleted: false })))
    .union(Set(List({ id: "x", title: "milk", done: true, deleted: false }, { id: "y", title: "eggs", done: false, deleted: true })))
pure val psValues =
  Set(List()).union(Set(List({ seq: 1, op: Create({ id: "x", title: "milk" }) })))
    .union(Set(List({ seq: 1, op: Create({ id: "x", title: "milk" }) }, { seq: 2, op: Remove({ id: "x" }) })))
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
pure def canQueue(c: Client, op: Op): bool = opAllowed(view(c), op)
pure def queue(c: Client, op: Op): Client =
  { ...c, made: c.made + 1, pending: c.pending.append({ seq: c.made + 1, op: op }) }
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

Whether an edit is allowed never depends on being online: offline, an edit
is allowed exactly when it would be online, and it joins the queue of a
client that stays offline.

```quint
pure def canGoOffline(c: Client): bool = c.online
pure def goOffline(c: Client): Client = { ...c, online: false }
pure def canGoOnline(c: Client): bool = not(c.online)
pure def goOnline(c: Client): Client = { ...c, online: true }

pure def sometimesQueuedWhileOffline(c: Client): bool = not(c.online) and c.pending.length() >= 2

pure def lawAnEditIsAllowedOfflineExactlyWhenOnline(c: Client, op: Op): bool =
  canQueue({ ...c, online: false }, op) iff canQueue({ ...c, online: true }, op)

pure def lawAnOfflineEditJoinsTheQueue(c: Client, op: Op): bool =
  val after = queue({ ...c, online: false }, op)
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
