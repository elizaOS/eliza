# Grace website and extraction inference admission

Grace `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` builds its generic website guide, bill readers and mail-model port through `apps/app/host/local-agent-gateway.ts`, `website-guide-planner.ts`, `website-planner.ts` and `shared/redact-request.ts`. Eliza `7743504b7c936a764b3938a44cad918808b621df` supplies native Cloud credential and runtime gateways. [Resident Cloud](../residentCloud.md) owns resident chat inference admission. [Host refusals](hostRefusals.md) owns the inbound sensitive text gate. [Observed results](websiteObservedResult.md) and [bill evidence](billEmailEvidence.md) own how replies support later claims. This specification covers the actual planner and extraction requests sent by Grace.

## Story: Send each model call through the current account's route with private text removed

### Route selection binds one endpoint and credential before a call sends anything

Native release sends website inference to the configured Cloud chat-completions endpoint with the signed-in account credential read for that call. The controlled native build can use a nonempty key from its private development file and send that call to Cerebras. A missing or blank development key falls through to Cloud. An unexpected file error propagates. Desktop development uses Cerebras with the environment key first, then the optional private runtime environment file. The native model name is `qwen-3.8-27b`; off-device a configured development model name can override that default. The endpoint and key are obtained as a pair. Neither website data nor a retry changes the pair. The file read is a development path, while native release lacks the enabling build flag.

Each logical inference invocation checks its abort signal before reading the route. It counts one call before route selection, and no additional logical call for transport retries. A missing or falsey key returns 503. For a key that is present, the host checks cancellation again before preparing the body. Extract requires a nonempty messages array and a JSON-schema response format. TypeScript callers provide the actual message and schema shapes. The model keeps only symbolic route and request identities, with no credential values.

```quint
type RouteFacts = { native: bool, debugSwitch: bool, debugReadFailed: bool, debugKey: bool, envKey: bool, envFileKey: bool, cloudKey: bool }
pure def routeSource(routeFacts: RouteFacts): str =
  if (not(routeFacts.native)) (if (routeFacts.envKey) "host-env" else if (routeFacts.envFileKey) "host-private-file" else "no-key")
  else if (routeFacts.debugSwitch and routeFacts.debugReadFailed) "route-error"
  else if (routeFacts.debugSwitch and routeFacts.debugKey) "debug-file"
  else if (routeFacts.cloudKey) "cloud-account" else "no-key"
pure def extractInput(messagesArray: bool, messagesTotal: int, jsonSchema: bool): bool =
  messagesArray and messagesTotal > 0 and jsonSchema
pure def beforeInference(abortedBefore: bool, routeReady: bool, keyPresent: bool, abortedAfterRoute: bool): str =
  if (abortedBefore) "abort"
  else if (not(routeReady)) "route-error"
  else if (not(keyPresent)) "missing-key-503"
  else if (abortedAfterRoute) "abort"
  else "redact"
pure def lawNativeReleaseHasNoDeveloperRoute(routeFacts: RouteFacts): bool =
  routeFacts.native and not(routeFacts.debugSwitch) implies routeSource(routeFacts) == (if (routeFacts.cloudKey) "cloud-account" else "no-key")
pure def lawNoKeyCannotPrepareBody(abortedBefore: bool, routeReady: bool, keyPresent: bool, abortedAfterRoute: bool): bool =
  beforeInference(abortedBefore, routeReady, keyPresent, abortedAfterRoute) == "redact" implies keyPresent and routeReady and not(abortedBefore or abortedAfterRoute)
pure val releaseRoute: RouteFacts = { native: true, debugSwitch: false, debugReadFailed: false, debugKey: false, envKey: false, envFileKey: false, cloudKey: true }
pure val routeFactsValues = Set(releaseRoute, { ...releaseRoute, cloudKey: false }, { ...releaseRoute, debugKey: true }, { ...releaseRoute, debugSwitch: true, debugKey: true }, { ...releaseRoute, debugSwitch: true, debugReadFailed: true }, { ...releaseRoute, native: false, envKey: true }, { ...releaseRoute, native: false, envFileKey: true })
```

### Non-system content is checked anew against the session redactor before serialization

