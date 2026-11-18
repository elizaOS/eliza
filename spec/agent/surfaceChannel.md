# Page command channel

The optional `@elizaos/agent/surface` module carries page commands from the
agent's browser tasks to the one browser surface the device shows. The
channel is transport only: the page rechecks its task, selected page and
document before it acts. The agent serves one owner, so an account change is
a new launch and needs no rule here.

The Root-only routes answer `POST /api/surface/connect {clientId, epoch}`
with `{connectionId}`, `pull {connectionId}` with `{command: {id, sequence,
effect, expiresAt, input} | null, cancellations: [id]}`, `reply
{connectionId, id, result | error: {code, message}}` with `{accepted: true}`
and `close {connectionId}` with `{closed: true}`. On the wire a connection
and a command are named by opaque random strings (`[A-Za-z0-9_.:-]{1,128}`)
that the model's integers stand for; `sequence` is the model's command id and
`expiresAt` its deadline in epoch ms. Refusals are `STALE_REF` and `BUSY`
409, `INVALID_REQUEST` 400 (413 past a size limit: 2 MiB for a reply body, a
reply result or a queued input, 4 KiB for any other body) and, for every
request after `shutdown`, `UNAVAILABLE` 503. An error code is `[A-Z_]{1,64}`
with a message of at most 1024 characters. A held pull is answered after
10 s at the latest.

The page client never reconnects by itself and runs each command at most
once. It does not start a command past its deadline (it answers
`STALE_REF`), aborts a running command named in `cancellations`, and when its
handler fails without a valid code it answers `pageFailureCode`. A repeated
or non-rising sequence, a deadline more than 30 s ahead or a seventeenth
active command stops the client, which closes the connection once (3 s
limit, ignoring `STALE_REF`) and so retires every pending command.

## Story: Retire delivered page commands without repeating a possible effect

> As the owner, I want a command sent to my browser page to run at most
> once, and if it might have run and its answer was lost, to be told its
> outcome is uncertain, so that a page action is never repeated behind my back.

### A connection opens only with an epoch higher than any seen before

The connection gets a fresh identity and lives 15 s past its opening and
each pull. A stale epoch is refused as `STALE_REF` and changes nothing. The
module exposes the current connection (`currentConnection`, 0 for none), so
a browser task can name the one it observed.

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
pure def currentConnection(s: Channel): int = if (s.connection > 0 and s.expiresAt > s.now) s.connection else 0
pure def canAdvance(s: Channel, elapse: int): bool = elapse > 0
pure def advance(s: Channel, elapse: int): Channel = { ...s, now: s.now + elapse }
pure def canConnect(s: Channel, epoch: int): bool = not(s.closed) and epoch >= 0 and epoch > s.highestEpoch
pure def connect(s: Channel, epoch: int): ChannelStep = {
  val retired = retirement(false, s)
  { state: { ...retired.state, highestEpoch: epoch, connection: s.opened + 1, opened: s.opened + 1, expiresAt: s.now + connectionTtlMs }, out: retired.out }
}
pure def alwaysPendingNeedsAConnection(s: Channel): bool = s.connection >= 0 and s.connection <= s.opened and (s.closed implies s.connection == 0) and (s.connection == 0 implies (s.pending.length() == 0 and not(s.holding) and s.cancellations.length() == 0))
pure def stepEpochsOnlyRise(before: Channel, after: Channel): bool = after.highestEpoch >= before.highestEpoch and ((after.connection != before.connection and after.connection != 0) implies (after.highestEpoch > before.highestEpoch and after.connection > before.opened))
pure def sometimesReconnected(s: Channel): bool = s.connection >= 2 and not(s.closed)
```

### Opening, closing, lapsing or stopping retires every pending command with one settlement each

A command already handed to the page that can have an effect is settled
`Uncertain` (`UNCERTAIN_OUTCOME`), any other `Stale` (`STALE_REF`); a held
pull is answered `STALE_REF`. No command leaves the queue without a
settlement, and the browser task receives each settlement once and decides
itself whether to observe the page and try again.

```quint
pure def canCloseConnection(s: Channel, connection: int): bool = isCurrent(s, connection)
pure def closeConnection(s: Channel, connection: int): ChannelStep = retirement(false, s)
pure def canLapse(s: Channel): bool = s.connection > 0 and s.expiresAt <= s.now
pure def lapse(s: Channel): ChannelStep = retirement(false, s)
pure def canShutdown(s: Channel): bool = not(s.closed)
pure def shutdown(s: Channel): ChannelStep = retirement(true, s)
pure def stepNoCommandVanishes(before: Channel, after: Channel, out: List[Settlement]): bool = before.pending.every(c => after.pending.some(d => d.id == c.id) or out.some(o => o.id == c.id))
pure def sometimesStopped(s: Channel): bool = s.closed and s.nextId >= 2
```

### The agent queues a command only on the current connection while fewer than sixteen are pending

A browser task names the connection it observed; a replaced or lapsed one
is refused as `STALE_REF`, and a seventeenth pending command as `BUSY`.
Every command declares whether it can have an effect and gets a 30 s
deadline. Its id is higher than any before it and the queue keeps send
order, so a new command is never taken for one already handed over.

```quint
pure val commandTimeoutMs = 30000
pure val maxPending = 16
pure def canSend(s: Channel, connection: int): bool = isCurrent(s, connection) and s.pending.length() < maxPending
pure def send(s: Channel, connection: int, effect: bool): Channel = { ...s, pending: s.pending.append({ id: s.nextId, effect: effect, deadline: s.now + commandTimeoutMs }), nextId: s.nextId + 1 }
pure def alwaysIdsAreFresh(s: Channel): bool = s.lastSequence >= 0 and s.lastSequence < s.nextId and s.pending.every(c => c.id >= 1 and c.id < s.nextId)
pure def alwaysPendingInSendOrder(s: Channel): bool = s.pending.foldl(0, (last, c) => if (last >= 0 and c.id > last) c.id else -1) >= 0
```

### A pull hands over only the oldest command not yet handed over, and only one pull waits at a time

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
pure def stepHandsOverOldestOnly(before: Channel, after: Channel): bool = before.pending.every(c => c.id <= before.lastSequence or c.id >= after.lastSequence)
pure def sometimesPullHeld(s: Channel): bool = s.holding
pure def sometimesTwoAwaitReplies(s: Channel): bool = s.pending.select(c => handedOver(c, s.lastSequence)).length() >= 2
```

