# Shared to-do system

The whole application: the server, two browser tabs, and the network between
them. Each part is the machine its own spec defines, used here under a name
(`S` for the server, `C` for a client); this spec adds the network and the
rules that only the whole system can state. The network may lose, repeat
and reorder messages, a tab may go offline at any time, and anyone may send
the server a request in a tab's name.

## Domain

### Messages

A client sends a request carrying one of its queued edits. The server
answers the sender with an acknowledgement or a refusal, and tells the other
client when the list changed. Every answer carries the list and its version.
`client` is the sender of a request and the receiver of everything else. A
forged request names a client but was sent by someone else, who gets the
answer: HTTP answers on the connection the request came in on.

```quint
import server as S from "./server"
import client as C from "./client"
import todo.* from "./todo"

type MsgKind = Request | Forged | Ack | Refusal | Push
type Msg = { kind: MsgKind, client: str, seq: int, op: Op, version: int, todos: List[Todo] }
```

### The system holds the server, clients a and b, the messages in flight, and the history of the list

`history` and `forged` are not part of the running application: one records
the list as it was at every version, so that rules can say which version a
copy is, and the other counts the forged requests sent.

```quint
type System = {
  server: S::Server, a: C::Client, b: C::Client, net: List[Msg], history: List[List[Todo]], forged: int,
}

pure val initial: System =
  { server: S::initial, a: C::initial, b: C::initial, net: List(), history: List(List()), forged: 0 }
```

### What the simulator tries

Both clients, the first few positions in the network and sequence numbers,
and five edits. Only `a` and `b` identify tabs accepted by the system's events.

```quint
pure val whoValues = Set("a", "b")
pure val iValues = Set(0, 1, 2)
pure val seqValues = Set(0, 1, 2)
pure val opValues =
  Set({ kind: "create", id: "x", title: "milk", done: false })
    .union(Set({ kind: "create", id: "y", title: "eggs", done: false }))
    .union(Set({ kind: "done", id: "x", title: "", done: true }))
    .union(Set({ kind: "rename", id: "y", title: "bread", done: false }))
    .union(Set({ kind: "remove", id: "x", title: "", done: false }))
```

### Helpers

```quint
pure def clientOf(sys: System, who: str): C::Client = if (who == "a") sys.a else sys.b
pure def withClient(who: str, c: C::Client, sys: System): System =
  if (who == "a") { ...sys, a: c } else { ...sys, b: c }
pure def other(who: str): str = if (who == "a") "b" else "a"
pure def isClient(who: str): bool = who == "a" or who == "b"

pure val noOp: Op = { kind: "create", id: "", title: "", done: false }
pure val noMsg: Msg = { kind: Push, client: "", seq: 0, op: noOp, version: -1, todos: List() }
pure def msgAt(net: List[Msg], i: int): Msg = if (i >= 0 and i < net.length()) net.nth(i) else noMsg
pure def dropAt(net: List[Msg], i: int): List[Msg] = net.removeAt(i)

pure def isRequest(m: Msg): bool = m.kind == Request or m.kind == Forged
pure def oldest(c: C::Client): C::Pending =
  if (c.pending.length() > 0) c.pending.nth(0) else { seq: 0, op: noOp }

pure def request(who: str, p: C::Pending): Msg =
  { kind: Request, client: who, seq: p.seq, op: p.op, version: 0, todos: List() }
pure def answer(kind: MsgKind, who: str, seq: int, s: S::Server): Msg =
  { kind: kind, client: who, seq: seq, op: noOp, version: s.version, todos: s.todos }
pure def pastAt(h: List[List[Todo]], v: int): List[Todo] = if (v >= 0 and v < h.length()) h.nth(v) else List()
pure def isPast(h: List[List[Todo]], v: int, todos: List[Todo]): bool =
  v >= 0 and v < h.length() and sameTodos(pastAt(h, v), todos)
```

## Story: Edit together, online or not

> As one of two people sharing a list, I want to queue edits while offline
> and retry the oldest unanswered edit while online, so that a bad connection
> does not erase the edits I have queued.

### Only a tab's oldest queued edit can be on its way unanswered

A tab has at most one edit on its way: the next one is sent once the server
has answered the one before. Sending the whole queue at once would let the
network reorder a user's own edits, so that ticking off a to-do could reach
the server before creating it, and be refused.