The planner preserves trusted system instructions. Every other string content is parsed as JSON when possible. An object or array is copied with the same keys and recursively redacted string values. Parse failure and primitive JSON content use the page-text redactor on the original string. Non-string content is passed through by this boundary. The response schema is carried intact. System content, schema, object keys and non-string content are trusted caller surfaces, outside this string redaction policy. A shell using this contract must keep untrusted values in covered positions. The request is assembled once with the selected model, messages, response format, 4096 completion tokens, low reasoning effort and zero temperature.

The structured redactor checks plain or null-prototype objects and arrays. It rejects an object or array beyond depth 20 and an unsupported object prototype with 400 `INVALID_TEXT_STRUCTURE`. The primitive check comes before the depth check. A string at depth 21 directly below an allowed object is still redacted. Any thrown preparation error leaves the request unsent. Page redaction replaces remembered text line by line, then recognized secret and code values, then remembered exact text again. Password guidance can remain readable. This is classification by the pinned recognizers and remembered fingerprints, with no claim that unknown secrets are identified. A quoting caller can first redact its own source with the same page policy so its checks use the words the model saw.

The exact phrase memory uses keyed fingerprints and remembers one through twelve normalized words, with four characters required for a single word. The input must be a nonblank string of at most 200 units after preparation. A numeric value of four through ten digits after removing whitespace and hyphens goes to the shared scrubber instead. Other eligible inputs also go through the scrubber's per-word classifier. A new exact fingerprint at the limit of 128 clears that exact memory and then stores the new one. A repeated fingerprint preserves the current memory. Session clear forgets both. The model takes recognizer and fingerprint equality facts and holds no raw value.

```quint
type ContentFacts = { system: bool, stringContent: bool, parsedContainer: bool, structureValid: bool }
pure def redactContent(contentFacts: ContentFacts): str =
  if (contentFacts.system or not(contentFacts.stringContent)) "preserve"
  else if (not(contentFacts.parsedContainer)) "page-text"
  else if (contentFacts.structureValid) "page-values"
  else "invalid-text-structure"
type RedactorNode = { objectOrArray: bool, depth: int, arrayNode: bool, plainObject: bool }
pure def redactorNodeValid(node: RedactorNode): bool =
  not(node.objectOrArray) or (node.depth <= 20 and (node.arrayNode or node.plainObject))
type RememberFacts = { textInput: bool, trimmedUnits: int, alreadyRemoved: bool, numericForm: bool, words: int, singleWordUnits: int, repeatedFingerprint: bool, exactTotal: int }
pure def rememberPath(remember: RememberFacts): str =
  if (not(remember.textInput) or remember.trimmedUnits < 1 or remember.trimmedUnits > 200 or remember.alreadyRemoved) "ignore"
  else if (remember.numericForm) "numeric-scrubber"
  else if (remember.words < 1 or remember.words > 12 or (remember.words == 1 and remember.singleWordUnits < 4)) "word-scrubber"
  else if (not(remember.repeatedFingerprint) and remember.exactTotal >= 128) "replace-exact-memory"
  else "retain-exact-memory"
pure def lawInvalidContainerCannotProceed(contentFacts: ContentFacts): bool =
  not(contentFacts.system) and contentFacts.stringContent and contentFacts.parsedContainer and not(contentFacts.structureValid) implies redactContent(contentFacts) == "invalid-text-structure"
pure def lawClearAtCapacityNeedsNewFingerprint(remember: RememberFacts): bool =
  rememberPath(remember) == "replace-exact-memory" implies not(remember.repeatedFingerprint) and remember.exactTotal >= 128
pure val structured: ContentFacts = { system: false, stringContent: true, parsedContainer: true, structureValid: true }
pure val contentFactsValues = Set(structured, { ...structured, system: true }, { ...structured, stringContent: false }, { ...structured, parsedContainer: false }, { ...structured, structureValid: false })
pure val regularNode: RedactorNode = { objectOrArray: true, depth: 20, arrayNode: false, plainObject: true }
pure val nodeValues = Set(regularNode, { ...regularNode, depth: 21 }, { ...regularNode, objectOrArray: false, depth: 21 }, { ...regularNode, plainObject: false }, { ...regularNode, plainObject: false, arrayNode: true })
pure val freshPhrase: RememberFacts = { textInput: true, trimmedUnits: 20, alreadyRemoved: false, numericForm: false, words: 3, singleWordUnits: 0, repeatedFingerprint: false, exactTotal: 4 }
pure val rememberValues = Set(freshPhrase, { ...freshPhrase, numericForm: true }, { ...freshPhrase, alreadyRemoved: true }, { ...freshPhrase, trimmedUnits: 201 }, { ...freshPhrase, words: 13 }, { ...freshPhrase, words: 1, singleWordUnits: 3 }, { ...freshPhrase, exactTotal: 128 }, { ...freshPhrase, exactTotal: 128, repeatedFingerprint: true })
```

