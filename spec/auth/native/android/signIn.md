# Android sign-in

Sign-in on the device runs on native Android screens with an email or SMS
code, Google, or a second factor. This spec is the Android sign-in
plugin's single worker, which verifies codes up to the mobile grant. The
renderer's request broker is [sign-in requests](./signInRequests.md), and
its controller, which cancels exactly the request it dispatched, is
[sign-in cancel](./signInCancel.md), also after a code
[resend](./signInResend.md). Codes, verifiers,
keys and sessions stay native; the renderer sees only request, attempt and
credential ids, admitted by [sign-in receipts](../receipt.md).

## Story: Verify a sign-in code on the device

> As a person signing in with a code, I want each try answered once, a
> retry after a wrong code or a dropped request to work, and a cancelled
> attempt never to answer for a newer one.

### A retry reply after a wrong code or no answer belongs to the worker that detached the waiter

Starting a code attempt advances its generation. A verification is taken
only for the current attempt, its channel and step, while no other
verification waits. The single worker checks it. A wrong code, or a
request that got no answer, detaches the bridge waiter so the person can
retry at once, and the worker still owes that call its reply; the reply,
when it is delivered, never touches the new waiter or attempt. Every call
gets exactly one reply.

```quint
type Channel = NoChannel | EmailChannel | PhoneChannel
type Factor = NoFactor | TotpFactor | SmsFactor
type VerifyTarget = VerifyEmail | VerifyPhone | VerifyFactor
type WorkStage = WorkIdle | Checking | InvalidReply | Granting
type Work = { owner: int, rpc: int, stage: WorkStage }
type SignIn = { generation: int, channel: Channel, factor: Factor, sending: bool, expired: bool, failed: int,
  issued: int, waiter: int, work: Work, replied: List[int] }
pure val noWork: Work = { owner: 0, rpc: 0, stage: WorkIdle }
pure val initial: SignIn = { generation: 0, channel: NoChannel, factor: NoFactor, sending: false, expired: false, failed: 0, issued: 0, waiter: 0, work: noWork, replied: List() }
pure def withReply(rpc: int, c: SignIn): SignIn = { ...c, replied: c.replied.append(rpc) }
pure def retiring(reply: int, c: SignIn): SignIn =
  { ...c, replied: if (reply == 0) c.replied else c.replied.append(reply), channel: NoChannel, factor: NoFactor, sending: false, expired: false, failed: 0, waiter: 0 }
pure def ownsWork(c: SignIn): bool = c.work.rpc != 0 and c.work.rpc == c.waiter and c.work.owner == c.generation
pure def canStartCode(c: SignIn, channel: Channel): bool = c.waiter == 0 and not(c.sending) and channel != NoChannel
pure def startCode(c: SignIn, channel: Channel): SignIn = { ...c, generation: c.generation + 1, channel: channel, factor: NoFactor, sending: true, expired: false, failed: 0 }
pure def canCodeSent(c: SignIn): bool = c.sending and c.work == noWork
pure def codeSent(c: SignIn): SignIn = { ...c, sending: false }
pure def canExpireCode(c: SignIn): bool = c.channel != NoChannel and not(c.sending) and not(c.expired)
pure def expireCode(c: SignIn): SignIn = { ...c, expired: true }
pure def verify(c: SignIn, attempt: int, target: VerifyTarget): SignIn = {
  val ownsAttempt = c.channel != NoChannel and attempt == c.generation and c.waiter == 0 and not(c.sending)
  val rightChannel = target == VerifyFactor or (target == VerifyEmail and c.channel == EmailChannel) or (target == VerifyPhone and c.channel == PhoneChannel)
  val rightStep = if (target == VerifyFactor) c.factor == TotpFactor or c.factor == SmsFactor else c.factor == NoFactor
  if (not(ownsAttempt and rightChannel)) c
  else if (c.expired) retiring(0, c)
  else if (rightStep) { ...c, issued: c.issued + 1, waiter: c.issued + 1 }
  else c
}
pure def cancelAttempt(c: SignIn, attempt: int): SignIn =
  if (c.channel == NoChannel or (attempt != 0 and attempt != c.generation)) c else retiring(c.waiter, c)
pure def canStartWork(c: SignIn): bool = c.work == noWork and c.waiter != 0
pure def startWork(c: SignIn): SignIn = { ...c, work: { owner: c.generation, rpc: c.waiter, stage: Checking } }
pure def canWrongCode(c: SignIn): bool = c.work.stage == Checking and ownsWork(c)
pure def wrongCode(c: SignIn): SignIn =
  if (c.failed == 4) retiring(c.waiter, { ...c, work: noWork })
  else { ...c, failed: c.failed + 1, waiter: 0, work: { ...c.work, stage: InvalidReply } }
pure def canNoAnswer(c: SignIn): bool = c.work.stage == Checking and ownsWork(c)
pure def noAnswer(c: SignIn): SignIn = { ...c, waiter: 0, work: { ...c.work, stage: InvalidReply } }
pure def canDeliverRetryReply(c: SignIn): bool = c.work.stage == InvalidReply
pure def deliverRetryReply(c: SignIn): SignIn = withReply(c.work.rpc, { ...c, work: noWork })
pure def canFinishTerminal(c: SignIn): bool = c.work.stage == Checking or c.work.stage == Granting
pure def finishTerminal(c: SignIn): SignIn = if (ownsWork(c)) retiring(c.waiter, { ...c, work: noWork }) else { ...c, work: noWork }
pure val attemptValues = Set(0, 1, 2)
pure def repliesTo(c: SignIn, rpc: int): int = c.replied.select(r => r == rpc).length()
pure def detachedRpc(c: SignIn): int = if (c.work.stage == InvalidReply) c.work.rpc else 0
pure def alwaysAtMostOneReply(c: SignIn): bool = c.replied.every(r => r >= 1 and r <= c.issued and repliesTo(c, r) == 1)
pure def alwaysPendingHasOneOwner(c: SignIn): bool = {
  val owners = (if (c.waiter != 0) 1 else 0) + (if (detachedRpc(c) != 0) 1 else 0)
  c.issued - c.replied.length() == owners and (c.waiter == 0 or (c.waiter != detachedRpc(c) and c.waiter <= c.issued and repliesTo(c, c.waiter) == 0)) and
    (detachedRpc(c) == 0 or (detachedRpc(c) <= c.issued and repliesTo(c, detachedRpc(c)) == 0))
}
pure def alwaysWaiterHasReadyAttempt(c: SignIn): bool = c.waiter != 0 implies (c.channel != NoChannel and not(c.sending))
pure def alwaysWorkOwnsItsCall(c: SignIn): bool =
  (c.work.stage == WorkIdle) == (c.work == noWork) and (c.work.stage == Checking or c.work.stage == Granting implies c.work.rpc != 0)
pure def sometimesRetryWhileReplyDetached(c: SignIn): bool = c.waiter != 0 and detachedRpc(c) != 0
```

