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
command; it refuses a command whose id is not higher than the last it ran.

## Story: Retire delivered page commands without repeating a possible effect

> As the owner, I want a command sent to my browser page to run at most
> once, and if it might have run and its answer was lost, to be told its
> outcome is uncertain, so that a page action is never repeated behind my back.

### Only a connection with a higher epoch replaces the current one, and it retires every pending command

The page opens a connection with an epoch higher than any the process has
seen; the connection gets a fresh identity and lives 15 s past its opening
and each pull. A stale epoch is refused (409 `STALE_REF`) and changes
nothing. Opening a connection, closing it, letting it lapse and stopping the
process all retire it, and with it every command still pending: a command
delivered and able to have an effect becomes `Uncertain`
(`UNCERTAIN_OUTCOME`), any other becomes `Stale` (`STALE_REF`).

```quint
type CommandPhase = Queued | Delivered | Answered | PageRefused | Uncertain | Stale
type PageCommand = { id: int, connection: int, effect: bool, deadline: int, phase: CommandPhase }
type Channel = { now: int, highestEpoch: int, connection: int, opened: int, expiresAt: int, holding: bool, cancellations: List[int], commands: List[PageCommand], nextId: int, closed: bool }
pure val initial: Channel = { now: 0, highestEpoch: -1, connection: 0, opened: 0, expiresAt: 0, holding: false, cancellations: List(), commands: List(), nextId: 1, closed: false }
pure val connectionTtlMs = 15000
pure val epochValues = Set(-1, 0, 1, 2)
pure val connectionValues = Set(0, 1, 2)
pure val elapseValues = Set(5000, 16000, 31000)
pure def isPending(c: PageCommand): bool = c.phase == Queued or c.phase == Delivered
pure def retiredPhase(c: PageCommand): CommandPhase = if (c.phase == Delivered and c.effect) Uncertain else Stale
pure def retireCommand(c: PageCommand): PageCommand = if (isPending(c)) { ...c, phase: retiredPhase(c) } else c
pure def retiredIn(close: bool, s: Channel): Channel = { ...s, connection: 0, expiresAt: 0, holding: false, cancellations: List(), commands: s.commands.listMap(c => retireCommand(c)), closed: s.closed or close }
pure def isCurrent(s: Channel, connection: int): bool = connection > 0 and connection == s.connection and s.expiresAt > s.now
pure def canAdvance(s: Channel, elapse: int): bool = elapse > 0
pure def advance(s: Channel, elapse: int): Channel = { ...s, now: s.now + elapse }
pure def canConnect(s: Channel, epoch: int): bool = not(s.closed) and epoch >= 0 and epoch > s.highestEpoch
pure def connect(s: Channel, epoch: int): Channel = {
  val retired = retiredIn(false, s)
  { ...retired, highestEpoch: epoch, connection: s.opened + 1, opened: s.opened + 1, expiresAt: s.now + connectionTtlMs }
}
pure def canCloseConnection(s: Channel, connection: int): bool = isCurrent(s, connection)
pure def closeConnection(s: Channel, connection: int): Channel = retiredIn(false, s)
pure def canLapse(s: Channel): bool = s.connection > 0 and s.expiresAt <= s.now
pure def lapse(s: Channel): Channel = retiredIn(false, s)
pure def canShutdown(s: Channel): bool = not(s.closed)
pure def shutdown(s: Channel): Channel = retiredIn(true, s)
pure def alwaysPendingBelongsToTheCurrentConnection(s: Channel): bool = s.commands.every(c => isPending(c) implies (s.connection > 0 and c.connection == s.connection))
pure def alwaysAClosedChannelHasNoConnection(s: Channel): bool = (s.closed implies s.connection == 0) and (s.connection == 0 implies (not(s.holding) and s.cancellations.length() == 0))
pure def stepEpochsOnlyRise(before: Channel, after: Channel): bool = after.highestEpoch >= before.highestEpoch and (after.connection == before.connection or after.connection == 0 or after.connection > before.opened)
pure def sometimesReconnected(s: Channel): bool = s.connection >= 2 and not(s.closed)
pure def sometimesStoppedWithUncertainCommand(s: Channel): bool = s.closed and s.commands.some(c => c.phase == Uncertain)
```

### The agent queues a command only on the current connection, at most sixteen pending, each with a 30 s deadline

A browser task names the connection it observed; a replaced or lapsed one
is refused as `STALE_REF`, and a seventeenth pending command as `BUSY`.
Every command declares whether it can have an effect, and gets an id higher
than any before it.

```quint
pure val commandTimeoutMs = 30000
pure val maxPending = 16
pure def pendingCount(s: Channel): int = s.commands.select(c => isPending(c)).length()
pure def canSend(s: Channel, connection: int, effect: bool): bool = isCurrent(s, connection) and pendingCount(s) < maxPending
pure def send(s: Channel, connection: int, effect: bool): Channel = { ...s, commands: s.commands.append({ id: s.nextId, connection: connection, effect: effect, deadline: s.now + commandTimeoutMs, phase: Queued }), nextId: s.nextId + 1 }
pure def alwaysIdsAreFresh(s: Channel): bool = s.nextId >= 1 and s.connection >= 0 and s.connection <= s.opened and s.commands.every(c => c.id >= 1 and c.id < s.nextId and c.connection >= 1 and c.connection <= s.opened and s.commands.select(o => o.id == c.id).length() == 1)
pure def alwaysPendingIsBounded(s: Channel): bool = pendingCount(s) <= maxPending
```

### A pull delivers the oldest queued command once, and only one pull waits at a time