## Story: Retry inference within its budget and discard stale model results

### Only the quota response can schedule a bounded retry of the same prepared request

The request uses JSON POST with the captured bearer credential. Each of at most three attempts receives a 20-second timeout combined with the caller's signal. The host checks that signal before every attempt. A 429 on the first or second attempt can retry. Without a header, the candidate delay is 10 seconds after the first attempt and 20 after the second. A plain unsigned decimal header is seconds. Other present values go through the date parser and use the date minus the current clock. The retry requires a finite delay between zero and 30 seconds inclusive, and waits at least one second. The model takes the parsed numeric or date delay in milliseconds. The fixture comparisons use integer milliseconds. The source can pass a fractional millisecond to the sleep port.

The host cancels the discarded response body when present and waits before repeating. Cancellation or a body-cancel or wait failure propagates. The same serialized bytes, endpoint and authorization return for every allowed retry. No network error or other HTTP status triggers this loop and it never invokes a browser action. A final 429 produces the rate-limit 503. A different non-success response produces provider-unavailable 502.

```quint
type QuotaReply = { status: int, attemptNumber: int, headerPresent: bool, delayFinite: bool, delayMs: int }
type QuotaDecision = { retry: bool, delayMs: int }
pure val noRetry: QuotaDecision = { retry: false, delayMs: 0 }
pure def quotaDelay(quotaReply: QuotaReply): QuotaDecision = {
  val duration = if (quotaReply.headerPresent) quotaReply.delayMs else quotaReply.attemptNumber * 10000
  if (quotaReply.status == 429 and quotaReply.attemptNumber >= 1 and quotaReply.attemptNumber < 3 and (not(quotaReply.headerPresent) or quotaReply.delayFinite) and duration >= 0 and duration <= 30000)
    { retry: true, delayMs: if (duration < 1000) 1000 else duration }
  else noRetry
}
pure def lawOnlyEarlyBoundedQuotaCanRetry(quotaReply: QuotaReply): bool =
  quotaDelay(quotaReply).retry implies quotaReply.status == 429 and quotaReply.attemptNumber >= 1 and quotaReply.attemptNumber < 3 and quotaDelay(quotaReply).delayMs >= 1000 and quotaDelay(quotaReply).delayMs <= 30000
pure def lawPastOrLongQuotaHasNoRetry(quotaReply: QuotaReply): bool =
  quotaReply.headerPresent and (not(quotaReply.delayFinite) or quotaReply.delayMs < 0 or quotaReply.delayMs > 30000) implies not(quotaDelay(quotaReply).retry)
pure val firstQuota: QuotaReply = { status: 429, attemptNumber: 1, headerPresent: false, delayFinite: true, delayMs: 0 }
pure val quotaReplyValues = Set(firstQuota, { ...firstQuota, attemptNumber: 2 }, { ...firstQuota, attemptNumber: 3 }, { ...firstQuota, status: 500 }, { ...firstQuota, headerPresent: true, delayFinite: false }, { ...firstQuota, headerPresent: true, delayMs: -1 }, { ...firstQuota, headerPresent: true, delayMs: 0 }, { ...firstQuota, headerPresent: true, delayMs: 999 }, { ...firstQuota, headerPresent: true, delayMs: 30000 }, { ...firstQuota, headerPresent: true, delayMs: 30001 })
```

### The decoded payload remains advisory and must belong to the current look

An accepted HTTP response must have a parseable envelope; failure of the outer JSON parse propagates unchanged here. After reading the envelope the host rechecks cancellation. Only choice zero is examined. Its finish reason length gives incomplete 502 even if its content could parse. Other finish reasons fall through to content parsing. A missing, invalid, null, primitive or array message produces invalid-step 502. A JSON object may proceed to the consumer decoder. The step planner further admits only the statuses act, wait, done, blocked and needs-help. Goal and evidence review validation own their separate semantic correction calls. A null outer JSON value raises a native access error when the handler reads its choices. A decoded object gives no authority to perform a website effect.

