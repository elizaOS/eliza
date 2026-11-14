# Account-bound website command transport

Grace uses `createSurfaceCommandChannel` and `connectSurfaceCommandClient`
from `packages/agent/native-host/surface-channel.mjs` and
`surface-client.mjs`. This transport sits beneath [website guidance](./grace/websiteGuide.md).
The owner-bound command channel cannot supply task or page authorization.
The receiver makes those checks again before acting.

## Story: Retire delivered website commands without repeating a possible effect

### A command is delivered once to its current connection

Connect selects a fresh connection identity and an increasing renderer
epoch. Retirement retains the highest epoch. Pull and reply present the
exact connection and obtain a fresh owner check. The idle pull may wait
up to ten seconds, and the connection refreshes its fifteen-second TTL.
The actual channel holds up to sixteen pending commands, chooses the
oldest undelivered command, and permits one waiting pull. This model
tracks one command and its exact scope and deadline. The sender consumes
delivery before returning the pull response, so a lost response cannot
cause a replay. Retirement after delivery makes an effect uncertain.
An undelivered or read-only command can instead be reported stale. The
host decoder checks the exact route, command fields, bounded UTF-8 JSON
and typed result/error shape before applying these transitions.

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
