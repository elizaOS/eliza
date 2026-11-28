# Discord coordination and turn lifecycle

Group channels with multiple agents coordinate replies through speaker leases and independent human and bot reply-slot budgets, while durable turn records reconcile replies across crashes so a message is never dropped or double-sent. Owner pairing enforces per-user rate limits, and voice playback enforces audio-lane preemption priority.

## Story: Coordinate Discord group replies and durable turn lifecycles

> As a Discord server owner, I want each inbound turn to hold at most one speaker lease within bounded retry and bot-reply budgets, reconcile already-sent replies after crashes, and release its lease on completion or failure.

### A durable turn claims a bounded speaker lease, budgets human and bot lanes independently, and reconciles already-stored replies

A fresh coordination state starts in `TurnIdle` with zero attempts, `maxAttempts = 3`, empty `leaseHolder`, `leaseEpoch = 0`, zero human and bot slots used, `botBudget = 2`, and `replyStored = false`. `receiveTurn` moves `TurnIdle` to `TurnReceived`. `claimLease` runs from `TurnReceived` with an empty `leaseHolder`, a non-empty `holder`, `attempts < maxAttempts`, and (for `BotLane`) `botSlotsUsed < botBudget`; it enters `TurnDispatched`, increments `attempts` and `leaseEpoch`, assigns `leaseHolder`, and increments either `humanSlotsUsed` (for `HumanLane`) or `botSlotsUsed` (for `BotLane`). `markReplyObserved` records `replyStored = true` while in `TurnDispatched` with a non-empty `leaseHolder` and `replyStored = false`. `recordReply` runs from `TurnDispatched` for the current `leaseHolder`, sets `replyStored = true`, clears `leaseHolder`, and enters `TurnReplied`. `reconcileReply` runs from `TurnReceived` or `TurnDispatched` when `replyStored` is already true, clears `leaseHolder`, and enters `TurnReplied`. `failAttempt` runs from `TurnDispatched` for the current `leaseHolder`, clears `leaseHolder`, and enters `TurnFailed` when `attempts >= maxAttempts` or returns to `TurnReceived` otherwise. `expireLease` runs from `TurnDispatched` with a non-empty `leaseHolder`, clears `leaseHolder`, and returns to `TurnReceived` when `attempts < maxAttempts` or enters `TurnFailed` when `attempts >= maxAttempts`. Across every state: `attempts` stays in `0..maxAttempts` with `maxAttempts > 0`, `leaseEpoch >= 0`, `humanSlotsUsed >= 0`, `botSlotsUsed` stays in `0..botBudget`, terminal phases (`TurnReplied` and `TurnFailed`) hold no lease, `TurnReplied` implies `replyStored`, and `TurnDispatched` implies positive `attempts` and a non-empty `leaseHolder`.

