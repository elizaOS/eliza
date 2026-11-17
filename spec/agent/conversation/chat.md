# Chat prompts and idempotent replies

The agent's chat routes send a prompt to one conversation and stream one
reply for it, and the chat idempotency service makes a repeated request with the same key share the first request's reply. Conversation
records and their mutation queue are in [conversations](./conversations.md);
turn cancellation is in [turns](./turns.md); the stream frames are in
[events](./events.md). A device host reaches these routes through the
[chat gateway](./chatGateway.md) and its [ownership](./ownership.md) checks.

## Story: Send one prompt and get one reply even when the request is repeated

> As a user, I can send a message again after a dropped connection and get
> the reply to my first send, never a second reply or someone else's.

### One idempotency key has at most one reservation, and a settled key holds its receipt

A request carrying an idempotency key acquires the key's reservation, with a
fresh generation, for its owner and the fingerprint of its request body. A
repeated request with the same fingerprint waits on that reservation; a
different fingerprint cannot join it. Settling notifies every waiter and
records a receipt for that generation. A receipt exists exactly while the
key is settled, and a vacant key has no owner.

```quint
type KeyPhase = KeyVacant | KeyActive | KeySettled
type Reservation = { phase: KeyPhase, owner: int, fingerprint: int, generation: int, receiptGeneration: int, waiters: int, receipt: bool, expired: bool }
type PromptPhase = PromptIdle | PromptResolving | PromptReading | PromptPersisting | PromptPersisted | PromptFinished
type PromptOutcome = NoOutcome | NotAdmitted | Completed | Failed | Cancelled | Denied
type Prompt = { epoch: int, captured: int, requested: int, active: int, present: Set[int], owned: Set[int], phase: PromptPhase, result: int, verified: bool, roomValid: bool, persisted: bool, verdict: PromptOutcome, delivered: bool, runCompleted: bool }
type Chat = { key: Reservation, prompt: Prompt }
pure val vacantKey: Reservation = { phase: KeyVacant, owner: 0, fingerprint: 0, generation: 0, receiptGeneration: 0, waiters: 0, receipt: false, expired: false }
pure val idlePrompt: Prompt = { epoch: 0, captured: 0, requested: 0, active: 2, present: Set(1, 2), owned: Set(1, 2), phase: PromptIdle, result: 0, verified: false, roomValid: false, persisted: false, verdict: NoOutcome, delivered: false, runCompleted: false }
pure val initial: Chat = { key: vacantKey, prompt: idlePrompt }
pure def vacate(k: Reservation): Reservation = { ...vacantKey, generation: k.generation }
pure def canAcquireKey(c: Chat, owner: int, fingerprint: int): bool = c.key.phase == KeyVacant and owner > 0 and fingerprint > 0
pure def acquireKey(c: Chat, owner: int, fingerprint: int): Chat =
  { ...c, key: { phase: KeyActive, owner: owner, fingerprint: fingerprint, generation: c.key.generation + 1, receiptGeneration: 0, waiters: 0, receipt: false, expired: false } }
pure def canJoinKey(c: Chat, fingerprint: int): bool = c.key.phase == KeyActive and c.key.fingerprint == fingerprint
pure def joinKey(c: Chat, fingerprint: int): Chat = { ...c, key: { ...c.key, waiters: c.key.waiters + 1 } }
pure def canCancelWaiter(c: Chat): bool = c.key.waiters > 0
pure def cancelWaiter(c: Chat): Chat = { ...c, key: { ...c.key, waiters: c.key.waiters - 1 } }
pure def canSettleKey(c: Chat, owner: int, generation: int): bool = c.key.phase == KeyActive and c.key.owner == owner and c.key.generation == generation
pure def settleKey(c: Chat, owner: int, generation: int): Chat =
  { ...c, key: { ...c.key, phase: KeySettled, receipt: true, receiptGeneration: generation, waiters: 0 } }
pure val ownerValues = Set(0, 1, 2)
pure val fingerprintValues = Set(0, 1, 2)
pure val generationValues = Set(0, 1, 2, 3)
pure def alwaysReceiptMatchesSettlement(c: Chat): bool =
  c.key.receipt == (c.key.phase == KeySettled) and (c.key.receipt implies c.key.receiptGeneration == c.key.generation) and
  (c.key.phase == KeyVacant implies c.key.owner == 0) and (c.key.phase != KeyActive implies c.key.waiters == 0) and
  c.key.generation >= 0 and c.key.waiters >= 0
pure def sometimesWaitersShareTheReceipt(c: Chat): bool = c.key.phase == KeySettled and c.key.generation > 0
```