A pull refreshes the connection's 15 s life. With nothing to deliver and no
cancellation to report it is held; a second pull while one is held is
refused as `BUSY`. Delivery is recorded before the pull answers, so a lost
answer never delivers the command again. A queued command whose deadline
has passed is not delivered: the pull retires it as `Stale` and answers
with no command. The answer also carries, once, the ids of delivered
commands the agent has since given up on, so the page can abort them.

```quint
pure val noCommand: PageCommand = { id: 0, connection: 0, effect: false, deadline: 0, phase: Stale }
pure def nextQueued(s: Channel): PageCommand = s.commands.select(c => c.phase == Queued).nthOr(0, noCommand)
pure def hasWork(s: Channel): bool = nextQueued(s).id > 0 or s.cancellations.length() > 0
pure def deliveryIn(connection: int, s: Channel): Channel = {
  val oldest = nextQueued(s)
  { ...s, holding: false, cancellations: List(), expiresAt: s.now + connectionTtlMs, commands: s.commands.listMap(c => if (oldest.id > 0 and c.id == oldest.id) { ...c, phase: if (c.deadline > s.now) Delivered else Stale } else c) }
}
pure def canPull(s: Channel, connection: int): bool = isCurrent(s, connection) and not(s.holding)
pure def pull(s: Channel, connection: int): Channel = if (hasWork(s)) deliveryIn(connection, s) else { ...s, holding: true, expiresAt: s.now + connectionTtlMs }
pure def canAnswerHeldPull(s: Channel, connection: int): bool = isCurrent(s, connection) and s.holding
pure def answerHeldPull(s: Channel, connection: int): Channel = deliveryIn(connection, s)
pure def commandIn(id: int, s: Channel): PageCommand = s.commands.select(c => c.id == id).nthOr(0, noCommand)
pure def stepDeliveredOnceNeverRequeued(before: Channel, after: Channel): bool = before.commands.every(c => c.phase != Queued implies commandIn(c.id, after).phase != Queued) and after.commands.select(c => c.phase == Delivered and commandIn(c.id, before).phase != Delivered).every(c => commandIn(c.id, before).phase == Queued) and after.commands.select(c => c.phase == Delivered and commandIn(c.id, before).phase == Queued).length() <= 1
pure def sometimesPullHeld(s: Channel): bool = s.holding
pure def sometimesTwoDelivered(s: Channel): bool = s.commands.select(c => c.phase == Delivered).length() >= 2
```

### A reply settles only a delivered command of the same connection before its deadline

The page answers with a result or with an error code, which reaches the
browser task unchanged. A reply for another connection, for a command not
delivered or already settled, or after the deadline is refused as
`STALE_REF` and settles nothing.

```quint
pure val idValues = Set(1, 2, 3)
pure def canReply(s: Channel, connection: int, id: int, succeeded: bool): bool = isCurrent(s, connection) and commandIn(id, s).phase == Delivered and commandIn(id, s).connection == connection and commandIn(id, s).deadline > s.now
pure def reply(s: Channel, connection: int, id: int, succeeded: bool): Channel = { ...s, commands: s.commands.listMap(c => if (c.id == id) { ...c, phase: if (succeeded) Answered else PageRefused } else c) }
pure def sometimesAnswered(s: Channel): bool = s.commands.some(c => c.phase == Answered)
pure def sometimesPageRefused(s: Channel): bool = s.commands.some(c => c.phase == PageRefused)
```

### A command the agent gives up on is retired, and a delivered one is reported to the page as cancelled

At its deadline, or when the browser task aborts, a pending command is
retired as `Uncertain` if it was delivered and can have an effect, else as
`Stale`. A delivered command's id joins the cancellations the next pull
reports; when sixteen are already waiting, the whole connection is retired
instead. No command is ever sent again: a new attempt is a new command the
task decides on after it observes the page.

```quint
pure val maxCancellations = 16
pure def canCancel(s: Channel, id: int): bool = isPending(commandIn(id, s))
pure def cancel(s: Channel, id: int): Channel = {
  val delivered = commandIn(id, s).phase == Delivered
  if (delivered and s.cancellations.length() >= maxCancellations) retiredIn(false, s)
  else { ...s, cancellations: if (delivered) s.cancellations.append(id) else s.cancellations, commands: s.commands.listMap(c => if (c.id == id) retireCommand(c) else c) }
}
pure def settledFrom(c: PageCommand, later: CommandPhase): bool = (later == Uncertain implies (c.phase == Uncertain or (c.phase == Delivered and c.effect))) and ((later == Answered or later == PageRefused) implies (later == c.phase or c.phase == Delivered)) and not(c.phase == Delivered and c.effect and later == Stale)
pure def stepUncertainOnlyAfterAnEffectfulDelivery(before: Channel, after: Channel): bool = before.commands.every(c => settledFrom(c, commandIn(c.id, after).phase))
pure def sometimesCancellationWaiting(s: Channel): bool = s.cancellations.length() > 0
pure def sometimesUndeliveredStale(s: Channel): bool = s.connection > 0 and s.commands.some(c => c.phase == Stale and c.effect)
```

### The browser task takes a settled outcome once, and its command is forgotten

A settled command stays until the browser task has taken its outcome; its
id is never reused, so no later reply or pull can reach it.

```quint
pure def canTake(s: Channel, id: int): bool = commandIn(id, s).id > 0 and not(isPending(commandIn(id, s)))
pure def take(s: Channel, id: int): Channel = { ...s, commands: s.commands.select(c => c.id != id) }
pure def stepSettledOutcomeNeverChanges(before: Channel, after: Channel): bool = before.commands.every(c => isPending(c) or commandIn(c.id, after).id == 0 or commandIn(c.id, after).phase == c.phase)
pure def sometimesTaken(s: Channel): bool = s.nextId >= 3 and s.commands.length() == 0 and s.connection > 0
```