```quint
pure def alwaysOnlyTheOldestQueuedEditIsOnItsWay(sys: System): bool =
  sys.net.every(m => m.kind != Request or S::answered(sys.server, m.client, m.seq)
    or (clientOf(sys, m.client).pending.length() > 0 and m.seq == oldest(clientOf(sys, m.client)).seq))
```

### A user edit is queued in the tab, and sent at once if the tab is online and has nothing else queued

The edit must make sense on the list the user sees, and only tabs `a` and `b`
act.

```quint
pure def canAct(sys: System, who: str, op: Op): bool = isClient(who) and opAllowed(C::view(clientOf(sys, who)), op)
pure def act(sys: System, who: str, op: Op): System =
  val c = clientOf(sys, who)
  val queued = C::queue(op, c)
  val sent =
    if (c.online and c.pending.length() == 0) sys.net.append(request(who, { seq: queued.made, op: op })) else sys.net
  withClient(who, queued, { ...sys, net: sent })
```

### A tab can go offline, and sends its oldest queued edit when it comes back

```quint
pure def canGoOffline(sys: System, who: str): bool = isClient(who) and C::canGoOffline(clientOf(sys, who))
pure def goOffline(sys: System, who: str): System = withClient(who, C::goOffline(clientOf(sys, who)), sys)

pure def canGoOnline(sys: System, who: str): bool = isClient(who) and C::canGoOnline(clientOf(sys, who))
pure def goOnline(sys: System, who: str): System =
  val c = clientOf(sys, who)
  val sent = if (c.pending.length() > 0) sys.net.append(request(who, oldest(c))) else sys.net
  withClient(who, C::goOnline(c), { ...sys, net: sent })
```

### An online tab may send its oldest queued edit again at any time

That is how the next edit goes out after an answer, and how a lost request
or answer is made up for.

```quint
pure def canResend(sys: System, who: str): bool =
  isClient(who) and clientOf(sys, who).online and clientOf(sys, who).pending.length() > 0
pure def resend(sys: System, who: str): System =
  { ...sys, net: sys.net.append(request(who, oldest(clientOf(sys, who)))) }
```

## Story: The server answers every request once

> As the operator, I want the server to apply each edit once however often it
> arrives, to tell the other tab about every change, and to answer a repeated
> request the way it answered the first time.

### The server takes any request off the network and answers it

A request with a number it has answered before is acknowledged again only
if it carries the edit that was accepted under that number, and refused
otherwise. A new request is taken by the server's own `request`, which applies
its edit or refuses it; the system reads the verdict back from the log, as the
HTTP shell does. A change is pushed to the other tab. The answer to a forged
request goes to whoever forged it, not onto the network.

```quint
pure def reply(m: Msg, a: Msg, net: List[Msg]): List[Msg] = if (m.kind == Request) net.append(a) else net

pure def repeatAnswer(m: Msg, rest: List[Msg], sys: System): System =
  val kind = if (S::acceptedAs(sys.server, m.client, m.seq, m.op)) Ack else Refusal
  { ...sys, net: reply(m, answer(kind, m.client, m.seq, sys.server), rest) }

pure def accepted(m: Msg, rest: List[Msg], s: S::Server, sys: System): System =
  { ...sys, server: s, history: sys.history.append(s.todos),
    net: reply(m, answer(Ack, m.client, m.seq, s), rest).append(answer(Push, other(m.client), 0, s)) }

pure def refused(m: Msg, rest: List[Msg], s: S::Server, sys: System): System =
  { ...sys, server: s, net: reply(m, answer(Refusal, m.client, m.seq, s), rest) }

pure def answerNew(m: Msg, rest: List[Msg], sys: System): System =
  val s = S::request(sys.server, m.client, m.seq, m.op)
  if (S::acceptedAs(s, m.client, m.seq, m.op)) accepted(m, rest, s, sys) else refused(m, rest, s, sys)

pure def canServe(sys: System, i: int): bool = isRequest(msgAt(sys.net, i))
pure def serve(sys: System, i: int): System =
  val m = msgAt(sys.net, i)
  val rest = dropAt(sys.net, i)
  if (S::answered(sys.server, m.client, m.seq)) repeatAnswer(m, rest, sys) else answerNew(m, rest, sys)
```

### An online tab takes any answer off the network

An answer here is an acknowledgement, a refusal or a push of a change, taken
in any order by the tab it is addressed to.