### A released reservation cannot settle its successor

The owner may release its reservation without a reply, which frees the key
for a new reservation with a newer generation. A settlement must name the
current owner and generation, so a late settlement of the released
reservation records nothing. A settled receipt is retained until it ages
out; only then can the key be reserved again. Reset vacates the key.

```quint
pure def canReleaseKey(c: Chat, owner: int, generation: int): bool = canSettleKey(c, owner, generation)
pure def releaseKey(c: Chat, owner: int, generation: int): Chat = { ...c, key: vacate(c.key) }
pure def canAgeKey(c: Chat): bool = c.key.phase == KeySettled
pure def ageKey(c: Chat): Chat = { ...c, key: { ...c.key, expired: true } }
pure def canEvictKey(c: Chat): bool = c.key.phase == KeySettled and c.key.expired
pure def evictKey(c: Chat): Chat = { ...c, key: vacate(c.key) }
pure def resetKeys(c: Chat): Chat = { ...c, key: vacate(c.key) }
pure def stepGenerationNeverGoesBack(before: Chat, after: Chat): bool = after.key.generation >= before.key.generation
pure def stepReceiptNamesTheSettledGeneration(before: Chat, via: str, after: Chat): bool =
  (via == "settleKey") implies (before.key.phase == KeyActive and after.key.receiptGeneration == before.key.generation)
pure def sometimesKeyReusedAfterEviction(c: Chat): bool = c.key.phase == KeyActive and c.key.generation > 1
```

## Story: Deliver a prompt to the conversation I chose

> As a user, I can send a prompt to the conversation I selected, and it is
> never delivered to another one when windows switch, the conversation is
> removed, its owner changes or the runtime is replaced.

### A prompt resolves its explicit target or the active window, with no fallback

A prompt names its conversation, or none to mean the active window, and
captures the runtime epoch. Resolution takes the named conversation when
one is named, even if another window became active meanwhile. It is
accepted only if that conversation is still present, still owned by the
caller and the runtime has not been replaced; otherwise the prompt has no
target, and no other conversation is chosen in its place.

```quint
pure def canStartPrompt(c: Chat, requested: int): bool =
  (c.prompt.phase == PromptIdle or c.prompt.phase == PromptFinished) and requested >= 0
pure def startPrompt(c: Chat, requested: int): Chat =
  { ...c, prompt: { ...c.prompt, captured: c.prompt.epoch, requested: requested, phase: PromptResolving, result: 0, verified: false, roomValid: false, persisted: false, verdict: NoOutcome, delivered: false, runCompleted: false } }
pure def canSwitchWindow(c: Chat): bool = c.prompt.phase == PromptResolving
pure def switchWindow(c: Chat): Chat = { ...c, prompt: { ...c.prompt, active: 3 - c.prompt.active } }
pure def canRemoveConversation(c: Chat, conversation: int): bool =
  (c.prompt.phase == PromptResolving or c.prompt.phase == PromptReading) and c.prompt.present.contains(conversation)
pure def removeConversation(c: Chat, conversation: int): Chat = { ...c, prompt: { ...c.prompt, present: c.prompt.present.exclude(Set(conversation)) } }
pure def canChangeOwner(c: Chat, conversation: int): bool = c.prompt.phase == PromptResolving and c.prompt.owned.contains(conversation)
pure def changeOwner(c: Chat, conversation: int): Chat = { ...c, prompt: { ...c.prompt, owned: c.prompt.owned.exclude(Set(conversation)) } }
pure def canReplaceRuntime(c: Chat): bool =
  c.prompt.phase == PromptResolving or c.prompt.phase == PromptReading or c.prompt.phase == PromptPersisting
pure def replaceRuntime(c: Chat): Chat = { ...c, prompt: { ...c.prompt, epoch: c.prompt.epoch + 1 } }
pure def promptTarget(p: Prompt): int = if (p.requested == 0) p.active else p.requested
pure def canResolvePrompt(c: Chat): bool = c.prompt.phase == PromptResolving
pure def resolvePrompt(c: Chat): Chat = {
  val target = promptTarget(c.prompt)
  val accepted = c.prompt.epoch == c.prompt.captured and c.prompt.present.contains(target) and c.prompt.owned.contains(target)
  { ...c, prompt: { ...c.prompt, phase: PromptReading, result: if (accepted) target else -1, verified: accepted } }
}
pure val requestedValues = Set(0, 1, 2)
pure val conversationValues = Set(1, 2)
pure def alwaysResolvedPromptIsVerified(c: Chat): bool =
  c.prompt.result > 0 implies (c.prompt.verified and (c.prompt.requested == 0 or c.prompt.result == c.prompt.requested))
pure def sometimesSelectedConversationSurvivesWindowSwitch(c: Chat): bool =
  c.prompt.persisted and c.prompt.requested > 0 and c.prompt.active != c.prompt.requested
pure def sometimesRemovedConversationHasNoFallback(c: Chat): bool = c.prompt.result == -1 and c.prompt.verdict == NotAdmitted
```