A native guide look shares one 25-second deadline across interpretation and planning. The calculation uses a combined signal where a caller signal exists. When a model path throws after only the deadline expired, the helper projects a blocked slow-site result and records late timing without a fabricated call count. A caller abort continues as an error even when the deadline also expired. After interpretation the helper rechecks owner and captured task conditions before retaining the interpretation. After planning it rechecks helper lifetime, signal, active task epoch and exact captured goal and revision. This is custody of the result in the same request, with downstream action checks still required.

```quint
type ReplyFacts = { status: int, httpOkay: bool, outerJson: bool, envelopeNull: bool, abortedAfterRead: bool, reasonLength: bool, contentObject: bool }
pure def inferenceResult(resultFacts: ReplyFacts): str =
  if (resultFacts.status == 429) "rate-limit-503"
  else if (not(resultFacts.httpOkay)) "provider-502"
  else if (not(resultFacts.outerJson)) "outer-parse-error"
  else if (resultFacts.abortedAfterRead) "abort"
  else if (resultFacts.envelopeNull) "outer-access-error"
  else if (resultFacts.reasonLength) "incomplete-502"
  else if (not(resultFacts.contentObject)) "invalid-step-502"
  else "provider-object"
pure def acceptedPlanStatus(planStatus: str): bool = Set("act", "wait", "done", "blocked", "needs-help").contains(planStatus)
type LookFacts = { deadlineAborted: bool, callerAborted: bool, helperOpen: bool, taskActive: bool, epochMatches: bool, goalMatches: bool, goalRevisionMatches: bool }
pure def thrownLookResult(look: LookFacts): str =
  if (look.deadlineAborted and not(look.callerAborted)) "blocked-slow" else "propagate"
pure def currentLookMatches(look: LookFacts): bool =
  look.helperOpen and not(look.callerAborted) and look.taskActive and look.epochMatches and look.goalMatches and look.goalRevisionMatches
pure def lawPartialReplyCannotSucceed(resultFacts: ReplyFacts): bool =
  inferenceResult(resultFacts) == "provider-object" implies resultFacts.httpOkay and resultFacts.outerJson and resultFacts.contentObject and not(resultFacts.envelopeNull or resultFacts.reasonLength or resultFacts.abortedAfterRead)
pure def lawCallerAbortNeverBecomesSlowLook(look: LookFacts): bool =
  look.callerAborted implies thrownLookResult(look) == "propagate" and not(currentLookMatches(look))
pure val okayReply: ReplyFacts = { status: 200, httpOkay: true, outerJson: true, envelopeNull: false, abortedAfterRead: false, reasonLength: false, contentObject: true }
pure val resultFactsValues = Set(okayReply, { ...okayReply, status: 429, httpOkay: false }, { ...okayReply, status: 500, httpOkay: false }, { ...okayReply, outerJson: false }, { ...okayReply, envelopeNull: true }, { ...okayReply, reasonLength: true }, { ...okayReply, abortedAfterRead: true }, { ...okayReply, contentObject: false })
pure val freshLook: LookFacts = { deadlineAborted: false, callerAborted: false, helperOpen: true, taskActive: true, epochMatches: true, goalMatches: true, goalRevisionMatches: true }
pure val lookValues = Set(freshLook, { ...freshLook, deadlineAborted: true }, { ...freshLook, callerAborted: true }, { ...freshLook, callerAborted: true, deadlineAborted: true }, { ...freshLook, taskActive: false }, { ...freshLook, epochMatches: false }, { ...freshLook, goalRevisionMatches: false }, { ...freshLook, helperOpen: false })
```

### A queued quota retry preserves the prepared request until dispatch or cancellation

This machine isolates one successfully prepared logical call. It records symbolic route and body identities. Each launch consumes one transport attempt. The reply may settle the call or leave it waiting for quota, and a wait only reopens the send path once. Cancellation closes the call and prevents another attempt. In-flight HTTP cancellation and response parsing are boundary facts. Application-specific correction calls are new logical calls. Discovered by the proof: an unprepared call has no recorded route or body, and ready, sent and quota-wait phases each retain both identities.