```quint
pure def receive(m: Msg, c: C::Client): C::Client =
  if (m.kind == Ack) C::receiveAck(c, m.seq, m.version, m.todos)
  else if (m.kind == Refusal) C::receiveRefusal(c, m.seq, m.version, m.todos)
  else C::receiveSnapshot(c, m.version, m.todos)

pure def canDeliver(sys: System, i: int): bool =
  val m = msgAt(sys.net, i)
  i >= 0 and i < sys.net.length() and not(isRequest(m)) and clientOf(sys, m.client).online
pure def deliver(sys: System, i: int): System =
  val m = msgAt(sys.net, i)
  withClient(m.client, receive(m, clientOf(sys, m.client)), { ...sys, net: dropAt(sys.net, i) })
```

### The network may lose or repeat any message

```quint
pure def canLose(sys: System, i: int): bool = i >= 0 and i < sys.net.length()
pure def lose(sys: System, i: int): System = { ...sys, net: dropAt(sys.net, i) }

pure def canDuplicate(sys: System, i: int): bool = i >= 0 and i < sys.net.length()
pure def duplicate(sys: System, i: int): System = { ...sys, net: sys.net.append(msgAt(sys.net, i)) }
```

### Anyone may send the server a request in a tab's name

The forger chooses the edit and the number. A number below 1 is never one a
tab gives, so forging it does nothing that forging an unused number does not.

```quint
pure def canForge(sys: System, who: str, seq: int, op: Op): bool = isClient(who) and seq >= 1
pure def forge(sys: System, who: str, seq: int, op: Op): System =
  { ...sys, forged: sys.forged + 1,
    net: sys.net.append({ kind: Forged, client: who, seq: seq, op: op, version: 0, todos: List() }) }
```

## Story: The tabs can synchronize with the server

> As one of two people sharing a list, I want my confirmed copy to be a list
> the server really had, with my queued edits shown over it. I want a
> successful synchronization in which both people finish their edits and
> see the server's current list.

### The server and both tabs keep their own state rules

```quint
pure def alwaysEachPartKeepsItsRules(sys: System): bool = and {
  S::alwaysTheVersionCountsTheChanges(sys.server),
  S::alwaysNoRequestIsAnsweredTwice(sys.server),
  S::alwaysIdsAreUnique(sys.server),
  C::alwaysEveryQueuedEditWasNumberedHere(sys.a),
  C::alwaysQueuedEditsHaveDistinctNumbers(sys.a),
  C::alwaysTheEditCountIsNotNegative(sys.a),
  C::alwaysTheConfirmedVersionIsNotNegative(sys.a),
  C::alwaysEveryQueuedEditWasNumberedHere(sys.b),
  C::alwaysQueuedEditsHaveDistinctNumbers(sys.b),
  C::alwaysTheEditCountIsNotNegative(sys.b),
  C::alwaysTheConfirmedVersionIsNotNegative(sys.b),
}
```

### No tab is ahead of the server

```quint
pure def alwaysNoTabIsAheadOfTheServer(sys: System): bool =
  sys.a.seen <= sys.server.version and sys.b.seen <= sys.server.version
```

### The history has one list for each version, and the last is the current list

```quint
pure def alwaysTheHistoryEndsWithTheCurrentList(sys: System): bool =
  sys.history.length() == sys.server.version + 1
    and sameTodos(pastAt(sys.history, sys.server.version), sys.server.todos)
```

### The history only grows: a step leaves it as it was or adds one list at its end

So the list recorded for an earlier version never changes.

```quint
pure def stepTheHistoryOnlyGrows(before: System, after: System): bool =
  after.history == before.history
    or after.history == before.history.append(pastAt(after.history, before.history.length()))
```

### A tab's confirmed copy is the list exactly as it was at the version the tab has seen

The same holds for every copy on the network.

```quint
pure def alwaysEveryCopyIsTheListAtItsVersion(sys: System): bool =
  isPast(sys.history, sys.a.seen, sys.a.confirmed)
    and isPast(sys.history, sys.b.seen, sys.b.confirmed)
    and sys.net.every(m => isRequest(m) or isPast(sys.history, m.version, m.todos))
```

### Both tabs can finish their edits and agree with the server

This is a reachable outcome. The network may lose messages, and no fairness
assumption requires retries or pushes to arrive, so eventual agreement is
not guaranteed.