### A prompt is persisted only for a verified, readable conversation under the same runtime

After resolution the host reads the conversation's room and then persists
the prompt. It persists only if resolution was verified, the room read
found the conversation and the runtime is still the one captured at the
start; otherwise the prompt ends not admitted. Until then it is neither
persisted nor given an outcome.

```quint
pure def canReadRoom(c: Chat): bool = c.prompt.phase == PromptReading
pure def readRoom(c: Chat): Chat = { ...c, prompt: { ...c.prompt, phase: PromptPersisting, roomValid: c.prompt.present.contains(c.prompt.result) } }
pure def canPersistPrompt(c: Chat): bool = c.prompt.phase == PromptPersisting
pure def persistPrompt(c: Chat): Chat = {
  val ok = c.prompt.verified and c.prompt.roomValid and c.prompt.epoch == c.prompt.captured
  { ...c, prompt: { ...c.prompt, persisted: ok, phase: if (ok) PromptPersisted else PromptFinished, verdict: if (ok) NoOutcome else NotAdmitted } }
}
pure def alwaysPersistedPromptIsCurrent(c: Chat): bool =
  c.prompt.persisted implies (c.prompt.verified and c.prompt.roomValid and c.prompt.epoch == c.prompt.captured)
pure def alwaysPromptInFlightHoldsNothing(c: Chat): bool =
  (c.prompt.phase == PromptResolving or c.prompt.phase == PromptReading or c.prompt.phase == PromptPersisting) implies (not(c.prompt.persisted) and c.prompt.verdict == NoOutcome)
pure def sometimesRetiredRuntimeRefusesPersistence(c: Chat): bool =
  c.prompt.verdict == NotAdmitted and c.prompt.verified and c.prompt.epoch != c.prompt.captured
```

### A persisted prompt reaches completed, failed, cancelled or denied, independent of reply delivery

A persisted prompt ends with exactly one of completed, failed, cancelled or
denied. A reply may already have been delivered before any of them. The run
status reports success only for completed.

```quint
pure def canFinishPrompt(c: Chat, verdict: PromptOutcome): bool =
  c.prompt.phase == PromptPersisted and c.prompt.persisted and (verdict == Completed or verdict == Failed or verdict == Cancelled or verdict == Denied)
pure def finishPrompt(c: Chat, verdict: PromptOutcome, delivered: bool): Chat =
  { ...c, prompt: { ...c.prompt, phase: PromptFinished, verdict: verdict, delivered: delivered, runCompleted: verdict == Completed } }
pure def alwaysRunStatusFollowsOutcome(c: Chat): bool =
  c.prompt.runCompleted == (c.prompt.verdict == Completed) and
  ((c.prompt.phase == PromptFinished and c.prompt.persisted) implies (c.prompt.verdict == Completed or c.prompt.verdict == Failed or c.prompt.verdict == Cancelled or c.prompt.verdict == Denied))
pure def sometimesFailedAfterDelivery(c: Chat): bool = c.prompt.delivered and c.prompt.verdict == Failed
pure def sometimesCompletedWithoutReply(c: Chat): bool = not(c.prompt.delivered) and c.prompt.runCompleted
```
