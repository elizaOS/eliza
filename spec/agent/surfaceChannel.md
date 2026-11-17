# Page command channel

The optional `@elizaos/agent/surface` module carries page commands from the
agent's browser tasks to the one browser surface the device shows, over the
Root-only routes `POST /api/surface/connect {clientId, epoch}`,
`POST /api/surface/pull {connectionId}`,
`POST /api/surface/reply {connectionId, id, result | error}` and
`POST /api/surface/close {connectionId}`. The source is
`packages/agent/native-host/surface-channel.mjs`, with the browser client
`surface-client.mjs` and the Quint model `api-native-surface`.

The channel is transport only. It never authorizes a task or a page: the
page end checks its task, selected page and document again before it acts.
The agent serves one owner, so an account change is a new launch and needs
no rule here. The shell keeps the plumbing: the route decoders (an id is
`[A-Za-z0-9_.:-]{1,128}`, an error code `[A-Z_]{1,64}` with a message of at
most 1024 characters, a body of at most 2 MiB), the timers, and the held
pull, which is answered when a command or a cancellation arrives or after
10 s. The browser client never reconnects by itself and never retries a
command; it refuses a command whose sequence is not higher than the last it ran.

## Story: Retire delivered page commands without repeating a possible effect

> As the owner, I want a command sent to my browser page to run at most
> once, and if it might have run and its answer was lost, to be told its
> outcome is uncertain, so that a page action is never repeated behind my back.

### Only a connection with a higher epoch replaces the current one, and it retires every pending command

The page opens a connection with an epoch higher than any the process has
seen; the connection gets a fresh identity and lives 15 s past its opening
and each pull. A stale epoch is refused (409 `STALE_REF`) and changes
nothing. Opening a connection, closing it, letting it lapse and stopping the
process all retire it, and with it every pending command: one already handed
to the page that can have an effect is settled `Uncertain`
(`UNCERTAIN_OUTCOME`), any other `Stale` (`STALE_REF`). The browser task
receives each settlement once and decides itself whether to observe the
page and try again.

```quint
type Pending = { id: int, effect: bool, deadline: int }
type Outcome = Answered | PageRefused | Uncertain | Stale
type Settlement = { id: int, result: Outcome }
type Channel = { now: int, highestEpoch: int, connection: int, opened: int, expiresAt: int, holding: bool, cancellations: List[int], pending: List[Pending], lastSequence: int, nextId: int, closed: bool }
type ChannelStep = { state: Channel, out: List[Settlement] }
pure val initial: Channel = { now: 0, highestEpoch: -1, connection: 0, opened: 0, expiresAt: 0, holding: false, cancellations: List(), pending: List(), lastSequence: 0, nextId: 1, closed: false }
pure val connectionTtlMs = 15000
pure val epochValues = Set(-1, 0, 1, 2)
pure val connectionValues = Set(0, 1, 2)
pure val elapseValues = Set(5000, 16000, 31000)
pure def handedOver(c: Pending, lastSequence: int): bool = c.id <= lastSequence
pure def retiredOutcome(c: Pending, lastSequence: int): Outcome = if (handedOver(c, lastSequence) and c.effect) Uncertain else Stale
pure def retirement(close: bool, s: Channel): ChannelStep = { state: { ...s, connection: 0, expiresAt: 0, holding: false, cancellations: List(), pending: List(), closed: s.closed or close }, out: s.pending.listMap(c => { id: c.id, result: retiredOutcome(c, s.lastSequence) }) }
pure def isCurrent(s: Channel, connection: int): bool = connection > 0 and connection == s.connection and s.expiresAt > s.now
pure def canAdvance(s: Channel, elapse: int): bool = elapse > 0
pure def advance(s: Channel, elapse: int): Channel = { ...s, now: s.now + elapse }
pure def canConnect(s: Channel, epoch: int): bool = not(s.closed) and epoch >= 0 and epoch > s.highestEpoch
pure def connect(s: Channel, epoch: int): ChannelStep = {
  val retired = retirement(false, s)
  { state: { ...retired.state, highestEpoch: epoch, connection: s.opened + 1, opened: s.opened + 1, expiresAt: s.now + connectionTtlMs }, out: retired.out }
}
pure def canCloseConnection(s: Channel, connection: int): bool = isCurrent(s, connection)
pure def closeConnection(s: Channel, connection: int): ChannelStep = retirement(false, s)
pure def canLapse(s: Channel): bool = s.connection > 0 and s.expiresAt <= s.now
pure def lapse(s: Channel): ChannelStep = retirement(false, s)
pure def canShutdown(s: Channel): bool = not(s.closed)
pure def shutdown(s: Channel): ChannelStep = retirement(true, s)
pure def alwaysPendingNeedsAConnection(s: Channel): bool = s.connection >= 0 and s.connection <= s.opened and (s.closed implies s.connection == 0) and (s.connection == 0 implies (s.pending.length() == 0 and not(s.holding) and s.cancellations.length() == 0))
pure def stepEpochsOnlyRise(before: Channel, after: Channel): bool = after.highestEpoch >= before.highestEpoch and (after.connection == before.connection or after.connection == 0 or after.connection > before.opened)
pure def sometimesReconnected(s: Channel): bool = s.connection >= 2 and not(s.closed)
pure def sometimesStopped(s: Channel): bool = s.closed and s.nextId >= 2
```

### The agent queues a command only on the current connection, at most sixteen pending, each with a 30 s deadline

A browser task names the connection it observed; a replaced or lapsed one
is refused as `STALE_REF`, and a seventeenth pending command as `BUSY`.
Every command declares whether it can have an effect. Its id is its
sequence: higher than any id before it, so a new command is never taken for
one already handed over.