```quint
pure def sometimesBothTabsAgree(sys: System): bool = and {
  sys.a.made >= 1, sys.b.made >= 1,
  sys.a.pending.length() == 0, sys.b.pending.length() == 0,
  sys.a.seen == sys.server.version, sys.b.seen == sys.server.version,
  sameTodos(C::view(sys.a), C::view(sys.b)),
  sameTodos(C::view(sys.a), sys.server.todos),
}
```

### A tab can queue edits while offline, and an edit can be refused

A tab's edit is allowed offline exactly when it would be online. Offline, it
joins the tab's queue and nothing is sent. The simulator tries this on the
initial system and on one with an edit already queued.

```quint
pure def sometimesQueuedOffline(sys: System): bool = not(sys.a.online) and sys.a.pending.length() >= 2
pure def sometimesARefusedEdit(sys: System): bool = sys.a.refusals + sys.b.refusals >= 1

pure val sysValues = Set(initial).union(Set({ ...initial, a: C::create(C::initial, "x", "milk") }))

pure def lawATabCanQueueAnEditWhileOffline(sys: System, who: str, op: Op): bool =
  val c = clientOf(sys, who)
  val off = withClient(who, { ...c, online: false }, sys)
  val after = act(off, who, op)
  and {
    canAct(off, who, op) iff canAct(withClient(who, { ...c, online: true }, sys), who, op),
    clientOf(after, who).pending.length() == c.pending.length() + 1,
    not(clientOf(after, who).online),
    after.net == sys.net,
  }
```

## Story: Nobody can answer for my edits

> As a user, I want to be told that my edit was saved only if the server
> really applied it, even when someone else sends requests in my name, so
> that an acknowledged edit is never silently lost.

### An acknowledgement of a queued edit means the server applied that very edit

```quint
pure def alwaysAnAcknowledgedEditWasApplied(sys: System): bool =
  sys.net.every(m => m.kind != Ack
    or clientOf(sys, m.client).pending.every(p => p.seq != m.seq or S::acceptedAs(sys.server, m.client, p.seq, p.op)))
```

### A tab's request carries the edit the tab queued under its number

So a request that arrives again is a retry of the same edit, and a request
in a tab's name with a different edit is not.

```quint
pure def alwaysARetryIsTheSameEdit(sys: System): bool =
  sys.net.every(m => m.kind != Request
    or clientOf(sys, m.client).pending.every(p => p.seq != m.seq or sameOp(p.op, m.op)))
```

### Every request, acknowledgement and refusal of a tab belongs to an edit the tab has numbered, and every acknowledgement and refusal to one the server answered

Discovered by the proof: without it, an acknowledgement left on the network
could carry the number the tab gives its next edit, and acknowledge that edit
before it was sent. A tab's request is one the tab sent.

```quint
pure def numbered(sys: System, who: str, seq: int): bool =
  (who == "a" or who == "b") and seq >= 1 and seq <= clientOf(sys, who).made

pure def alwaysEveryMessageBelongsToANumberedEdit(sys: System): bool =
  sys.net.every(m => m.kind == Forged or m.kind == Push
    or (numbered(sys, m.client, m.seq) and (m.kind == Request or S::answered(sys.server, m.client, m.seq))))
```

### A forger can get an edit applied in a tab's name

```quint
pure def sometimesAForgedEditWasApplied(sys: System): bool =
  sys.forged >= 1 and sys.server.log.some(h => h.ok and not(numbered(sys, h.client, h.seq)))
```

### The count of forged requests is never negative

Discovered by the proof: a negative count could become zero on a forgery,
incorrectly restoring the guarantee that nobody had forged a request.

```quint
pure def alwaysTheForgeryCountIsNotNegative(sys: System): bool = sys.forged >= 0
```

## Story: Editing alone is never refused

> As someone editing the list on my own, I want none of my edits refused,
> however bad my connection, because every edit I make makes sense on the
> list I see.

### A lone user's edit is never refused

A user is alone when the other tab has never made an edit and nobody has
forged a request. Refused means the tab was told of a refusal of an edit it
still had queued, which is what its `refusals` counts.

