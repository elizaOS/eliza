# Website and extraction inference

A host that guides the person through a website sends planner and
extraction requests to a model. [Resident binding](../agent/resident/cloudAdmission.md)
owns resident chat inference admission, [host refusals](../agent/nativeHost/refusals.md)
own the inbound sensitive text gate, and [website goals](./websiteGoal.md)
own how replies support later claims. This spec covers the planner and
extraction calls the host sends.

## Story: Send each model call through my account's route with private text removed, and drop stale results

> As the person, I want each model call the guide makes to use my current
> account's route with my private text removed, to be retried only when
> the provider asks me to wait, and a result that arrives too late to be
> ignored, so that nothing private leaks and nothing stale acts for me.

### Each call binds one route and credential from the current account, and redacts non-system text, before sending

Before a call is prepared, the host checks for cancellation and reads the
endpoint and credential of the current account as one pair; neither
website data nor a retry changes it, and a call without a credential is
never prepared. Trusted system instructions are kept
as they are. Every other text is redacted before serialization: structured
JSON text has each string value redacted, other text goes through the
page-text redactor, and a structure the redactor cannot walk refuses the
call, which is then never sent. Redaction removes remembered page text and
recognized secrets; it does not claim to find unknown secrets.

```quint
type ContentKind = SystemText | PlainText | StructuredText | UnwalkableStructure | NonText
type Redaction = Preserved | PageRedacted | ValuesRedacted | StructureRefused
pure def redactContent(content: ContentKind): Redaction =
  match content {
    | SystemText => Preserved
    | NonText => Preserved
    | PlainText => PageRedacted
    | StructuredText => ValuesRedacted
    | UnwalkableStructure => StructureRefused
  }
type InferencePhase = Unprepared | Ready | Sent | WaitingQuota | Settled | Stopped
type InferenceResult = NoResult | AcceptedObject | ProviderUnavailable | IncompleteReply | InvalidReply | Aborted | DiscardedStale
type Inference = { phase: InferencePhase, requestId: int, routeId: int, attempts: int, result: InferenceResult }
pure val initial: Inference = { phase: Unprepared, requestId: 0, routeId: 0, attempts: 0, result: NoResult }
pure def canPrepareInference(inference: Inference, bodyId: int, accountRoute: int, content: ContentKind): bool =
  inference.phase == Unprepared and bodyId > 0 and accountRoute > 0 and redactContent(content) != StructureRefused
pure def prepareInference(inference: Inference, bodyId: int, accountRoute: int, content: ContentKind): Inference =
  { ...inference, phase: Ready, requestId: bodyId, routeId: accountRoute }
pure val bodyIdValues = Set(0, 1, 2)
pure val accountRouteValues = Set(0, 1, 2)
pure def lawNonSystemTextIsRedacted(content: ContentKind): bool =
  (content == PlainText or content == StructuredText) implies redactContent(content) != Preserved
pure def lawNoCredentialIsNeverPrepared(bodyId: int, content: ContentKind): bool =
  not(canPrepareInference(initial, bodyId, 0, content))
pure def lawUnwalkableStructureIsNeverPrepared(bodyId: int, accountRoute: int): bool =
  not(canPrepareInference(initial, bodyId, accountRoute, UnwalkableStructure))
pure def alwaysUnpreparedHasNoRequest(inference: Inference): bool =
  inference.phase == Unprepared implies inference.requestId == 0 and inference.routeId == 0 and inference.attempts == 0
pure def alwaysSendUsesPreparedRequest(inference: Inference): bool =
  (inference.phase == Ready or inference.phase == Sent or inference.phase == WaitingQuota) implies inference.requestId > 0 and inference.routeId > 0
```

### Only a quota refusal retries, at most twice, with the same prepared request

A call makes at most three attempts. Only a quota refusal on the first or
second attempt, for a look that is still current and whose requested wait
is within the retry bound, waits and
sends the same prepared bytes to the same route with the same credential
again. Any other refusal, a network error or a final quota refusal settles
the call as provider unavailable. Cancellation stops the call and no
further attempt is made.