```quint
pure val commandTimeoutMs = 30000
pure val maxPending = 16
pure def canSend(s: Channel, connection: int, effect: bool): bool = isCurrent(s, connection) and s.pending.length() < maxPending
pure def send(s: Channel, connection: int, effect: bool): Channel = { ...s, pending: s.pending.append({ id: s.nextId, effect: effect, deadline: s.now + commandTimeoutMs }), nextId: s.nextId + 1 }
pure def alwaysIdsAreFresh(s: Channel): bool = s.lastSequence >= 0 and s.lastSequence < s.nextId and s.pending.every(c => c.id >= 1 and c.id < s.nextId)
```

### A pull hands over the oldest command not yet handed over, once, and only one pull waits at a time

A pull refreshes the connection's 15 s life. With nothing to hand over and
no cancellation to report it is held; a second pull while one is held is
refused as `BUSY`. The hand-over is recorded, by raising the last sequence
to the command's id, before the pull answers, so a lost answer never hands
the command over again. A command whose deadline has passed is not handed
over: the pull settles it `Stale` and answers with no command. The answer
also carries, once, the ids of handed-over commands the agent has since
given up on, so the page can abort them.

```quint
pure val noCommand: Pending = { id: 0, effect: false, deadline: 0 }
pure def nextToHand(s: Channel): Pending = s.pending.select(c => c.id > s.lastSequence).nthOr(0, noCommand)
pure def hasWork(s: Channel): bool = nextToHand(s).id > 0 or s.cancellations.length() > 0
pure def handOver(connection: int, s: Channel): ChannelStep = {
  val oldest = nextToHand(s)
  val answered = { ...s, holding: false, cancellations: List(), expiresAt: s.now + connectionTtlMs }
  if (oldest.id == 0) { state: answered, out: List() }
  else if (oldest.deadline > s.now) { state: { ...answered, lastSequence: oldest.id }, out: List() }
  else { state: { ...answered, pending: s.pending.select(c => c.id != oldest.id) }, out: List({ id: oldest.id, result: Stale }) }
}
pure def canPull(s: Channel, connection: int): bool = isCurrent(s, connection) and not(s.holding)
pure def pull(s: Channel, connection: int): ChannelStep = if (hasWork(s)) handOver(connection, s) else { state: { ...s, holding: true, expiresAt: s.now + connectionTtlMs }, out: List() }
pure def canAnswerHeldPull(s: Channel, connection: int): bool = isCurrent(s, connection) and s.holding
pure def answerHeldPull(s: Channel, connection: int): ChannelStep = handOver(connection, s)
pure def stepSequenceOnlyRises(before: Channel, after: Channel): bool = after.lastSequence >= before.lastSequence and after.nextId >= before.nextId
pure def sometimesPullHeld(s: Channel): bool = s.holding
pure def sometimesTwoAwaitReplies(s: Channel): bool = s.pending.select(c => handedOver(c, s.lastSequence)).length() >= 2
```

### A reply settles only a handed-over command of the same connection before its deadline

The page answers with a result or with an error code, which reaches the
browser task unchanged. A reply for another connection, for a command not
handed over or already settled, or after the deadline is refused as
`STALE_REF` and settles nothing.

```quint
pure val idValues = Set(1, 2, 3)
pure def canReply(s: Channel, connection: int, id: int, succeeded: bool): bool = isCurrent(s, connection) and s.pending.some(c => c.id == id and handedOver(c, s.lastSequence) and c.deadline > s.now)
pure def reply(s: Channel, connection: int, id: int, succeeded: bool): ChannelStep = { state: { ...s, pending: s.pending.select(c => c.id != id) }, out: List({ id: id, result: if (succeeded) Answered else PageRefused }) }
pure def sometimesEffectAwaitsReply(s: Channel): bool = s.pending.some(c => c.effect and handedOver(c, s.lastSequence))
```

### A command the agent gives up on is settled once, uncertain only if it was handed over and can have an effect

At its deadline, or when the browser task aborts, a pending command is
settled `Uncertain` if it was handed over and can have an effect, else
`Stale`. A handed-over command's id joins the cancellations the next pull
reports; when sixteen are already waiting, the whole connection is retired
instead. Whatever settles a command removes it, so no later reply, pull or
retirement settles it again, and no command is ever sent again: a new
attempt is a new command.

```quint
pure val maxCancellations = 16
pure def canCancel(s: Channel, id: int): bool = s.pending.some(c => c.id == id)
pure def cancel(s: Channel, id: int): ChannelStep = {
  val wasHanded = id <= s.lastSequence
  val effect = s.pending.some(c => c.id == id and c.effect)
  if (wasHanded and s.cancellations.length() >= maxCancellations) retirement(false, s)
  else { state: { ...s, pending: s.pending.select(c => c.id != id), cancellations: if (wasHanded) s.cancellations.append(id) else s.cancellations }, out: List({ id: id, result: if (wasHanded and effect) Uncertain else Stale }) }
}
pure def outcomeAllowed(c: Pending, result: Outcome, lastSequence: int): bool = if (result == Uncertain) handedOver(c, lastSequence) and c.effect else if (result == Stale) not(handedOver(c, lastSequence) and c.effect) else handedOver(c, lastSequence)
pure def stepEverySettlementIsHonest(before: Channel, after: Channel, out: List[Settlement]): bool = out.every(o => before.pending.some(c => c.id == o.id and outcomeAllowed(c, o.result, before.lastSequence)))
pure def stepSettledCommandsLeave(before: Channel, after: Channel, out: List[Settlement]): bool = out.every(o => after.pending.every(c => c.id != o.id))
pure def sometimesCancellationWaiting(s: Channel): bool = s.cancellations.length() > 0
```