```quint
type DiscordTurnPhase = TurnIdle | TurnReceived | TurnDispatched | TurnReplied | TurnFailed
type DiscordReplyLane = HumanLane | BotLane
type DiscordCoordState = { phase: DiscordTurnPhase, attempts: int, maxAttempts: int, leaseHolder: str, leaseEpoch: int, humanSlotsUsed: int, botSlotsUsed: int, botBudget: int, replyStored: bool }
pure val initial: DiscordCoordState = { phase: TurnIdle, attempts: 0, maxAttempts: 3, leaseHolder: "", leaseEpoch: 0, humanSlotsUsed: 0, botSlotsUsed: 0, botBudget: 2, replyStored: false }
pure val holderValues = Set("agent-1", "agent-2", "")
pure def canReceiveTurn(s: DiscordCoordState): bool = s.phase == TurnIdle
pure def receiveTurn(s: DiscordCoordState): DiscordCoordState = { ...s, phase: TurnReceived }
pure def canClaimLease(s: DiscordCoordState, holder: str, lane: DiscordReplyLane): bool = s.phase == TurnReceived and s.leaseHolder == "" and holder != "" and s.attempts < s.maxAttempts and (lane == HumanLane or s.botSlotsUsed < s.botBudget)
pure def claimLease(s: DiscordCoordState, holder: str, lane: DiscordReplyLane): DiscordCoordState = { ...s, phase: TurnDispatched, attempts: s.attempts + 1, leaseHolder: holder, leaseEpoch: s.leaseEpoch + 1, humanSlotsUsed: if (lane == HumanLane) s.humanSlotsUsed + 1 else s.humanSlotsUsed, botSlotsUsed: if (lane == BotLane) s.botSlotsUsed + 1 else s.botSlotsUsed }
pure def canMarkReplyObserved(s: DiscordCoordState): bool = s.phase == TurnDispatched and s.leaseHolder != "" and not(s.replyStored)
pure def markReplyObserved(s: DiscordCoordState): DiscordCoordState = { ...s, replyStored: true }
pure def canRecordReply(s: DiscordCoordState, holder: str): bool = s.phase == TurnDispatched and holder != "" and s.leaseHolder == holder
pure def recordReply(s: DiscordCoordState, holder: str): DiscordCoordState = { ...s, phase: TurnReplied, leaseHolder: "", replyStored: true }
pure def canReconcileReply(s: DiscordCoordState): bool = (s.phase == TurnReceived or s.phase == TurnDispatched) and s.replyStored
pure def reconcileReply(s: DiscordCoordState): DiscordCoordState = { ...s, phase: TurnReplied, leaseHolder: "" }
pure def canFailAttempt(s: DiscordCoordState, holder: str): bool = s.phase == TurnDispatched and holder != "" and s.leaseHolder == holder
pure def failAttempt(s: DiscordCoordState, holder: str): DiscordCoordState = { ...s, phase: if (s.attempts >= s.maxAttempts) TurnFailed else TurnReceived, leaseHolder: "" }
pure def canExpireLease(s: DiscordCoordState): bool = s.phase == TurnDispatched and s.leaseHolder != ""
pure def expireLease(s: DiscordCoordState): DiscordCoordState = { ...s, phase: if (s.attempts >= s.maxAttempts) TurnFailed else TurnReceived, leaseHolder: "" }
pure def alwaysAttemptsBounded(s: DiscordCoordState): bool = s.maxAttempts > 0 and s.attempts >= 0 and s.attempts <= s.maxAttempts
pure def alwaysTerminalReleasesLease(s: DiscordCoordState): bool = (s.phase == TurnReplied or s.phase == TurnFailed) implies s.leaseHolder == ""
pure def alwaysRepliedHasStoredReply(s: DiscordCoordState): bool = s.phase == TurnReplied implies s.replyStored
pure def alwaysDispatchedHasLease(s: DiscordCoordState): bool = s.phase == TurnDispatched implies s.attempts > 0 and s.leaseHolder != ""
pure def alwaysSlotsBounded(s: DiscordCoordState): bool = s.leaseEpoch >= 0 and s.humanSlotsUsed >= 0 and s.botSlotsUsed >= 0 and s.botSlotsUsed <= s.botBudget
pure def sometimesTurnReplied(s: DiscordCoordState): bool = s.phase == TurnReplied and s.replyStored
pure def sometimesTurnRecoveredAfterCrash(s: DiscordCoordState): bool = s.phase == TurnReplied and s.replyStored and s.leaseEpoch == 1 and s.attempts == 1
pure def sometimesTurnFailedAtLimit(s: DiscordCoordState): bool = s.phase == TurnFailed and s.attempts == s.maxAttempts
pure val eval_witness_sometimesTurnReplied = ("receiveTurn", ("claimLease", "agent-1", HumanLane), ("recordReply", "agent-1"))
pure val eval_witness_sometimesTurnRecoveredAfterCrash = ("receiveTurn", ("claimLease", "agent-1", BotLane), "markReplyObserved", "expireLease", "reconcileReply")
pure val eval_witness_sometimesTurnFailedAtLimit = ("receiveTurn", ("claimLease", "agent-1", HumanLane), ("failAttempt", "agent-1"), ("claimLease", "agent-2", HumanLane), ("failAttempt", "agent-2"), ("claimLease", "agent-1", HumanLane), ("failAttempt", "agent-1"))
```

### Owner pairing enforces per-user and map-capacity rate limits, and voice audio lanes honor interruptibility and priority

An owner-pairing attempt is allowed only when `maxAttempts > 0`, `attemptsInWindow < maxAttempts`, and either the user is already tracked or `trackedUsers < maxTracked`. A voice audio lane preempts active playback only when the current lane is interruptible and the incoming lane's priority is at least the current lane's priority.

```quint
pure def discordPairAttemptAllowed(attemptsInWindow: int, trackedUsers: int, maxAttempts: int, maxTracked: int, alreadyTracked: bool): bool = maxAttempts > 0 and attemptsInWindow >= 0 and attemptsInWindow < maxAttempts and (alreadyTracked or (trackedUsers >= 0 and trackedUsers < maxTracked))
pure val attemptsInWindowValues = Set(0, 4, 5)
pure val trackedUsersValues = Set(0, 9999, 10000)
pure val maxAttemptsValues = Set(5)
pure val maxTrackedValues = Set(10000)
pure val alreadyTrackedValues = Set(false, true)
pure def lawPairRateLimitRejectsAtCap(attemptsInWindow: int, trackedUsers: int, maxAttempts: int, maxTracked: int, alreadyTracked: bool): bool = attemptsInWindow >= maxAttempts implies not(discordPairAttemptAllowed(attemptsInWindow, trackedUsers, maxAttempts, maxTracked, alreadyTracked))
pure def discordAudioLanePreempts(incomingPriority: int, currentPriority: int, currentInterruptible: bool): bool = currentInterruptible and incomingPriority >= currentPriority
pure val incomingPriorityValues = Set(10, 50, 100)
pure val currentPriorityValues = Set(10, 50, 100)
pure val currentInterruptibleValues = Set(false, true)
pure def lawNonInterruptibleLaneNeverPreempted(incomingPriority: int, currentPriority: int): bool = not(discordAudioLanePreempts(incomingPriority, currentPriority, false))
```