```quint
type Inference = { phase: str, requestId: int, routeId: int, attempts: int, delayMs: int, finalStatus: str }
pure val initial: Inference = { phase: "unprepared", requestId: 0, routeId: 0, attempts: 0, delayMs: 0, finalStatus: "" }
pure def canPrepareInference(inference: Inference, bodyId: int, endpointId: int, redactionOkay: bool): bool =
  inference.phase == "unprepared" and bodyId > 0 and endpointId > 0 and redactionOkay
pure def prepareInference(inference: Inference, bodyId: int, endpointId: int, redactionOkay: bool): Inference =
  { ...inference, phase: "ready", requestId: bodyId, routeId: endpointId }
pure def canSendInference(inference: Inference): bool =
  inference.phase == "ready" and inference.attempts < 3
pure def sendInference(inference: Inference): Inference =
  { ...inference, phase: "sent", attempts: inference.attempts + 1 }
pure def canReportInference(inference: Inference): bool = inference.phase == "sent"
pure def reportInference(inference: Inference, quotaReply: QuotaReply, resultFacts: ReplyFacts): Inference = {
  val quota = quotaDelay({ ...quotaReply, status: resultFacts.status, attemptNumber: inference.attempts })
  if (quota.retry) { ...inference, phase: "waiting", delayMs: quota.delayMs }
  else { ...inference, phase: "settled", delayMs: 0, finalStatus: inferenceResult(resultFacts) }
}
pure def canFinishQuotaWait(inference: Inference, waited: bool): bool =
  inference.phase == "waiting" and waited
pure def finishQuotaWait(inference: Inference, waited: bool): Inference =
  { ...inference, phase: "ready", delayMs: 0 }
pure def canStopInference(inference: Inference): bool =
  inference.phase != "settled" and inference.phase != "stopped"
pure def stopInference(inference: Inference): Inference =
  { ...inference, phase: "stopped", delayMs: 0, finalStatus: "abort" }
pure def alwaysAttemptsBounded(inference: Inference): bool =
  inference.attempts >= 0 and inference.attempts <= 3
pure def alwaysWaitingHasQuotaBudget(inference: Inference): bool =
  inference.phase == "waiting" implies inference.attempts >= 1 and inference.attempts < 3 and inference.delayMs >= 1000 and inference.delayMs <= 30000
pure def alwaysSentHasAttempt(inference: Inference): bool =
  inference.phase == "sent" implies inference.attempts >= 1
pure def alwaysUnpreparedHasNoRequest(inference: Inference): bool =
  inference.phase == "unprepared" implies inference.requestId == 0 and inference.routeId == 0 and inference.attempts == 0
pure def alwaysSendUsesPreparedRequest(inference: Inference): bool =
  Set("ready", "sent", "waiting").contains(inference.phase) implies inference.requestId > 0 and inference.routeId > 0
pure def stepRetryRetainsExactRequest(before: Inference, after: Inference): bool =
  before.requestId > 0 implies after.requestId == before.requestId and after.routeId == before.routeId
pure def stepStopRemainsTerminal(before: Inference, after: Inference): bool =
  before.phase == "stopped" implies after.phase == before.phase and after.requestId == before.requestId and after.routeId == before.routeId and after.attempts == before.attempts and after.delayMs == before.delayMs and after.finalStatus == before.finalStatus
pure def sometimesRetryWaits(inference: Inference): bool = inference.phase == "waiting"
pure def sometimesThirdAttemptSent(inference: Inference): bool = inference.phase == "sent" and inference.attempts == 3
pure def sometimesResultReceived(inference: Inference): bool = inference.phase == "settled" and inference.finalStatus == "provider-object"
pure def sometimesStoppedAfterSend(inference: Inference): bool = inference.phase == "stopped" and inference.attempts > 0
pure val bodyIdValues = Set(0, 1, 2)
pure val endpointIdValues = Set(0, 1, 2)
pure val weight_prepareInference = 8
pure val weight_sendInference = 16
pure val weight_reportInference = 16
pure val weight_finishQuotaWait = 12
pure val weight_stopInference = 3
```

The formal model checks exact prepared request custody, retry boundaries and reply admission from decoder facts. Pinned fixtures exercise actual serialization, redaction and I/O behavior with controlled ports. Live credentials, provider quota and semantic correctness remain external evidence.
