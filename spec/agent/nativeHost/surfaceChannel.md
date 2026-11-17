# Page command channel

The native host carries page commands to a browser page over an owner-bound
channel. This transport sits beneath the agent's browser tasks and the
[browser command receiver](../../os/browser/commandReceiver.md). The
owner-bound command channel cannot supply task or page authorization. The
receiver makes those checks again before acting. A change of owner retires
the connection, so a reply from the old owner cannot settle a command of
the new one.

## Story: Retire delivered page commands without repeating a possible effect

> As a user, a command sent to a browser page runs at most once, and if it
> might have run I am told its outcome is uncertain rather than seeing it
> repeated.

### A command is delivered once to its current connection

A connection has a fresh identity and a renderer epoch higher than any
before it, and lives fifteen seconds past its last delivery. Pull and
reply present the exact connection and are checked against the current
owner. A command, with a timeout of at most thirty seconds, is delivered
once: delivery is consumed before the pull answers, so a lost answer
cannot replay it. Retiring the connection after an effectful command was
delivered makes its outcome uncertain; an undelivered or read-only
command is reported stale instead.

The channel holds at most sixteen pending commands and delivers the oldest
undelivered one first; at most one pull waits, for at most ten seconds,
and this model follows one command. Before any transition, the host's
decoder checks the exact route, the command fields, UTF-8 JSON within its
size bound and the typed result or error shape.

```quint
type CommandPhase = NoCommand | QueuedCommand | DeliveredCommand | SettledCommand | StaleCommand | UncertainCommand
type Channel = { highestEpoch: int, connection: int, serial: int, actor: str, expiresAt: int, now: int, command: int, commandSerial: int, commandScope: int, deadline: int, effectful: bool, phase: CommandPhase, closed: bool }
pure val initial: Channel = { highestEpoch: -1, connection: 0, serial: 0, actor: "", expiresAt: 0, now: 0, command: 0, commandSerial: 0, commandScope: 0, deadline: 0, effectful: false, phase: NoCommand, closed: false }
pure def retiresPending(c: Channel): CommandPhase = if (c.phase == DeliveredCommand and c.effectful) UncertainCommand else if (c.phase == DeliveredCommand or c.phase == QueuedCommand) StaleCommand else c.phase
pure def canConnect(c: Channel, actor: str, epoch: int): bool = not(c.closed) and actor != "" and epoch >= 0 and epoch > c.highestEpoch
pure def connect(c: Channel, actor: str, epoch: int): Channel = { ...c, highestEpoch: epoch, connection: c.serial + 1, serial: c.serial + 1, actor: actor, expiresAt: c.now + 15000, phase: retiresPending(c) }
pure def observeClock(c: Channel, now: int): Channel = { ...c, now: now }
pure def matchesConnection(c: Channel, actor: str, connection: int): bool = connection > 0 and connection == c.connection and actor == c.actor and c.expiresAt > c.now
pure def canQueueCommand(c: Channel, actor: str, connection: int, timeout: int): bool = matchesConnection(c, actor, connection) and timeout >= 1 and timeout <= 30000 and c.phase != QueuedCommand and c.phase != DeliveredCommand
pure def queueCommand(c: Channel, actor: str, connection: int, timeout: int, effectful: bool): Channel = { ...c, command: c.commandSerial + 1, commandSerial: c.commandSerial + 1, commandScope: connection, deadline: c.now + timeout, phase: QueuedCommand, effectful: effectful }
pure def canDeliverCommand(c: Channel, actor: str, connection: int): bool = matchesConnection(c, actor, connection) and c.phase == QueuedCommand and c.commandScope == connection and c.deadline > c.now
pure def deliverCommand(c: Channel, actor: str, connection: int): Channel = { ...c, phase: DeliveredCommand, expiresAt: c.now + 15000 }
pure def canSettleCommand(c: Channel, actor: str, connection: int, command: int): bool = matchesConnection(c, actor, connection) and c.phase == DeliveredCommand and c.commandScope == connection and c.command == command and c.deadline > c.now
pure def settleCommand(c: Channel, actor: str, connection: int, command: int): Channel = { ...c, phase: SettledCommand }
pure def canExpireCommand(c: Channel): bool = (c.phase == QueuedCommand or c.phase == DeliveredCommand) and c.now >= c.deadline
pure def expireCommand(c: Channel): Channel = { ...c, phase: retiresPending(c) }
pure def retireChannel(c: Channel, close: bool): Channel = { ...c, connection: 0, actor: "", expiresAt: 0, phase: retiresPending(c), closed: c.closed or close }
pure val actorValues = Set("", "owner", "new-owner")
pure val epochValues = Set(-1, 0, 1, 2)
pure val connectionValues = Set(0, 1, 2, 3)
pure val timeoutValues = Set(0, 10000, 30001)
pure val nowValues = Set(0, 10000, 15000)
pure val commandValues = Set(1, 2, 3)
pure def alwaysConnectionCoordinates(c: Channel): bool = c.serial >= 0 and c.highestEpoch >= -1 and c.connection >= 0 and c.connection <= c.serial and (c.connection == 0) == (c.actor == "") and (c.closed implies c.connection == 0)
pure def alwaysPendingHasOwner(c: Channel): bool = c.commandSerial >= 0 and c.command >= 0 and c.command <= c.commandSerial and ((c.phase == QueuedCommand or c.phase == DeliveredCommand) implies c.command > 0 and c.connection > 0 and c.commandScope == c.connection)
pure def stepDeliveredCannotReturnToQueue(before: Channel, after: Channel): bool = before.phase == DeliveredCommand and before.command == after.command implies after.phase != QueuedCommand
pure def sometimesDeliverySettles(c: Channel): bool = c.phase == SettledCommand
pure def sometimesDeliveredEffectRetiresUncertain(c: Channel): bool = c.phase == UncertainCommand
```