```quint
pure def lone(sys: System, who: str): bool = clientOf(sys, other(who)).made == 0 and sys.forged == 0

pure def alwaysALoneUsersEditIsNeverRefused(sys: System): bool =
  (lone(sys, "a") implies sys.a.refusals == 0) and (lone(sys, "b") implies sys.b.refusals == 0)
```

### A lone user can have several edits accepted

The user has made two or more edits and none is left queued; since a lone
user's edit is never refused, every one was acknowledged.

```quint
pure def sometimesALoneUsersEditsWereAccepted(sys: System): bool =
  lone(sys, "a") and sys.a.made >= 2 and sys.a.pending.length() == 0
```

### Without forgeries, the network holds no forged request, the server has answered only numbered edits, and of a tab's queued edits only the oldest

Discovered by the proof: it is what lets a new edit, and every edit behind
the oldest, be sure that no answer is waiting for it.

```quint
pure def onlyTheOldestAnswered(sys: System, who: str): bool =
  val c = clientOf(sys, who)
  c.pending.every(p => p.seq == oldest(c).seq or not(S::answered(sys.server, who, p.seq)))

pure def alwaysWithoutForgeriesOnlyNumberedEditsWereAnswered(sys: System): bool =
  sys.forged == 0 implies and {
    sys.server.log.every(h => numbered(sys, h.client, h.seq)),
    onlyTheOldestAnswered(sys, "a"),
    onlyTheOldestAnswered(sys, "b"),
    sys.net.every(m => m.kind != Forged),
  }
```

### A tab is told of a change only after the other tab or a forger made an edit

Discovered by the proof: a lone user's tab hears only answers to its own
edits.

```quint
pure def alwaysAPushFollowsAnotherEdit(sys: System): bool =
  sys.net.every(m => m.kind != Push or clientOf(sys, other(m.client)).made >= 1 or sys.forged >= 1)
```

### A lone user's tab keeps in step with the server

Discovered by the proof: these are what "never refused" rests on. While a
user is alone, the server has accepted every queued edit it answered, as
that edit; an acknowledgement of the oldest queued edit carries the current
version; once the oldest edit is applied, applying it again changes nothing;
until it is, and whenever nothing is queued, the tab has seen the current
version; a copy on its way to the
tab that is newer than the tab's is at the current version; what the user sees is the server's list with the
queued edits applied; each edit not yet applied makes sense after the ones
before it; and no refusal is on its way for a queued edit.

```quint
type Plan = { ok: bool, todos: List[Todo] }

pure def replay(todos: List[Todo], ps: List[C::Pending]): List[Todo] = ps.foldl(todos, (acc, p) => applyOp(acc, p.op))

pure def allowedInTurn(todos: List[Todo], ps: List[C::Pending]): bool =
  ps.foldl({ ok: true, todos: todos }, (acc, p) => { ok: acc.ok and opAllowed(acc.todos, p.op), todos: applyOp(acc.todos, p.op) }).ok

pure def oldestAnswered(sys: System, who: str): bool =
  clientOf(sys, who).pending.length() > 0 and S::answered(sys.server, who, oldest(clientOf(sys, who)).seq)

pure def unapplied(sys: System, who: str): List[C::Pending] =
  if (oldestAnswered(sys, who)) clientOf(sys, who).pending.tail() else clientOf(sys, who).pending

pure def inStep(sys: System, who: str): bool =
  val c = clientOf(sys, who)
  val s = sys.server
  and {
    c.pending.every(p => not(S::answered(s, who, p.seq)) or S::acceptedAs(s, who, p.seq, p.op)),
    sys.net.every(m => m.kind != Ack or m.client != who or c.pending.length() == 0 or m.seq != oldest(c).seq
      or m.version == s.version),
    not(oldestAnswered(sys, who)) or sameTodos(applyOp(s.todos, oldest(c).op), s.todos),
    oldestAnswered(sys, who) or c.seen == s.version,
    sys.net.every(m => isRequest(m) or m.client != who or m.version <= c.seen or m.version == s.version),
    sameTodos(C::view(c), replay(s.todos, c.pending)),
    allowedInTurn(s.todos, unapplied(sys, who)),
    sys.net.every(m => m.kind != Refusal or m.client != who or not(C::waiting(c, m.seq))),
  }

pure def alwaysALoneUsersTabKeepsInStepWithTheServer(sys: System): bool =
  (lone(sys, "a") implies inStep(sys, "a")) and (lone(sys, "b") implies inStep(sys, "b"))
```