```quint
type ReplyKind = ReplyObject | ReplyQuota | ReplyRefused | ReplyIncomplete | ReplyInvalid
pure val maxAttempts: int = 3
pure def retriesQuota(reply: ReplyKind, attempts: int, waitAcceptable: bool): bool =
  reply == ReplyQuota and attempts >= 1 and attempts < maxAttempts and waitAcceptable
pure def canSendInference(inference: Inference): bool = inference.phase == Ready and inference.attempts < maxAttempts
pure def sendInference(inference: Inference): Inference = { ...inference, phase: Sent, attempts: inference.attempts + 1 }
pure def canFinishQuotaWait(inference: Inference): bool = inference.phase == WaitingQuota
pure def finishQuotaWait(inference: Inference): Inference = { ...inference, phase: Ready }
pure def canStopInference(inference: Inference): bool = inference.phase != Settled and inference.phase != Stopped
pure def stopInference(inference: Inference): Inference = { ...inference, phase: Stopped, result: Aborted }
pure def alwaysAttemptsBounded(inference: Inference): bool = inference.attempts >= 0 and inference.attempts <= maxAttempts
pure def alwaysWaitingHasRetryBudget(inference: Inference): bool =
  inference.phase == WaitingQuota implies inference.attempts >= 1 and inference.attempts < maxAttempts
pure def alwaysSentHasAttempt(inference: Inference): bool = inference.phase == Sent implies inference.attempts >= 1
pure def stepRetryRetainsExactRequest(before: Inference, after: Inference): bool =
  before.requestId > 0 implies after.requestId == before.requestId and after.routeId == before.routeId
pure def stepStopRemainsTerminal(before: Inference, after: Inference): bool = before.phase == Stopped implies after == before
pure def sometimesRetryWaits(inference: Inference): bool = inference.phase == WaitingQuota
pure def sometimesThirdAttemptSent(inference: Inference): bool = inference.phase == Sent and inference.attempts == maxAttempts
pure def sometimesStoppedAfterSend(inference: Inference): bool = inference.phase == Stopped and inference.attempts > 0
```

### A result outside the current look is discarded, and an accepted one is only advice

A complete reply whose message is a JSON object is handed to the
consumer's decoder; an incomplete reply or a missing or non-object message
is refused, so only a complete object is ever accepted. A reply that
arrives after the look it was made for ended, after its task, goal or
revision changed, or after cancellation is discarded, a quota refusal
included: it is never retried. An accepted object never authorizes a website effect by
itself; the action checks downstream still apply.

```quint
pure def replyResult(reply: ReplyKind): InferenceResult =
  match reply {
    | ReplyObject => AcceptedObject
    | ReplyIncomplete => IncompleteReply
    | ReplyInvalid => InvalidReply
    | ReplyQuota => ProviderUnavailable
    | ReplyRefused => ProviderUnavailable
  }
pure def canReportInference(inference: Inference): bool = inference.phase == Sent
pure def reportInference(inference: Inference, reply: ReplyKind, waitAcceptable: bool, lookCurrent: bool): Inference =
  if (lookCurrent and retriesQuota(reply, inference.attempts, waitAcceptable)) { ...inference, phase: WaitingQuota }
  else { ...inference, phase: Settled, result: if (lookCurrent) replyResult(reply) else DiscardedStale }
pure def lawStaleReplyIsDiscarded(reply: ReplyKind, waitAcceptable: bool, attempts: int): bool = {
  val after = reportInference({ ...initial, phase: Sent, requestId: 1, routeId: 1, attempts: attempts }, reply, waitAcceptable, false)
  after.phase == Settled and after.result == DiscardedStale
}
pure def lawOnlyACompleteObjectIsAccepted(reply: ReplyKind): bool = replyResult(reply) == AcceptedObject implies reply == ReplyObject
pure def sometimesResultReceived(inference: Inference): bool = inference.phase == Settled and inference.result == AcceptedObject
pure def sometimesStaleResultDiscarded(inference: Inference): bool = inference.phase == Settled and inference.result == DiscardedStale
pure val weight_prepareInference = 8
pure val weight_sendInference = 16
pure val weight_reportInference = 16
pure val weight_finishQuotaWait = 12
pure val weight_stopInference = 3
```