### A reply settles only a handed-over command of the same connection before its deadline

The page answers with a result or with an error code, which reaches the
browser task unchanged. A reply for another connection, for a command not
handed over or already settled, or after the deadline is refused as
`STALE_REF` and settles nothing itself; before refusing a late reply the
shell runs the command's deadline `cancel`. A page whose handler failed
without a valid code answers `pageFailureCode`: uncertain only if the
command started and can have an effect.

```quint
pure val idValues = Set(1, 2, 3)
pure def canReply(s: Channel, connection: int, id: int, succeeded: bool): bool = isCurrent(s, connection) and s.pending.some(c => c.id == id and handedOver(c, s.lastSequence) and c.deadline > s.now)
pure def reply(s: Channel, connection: int, id: int, succeeded: bool): ChannelStep = { state: { ...s, pending: s.pending.select(c => c.id != id) }, out: List({ id: id, result: if (succeeded) Answered else PageRefused }) }
pure def pageFailureCode(started: bool, effect: bool): Outcome = if (started and effect) Uncertain else Stale
pure def sometimesEffectAwaitsReply(s: Channel): bool = s.pending.some(c => c.effect and handedOver(c, s.lastSequence))
```

### A command given up on is uncertain only if it was handed over and can have an effect

At its deadline, or when the browser task aborts, a pending command is
settled `Uncertain` if it was handed over and can have an effect, else
`Stale`. A handed-over command's id joins the cancellations the next pull
reports; handed-over commands and waiting cancellations together never
exceed sixteen. Whatever settles a command removes it, so no later reply,
pull or retirement settles it again, and no command is ever sent again: a
new attempt is a new command.

```quint
pure def canCancel(s: Channel, id: int): bool = s.pending.some(c => c.id == id)
pure def cancel(s: Channel, id: int): ChannelStep = {
  val wasHanded = id <= s.lastSequence
  val effect = s.pending.some(c => c.id == id and c.effect)
  { state: { ...s, pending: s.pending.select(c => c.id != id), cancellations: if (wasHanded) s.cancellations.append(id) else s.cancellations }, out: List({ id: id, result: if (wasHanded and effect) Uncertain else Stale }) }
}
pure def outcomeAllowed(c: Pending, result: Outcome, lastSequence: int): bool = if (result == Uncertain) handedOver(c, lastSequence) and c.effect else if (result == Stale) not(handedOver(c, lastSequence) and c.effect) else handedOver(c, lastSequence)
pure def alwaysCancellationsFitTheQueue(s: Channel): bool = s.pending.length() <= maxPending and s.pending.select(c => handedOver(c, s.lastSequence)).length() + s.cancellations.length() <= maxPending
pure def stepEverySettlementIsHonest(before: Channel, after: Channel, out: List[Settlement]): bool = out.every(o => before.pending.some(c => c.id == o.id and outcomeAllowed(c, o.result, before.lastSequence)))
pure def stepSettledCommandsLeave(before: Channel, after: Channel, out: List[Settlement]): bool = out.every(o => after.pending.every(c => c.id != o.id))
pure def sometimesCancellationWaiting(s: Channel): bool = s.cancellations.length() > 0
```