### Wrong codes are bounded per step, and an unanswered request keeps the step

Each code or factor step allows five invalid codes; the fifth retires the
attempt. A request that got no answer may still have carried the right
code, so it does not use the budget. A required second factor starts a
fresh budget. Only a current,
unexpired attempt hands its grant to the native consent gate, and an
expired code retires the attempt instead of reaching the worker.

```quint
pure def canRequireFactor(c: SignIn, factor: Factor): bool = c.work.stage == Checking and ownsWork(c) and c.factor == NoFactor and factor != NoFactor
pure def requireFactor(c: SignIn, factor: Factor): SignIn = withReply(c.waiter, { ...c, work: noWork, factor: factor, failed: 0, waiter: 0 })
pure def canHandoffGrant(c: SignIn): bool = c.work.stage == Checking and ownsWork(c) and not(c.expired)
pure def handoffGrant(c: SignIn): SignIn = { ...c, work: { ...c.work, stage: Granting } }
pure def alwaysAttemptBudget(c: SignIn): bool = c.failed >= 0 and c.failed <= 4
pure def alwaysGrantOnlyForCurrentAttempt(c: SignIn): bool = c.work.stage == Granting implies c.work.owner >= 1
pure def sometimesFactorAfterCode(c: SignIn): bool = c.factor != NoFactor and c.channel != NoChannel
pure def sometimesGrantHandedOff(c: SignIn): bool = c.work.stage == Granting and ownsWork(c)
pure def sometimesWrongCodesCounted(c: SignIn): bool = c.failed >= 2
```