## Story: Hand a page command to the current document once

> As a user, I want a command to reach only the page document it was meant
> for, so a reply that was lost never makes the page act twice.

### The page end accepts a command only for its current document and a newer sequence, consumed before it runs

The last hop runs in an isolated world of the page's main frame, on an
http or https page, through a channel the website itself never receives.
Each document gets a fresh opaque identifier. The page end accepts a
command only while it is active, for its current document, with a
sequence number higher than any it accepted before, and records that
sequence before running the command, so a lost reply never replays an
effect. It runs only the fixed page commands; an input needs a policy
issued by the host, and a history step only the one the host observed,
against an unchanged history. The native end keeps one command waiting
at a time and refuses another as busy before sending it, so the refusal
spends no sequence and the same command can be sent again once the first
has settled. Hiding, pausing or navigating the
page, or five seconds without a reply, interrupts the waiting command:
an effect is then reported uncertain and anything else stale, and a
navigation retires the document, so its later replies are ignored.

```quint
type PageChannelCommand = PageSnapshot | PageInput | PageGuide | PageHistoryStep | PageOther
type PageChannelRequest = { active: bool, sameDocument: bool, nativeWaiting: bool, sequence: int, lastSequence: int, command: PageChannelCommand, hostPolicy: bool, historyUnchanged: bool }
type PageChannelReply = PageAccepted | PageStaleRef | PageBusy | PageUnsupported | PagePolicyBlocked
pure def pageChannelReply(req: PageChannelRequest): PageChannelReply =
  if (not(req.active and req.sameDocument)) PageStaleRef
  else if (req.nativeWaiting) PageBusy
  else if (not(req.sequence > req.lastSequence)) PageStaleRef
  else if (req.command == PageOther) PageUnsupported
  else if (req.command == PageInput and not(req.hostPolicy)) PagePolicyBlocked
  else if (req.command == PageHistoryStep and not(req.historyUnchanged)) PageStaleRef
  else PageAccepted
pure def sequenceAfter(req: PageChannelRequest): int =
  if (req.active and req.sameDocument and not(req.nativeWaiting) and req.sequence > req.lastSequence) req.sequence else req.lastSequence
type InterruptReply = InterruptUncertain | InterruptStale
pure def interruptReply(effect: bool): InterruptReply = if (effect) InterruptUncertain else InterruptStale
pure def lawSpentSequenceIsNeverAcceptedAgain(req: PageChannelRequest): bool =
  pageChannelReply(req) == PageAccepted implies req.sequence > req.lastSequence and sequenceAfter(req) == req.sequence and pageChannelReply({ ...req, lastSequence: sequenceAfter(req) }) == PageStaleRef
pure def lawInputNeedsHostPolicy(req: PageChannelRequest): bool =
  pageChannelReply(req) == PageAccepted and req.command == PageInput implies req.hostPolicy
pure def lawABusyRefusalSpendsNothing(req: PageChannelRequest): bool =
  req.active and req.sameDocument and req.nativeWaiting implies pageChannelReply(req) == PageBusy and sequenceAfter(req) == req.lastSequence
pure def lawInterruptedEffectIsUncertain(effect: bool): bool = (interruptReply(effect) == InterruptUncertain) iff effect
pure val currentRequest: PageChannelRequest = { active: true, sameDocument: true, nativeWaiting: false, sequence: 2, lastSequence: 1, command: PageInput, hostPolicy: true, historyUnchanged: true }
pure val reqValues = Set(currentRequest, { ...currentRequest, sequence: 1 }, { ...currentRequest, sameDocument: false }, { ...currentRequest, active: false },
  { ...currentRequest, hostPolicy: false }, { ...currentRequest, command: PageOther }, { ...currentRequest, command: PageHistoryStep, historyUnchanged: false },
  { ...currentRequest, command: PageSnapshot, hostPolicy: false }, { ...currentRequest, nativeWaiting: true }, { ...currentRequest, nativeWaiting: true, sequence: 1 })
pure val effectValues = Set(true, false)
```
