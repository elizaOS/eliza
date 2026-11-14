# Grace conversation reply streaming

Grace `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` uses the pinned Eliza `7743504b7c936a764b3938a44cad918808b621df` gateway's `/conversations/{uuid}/messages/stream/{start,pull,cancel}` endpoints through `apps/app/src/runtime-client.ts`. The renderer can speak a preview while the agent is composing. The final displayed reply comes from the complete terminal message. The conversation owner contract supplies account and reset evidence. The client turn controller owns Stop, and the speech owner determines what is actually heard.

## Story: Open a reply stream only once per admitted turn

### Stream admission and buffered fallback have different authority

Grace attempts a stream only when there is a preview callback, there is no task context, and the session redactor has no remembered secrets after redacting the input. The start uses the same submitted body as the buffered route would. Eliza recognizes the exact UUID path and POST. Start shares the buffered message's funding, current owner, conversation and inference checks. In the pinned gateway, the constructor merges optional stream settings over defaults, refuses unknown keys or values that are not positive safe integers, and requires coalescing < hold < idle. Grace's release passes no stream overrides. It allows two held streams per owner and current gateway epoch. A successfully settled stream still occupies its slot until discard. The host reserves the slot before calling the agent, and an opening failure releases it. Opening requires the agent's successful event-stream media type and a fresh owner/epoch check. Non-success responses before opening preserve the structured status/body when the owner is still current. A successful response with the wrong media type fails opening, even though the upstream request was sent.

The renderer calls its buffered path on a completed start with no nonempty string stream ID, or a numeric 404, 405 or 501, a 503 whose code is undefined, or 429 with `MESSAGE_STREAM_LIMIT`. An abort observed on a fallback branch prevents the buffered call. The real gateway's own compatibility refusals and the pinned agent's plain early validation refusals give the supported fallback cases. A replacement producer must preserve their pre-effect meaning. A start error that does not qualify for fallback propagates its original failure. Once a stream ID has been accepted, pull failure cannot use buffered fallback. Grace `renderer-routes.json:14–16`, `local-agent-gateway.ts:170–199,567`, `runtime-client.ts:91–108`, `reply-stream.ts:38–91`. Eliza `gateway.mjs:20–36,132–163,269–322,466–529,755–789`.

```quint
type StreamLimits = { knownKeys: bool, heldMax: int, bufferedMax: int, idleMs: int, holdMs: int, coalesceMs: int }
pure val releaseLimits: StreamLimits = { knownKeys: true, heldMax: 2, bufferedMax: 262144, idleMs: 30000, holdMs: 2000, coalesceMs: 150 }
pure def positiveLimit(value: int): bool = value > 0 and value <= 9007199254740991
pure def streamConfiguration(limits: StreamLimits): bool =
  limits.knownKeys and positiveLimit(limits.heldMax) and positiveLimit(limits.bufferedMax) and positiveLimit(limits.idleMs) and positiveLimit(limits.holdMs) and positiveLimit(limits.coalesceMs) and limits.coalesceMs < limits.holdMs and limits.holdMs < limits.idleMs
pure def requestsStream(hasPreviewCallback: bool, hasTask: bool, hasSecrets: bool): bool =
  hasPreviewCallback and not(hasTask or hasSecrets)
pure def slotAvailable(currentHeld: int, limits: StreamLimits): bool = currentHeld >= 0 and currentHeld < limits.heldMax
type StartAnswer = { rejected: bool, hasStatus: bool, status: int, hasCode: bool, code: str, hasId: bool, aborted: bool }
pure def startFallbackStatus(start: StartAnswer): bool =
  start.hasStatus and (start.status == 404 or start.status == 405 or start.status == 501 or
    (start.status == 503 and not(start.hasCode)) or (start.status == 429 and start.code == "MESSAGE_STREAM_LIMIT" and start.hasCode))
pure def clientStartResult(start: StartAnswer): str =
  if ((start.rejected and startFallbackStatus(start)) or (not(start.rejected) and not(start.hasId)))
    (if (start.aborted) "stopped" else "buffered")
  else if (start.rejected) "failed"
  else "pull"
pure def lawStartIdPreventsBufferedFallback(start: StartAnswer): bool =
  not(start.rejected) and start.hasId implies clientStartResult(start) == "pull"
pure def lawStopPreventsRecognizedFallback(start: StartAnswer): bool =
  start.aborted implies clientStartResult(start) != "buffered"
pure val validStart: StartAnswer = { rejected: false, hasStatus: false, status: 0, hasCode: false, code: "", hasId: true, aborted: false }
pure val startValues = Set(validStart, { ...validStart, hasId: false }, { ...validStart, hasId: false, aborted: true }, { ...validStart, rejected: true, hasStatus: true, status: 429, hasCode: true, code: "MESSAGE_STREAM_LIMIT" }, { ...validStart, rejected: true, hasStatus: true, status: 429 }, { ...validStart, rejected: true, hasStatus: true, status: 503 }, { ...validStart, rejected: true, hasStatus: true, status: 503, hasCode: true, code: "INFERENCE_UNAVAILABLE" }, { ...validStart, rejected: true, hasStatus: true, status: 404, aborted: true })
pure val limitsValues = Set(releaseLimits, { ...releaseLimits, knownKeys: false }, { ...releaseLimits, holdMs: 0 }, { ...releaseLimits, idleMs: 2000 }, { ...releaseLimits, holdMs: 150 })
pure val currentHeldValues = Set(0, 1, 2, 3)
```

## Story: Pull only the admitted stream and release only acknowledged previews

### The host stores ordered previews and explicitly refuses a full buffer

Each decoded token contributes a string append, or, if the token has no string append, a string full-text replacement. Each arrival, including a replacement or an empty append, gets its next sequence number. The host retains replacement events as individual entries and counts their full length in UTF-16 code units. The outstanding count includes only queued events. A cursor at or below the latest sequence and at or above the acknowledged cursor can acknowledge and remove queued events through that cursor. An earlier cursor returns `409 MESSAGE_STREAM_CURSOR_EXPIRED`, a future or invalid cursor returns 400, and a missing stream or different conversation returns `404 MESSAGE_STREAM_NOT_FOUND`. Pull accepts exactly a string `streamId` and a nonnegative safe integer `cursor`. Cancel accepts exactly a string `streamId`. The wire decoder marks unsafe or noninteger input before converting a cursor to the model's integer coordinate.

At exactly 262,144 unacknowledged units the buffer can still be used. The next unit beyond the configured limit aborts the upstream reader, clears preview events and settles `503 MESSAGE_STREAM_BUFFER_FULL`. The failed stream keeps this typed outcome until discarded. It does not deliver a clipped final or convert the error into a buffered resend, even when the renderer received earlier previews. The limit is a transport backlog limit, independent of total preview output or final message length. The model counts UTF-16 widths supplied by the decoder and stores no text body. Eliza `gateway.mjs:20–36,387–463,530–569`.

```quint
type PreviewEvent = { seq: int, units: int }
pure def previewUnits(events: List[PreviewEvent]): int = events.foldl(0, (units, preview) => units + preview.units)
pure def unreadPreviews(events: List[PreviewEvent], cursor: int): List[PreviewEvent] =
  events.select(preview => preview.seq > cursor)
pure def wouldOverflow(heldUnits: int, addedUnits: int, ceiling: int): bool =
  heldUnits + addedUnits > ceiling
type PullRequest = { exactKeys: bool, streamIdString: bool, cursorSafe: bool, exactConversation: bool, streamExists: bool, cursor: int, acknowledged: int, latest: int }
pure def pullAdmission(pull: PullRequest): str =
  if (not(pull.exactKeys and pull.streamIdString and pull.cursorSafe) or pull.cursor < 0 or pull.cursor > 9007199254740991) "400-invalid"
  else if (not(pull.streamExists and pull.exactConversation)) "404-missing"
  else if (pull.cursor > pull.latest) "400-invalid"
  else if (pull.cursor < pull.acknowledged) "409-cursor"
  else "admitted"
pure def lawExactBufferLimitIsAdmitted(heldUnits: int, addedUnits: int, ceiling: int): bool =
  heldUnits + addedUnits == ceiling implies not(wouldOverflow(heldUnits, addedUnits, ceiling))
pure def lawNoAcknowledgementOutsideLiveRange(pull: PullRequest): bool =
  pullAdmission(pull) == "admitted" implies pull.streamExists and pull.exactConversation and pull.acknowledged <= pull.cursor and pull.cursor <= pull.latest
pure val livePull: PullRequest = { exactKeys: true, streamIdString: true, cursorSafe: true, exactConversation: true, streamExists: true, cursor: 1, acknowledged: 1, latest: 2 }
pure val pullValues = Set(livePull, { ...livePull, cursor: 2 }, { ...livePull, cursor: 3 }, { ...livePull, cursor: 0 }, { ...livePull, streamExists: false }, { ...livePull, exactConversation: false }, { ...livePull, cursorSafe: false })
pure val heldUnitsValues = Set(0, 262143, 262144)
pure val addedUnitsValues = Set(0, 1, 2, 262144)
pure val ceilingValues = Set(12, 262144)
pure val eventsValues = Set(List(), List({seq:1,units:1}, {seq:2,units:2}))
pure val cursorValues = Set(-1, 0, 1, 2, 3)
```

### A held pull can wake early and must recheck owner before publication

Each stream allows one waiting pull. An admitted newer pull advances the pull identity and wakes the prior waiter. The older request may then answer; it does not keep holding the slot. With no settled outcome, a current latest pull waits at most 2,000 ms. Queued preview chunks can release the hold on a phrase-ending punctuation mark, at 120 queued units, or 150 ms after the oldest queued arrival. Aborting its request ends the wait. After the wait it checks the stream still exists, then rechecks the captured owner and reset epoch immediately before returning preview or terminal data. Failed authority drops the stream. Cancellation of an exact stream discards only that stream and neither publishes text nor authorizes another conversation. A closed gateway also discards. A live or settled stream without a pull expires after 30,000 ms from the last touch, which can be opening or a pull. These predicates use current clock and authority facts, not Android bridge timers.

The host strips preview timestamps from the pull response. A successful done frame must have string `fullText`, passed intact as the final message's `text`. The terminal projection uses the buffered reply's allowed message metadata, omits reasoning/usage, and overlays only current authenticated task-choice data. It refuses an ephemeral assistant reply and a changed task presentation. An agent error frame or a stream ending without a valid terminal frame fails explicitly. The retained preview list never manufactures that final text or substitutes for a missing final frame. Eliza `gateway.mjs:67–101,324–351,354–465,547–608,957–960`.

```quint
type PullWait = { settled: bool, stillHeld: bool, latestPull: bool, requestAborted: bool, hasEvents: bool, phraseEnd: bool, units: int, oldestAt: int, deadline: int, now: int }
pure def waitsForMore(waiting: PullWait, coalesceMs: int): bool =
  not(waiting.settled or waiting.requestAborted) and waiting.stillHeld and waiting.latestPull and waiting.now < waiting.deadline and
  (not(waiting.hasEvents) or (not(waiting.phraseEnd) and waiting.units < 120 and waiting.now < waiting.oldestAt + coalesceMs))
pure def pullPublication(stillHeld: bool, currentOwner: bool, currentEpoch: bool): str =
  if (not(stillHeld)) "404-missing"
  else if (not(currentOwner and currentEpoch)) "409-not-owned"
  else "publish"
type DoneFrame = { hasText: bool, ephemeral: bool, ownerCurrent: bool, epochCurrent: bool, aborted: bool, sameTaskPresentation: bool, messageId: int }
pure def terminalMessage(doneFrame: DoneFrame): int =
  if (doneFrame.hasText and not(doneFrame.ephemeral or doneFrame.aborted) and doneFrame.ownerCurrent and doneFrame.epochCurrent and doneFrame.sameTaskPresentation) doneFrame.messageId else 0
pure def lawLostAuthorityCannotPublish(stillHeld: bool, currentOwner: bool, currentEpoch: bool): bool =
  not(currentOwner and currentEpoch) implies pullPublication(stillHeld, currentOwner, currentEpoch) != "publish"
pure def lawTerminalUsesExactCompleteMessage(doneFrame: DoneFrame): bool =
  terminalMessage(doneFrame) != 0 implies doneFrame.hasText and terminalMessage(doneFrame) == doneFrame.messageId
pure val waitingPull: PullWait = { settled: false, stillHeld: true, latestPull: true, requestAborted: false, hasEvents: true, phraseEnd: false, units: 4, oldestAt: 0, deadline: 2000, now: 100 }
pure val waitingValues = Set(waitingPull, { ...waitingPull, latestPull: false }, { ...waitingPull, now: 150 }, { ...waitingPull, now: 1999, hasEvents: false }, { ...waitingPull, now: 2000 }, { ...waitingPull, phraseEnd: true }, { ...waitingPull, units: 120 }, { ...waitingPull, requestAborted: true }, { ...waitingPull, settled: true })
pure val coalesceMsValues = Set(150)
pure val exactCompletion: DoneFrame = { hasText: true, ephemeral: false, ownerCurrent: true, epochCurrent: true, aborted: false, sameTaskPresentation: true, messageId: 1 }
pure val doneFrameValues = Set(exactCompletion, { ...exactCompletion, messageId: 2 }, { ...exactCompletion, hasText: false }, { ...exactCompletion, ephemeral: true }, { ...exactCompletion, ownerCurrent: false }, { ...exactCompletion, epochCurrent: false }, { ...exactCompletion, aborted: true }, { ...exactCompletion, sameTaskPresentation: false })
```

### A settled transport keeps its own result and discarding it frees the stream

This machine models one held stream after reservation. Each mock append uses its exact UTF-16 length. The sequence and cursor refer only to preview events. The opaque positive terminal identity stands for the full message, with no length constraint from the preview queue. Upstream failure, overflow, and successful completion settle one outcome. Acknowledgement can release preview entries even after success. A failed pull authority check, explicit cancellation or idle expiry discards the stream. The actual map key, owner, timers, reader and callback ordering are supplied by the shell. No receipt in this machine acknowledges a durable user effect.

```quint
type HostStream = { phase: str, seq: int, acknowledged: int, previews: List[PreviewEvent], finalId: int }
pure val initial: HostStream = { phase: "open", seq: 0, acknowledged: 0, previews: List(), finalId: 0 }
pure def canAddPreview(host: HostStream, units: int): bool = host.phase == "open" and units >= 0
pure def addPreview(host: HostStream, units: int): HostStream =
  if (wouldOverflow(previewUnits(host.previews), units, releaseLimits.bufferedMax))
    { ...host, phase: "buffer-full", seq: host.seq + 1, previews: List() }
  else { ...host, seq: host.seq + 1, previews: host.previews.append({ seq: host.seq + 1, units: units }) }
pure def canAcknowledgePreview(host: HostStream, cursor: int): bool =
  host.phase != "discarded" and cursor >= host.acknowledged and cursor <= host.seq
pure def acknowledgePreview(host: HostStream, cursor: int): HostStream =
  { ...host, acknowledged: cursor, previews: unreadPreviews(host.previews, cursor) }
pure def canSettleReply(host: HostStream): bool = host.phase == "open"
pure def settleReply(host: HostStream, doneFrame: DoneFrame): HostStream = {
  val messageId = terminalMessage(doneFrame)
  if (messageId > 0) { ...host, phase: "done", finalId: messageId }
  else { ...host, phase: "failed", previews: List() }
}
pure def canDiscardHostStream(host: HostStream): bool = host.phase != "discarded"
pure def discardHostStream(host: HostStream): HostStream = { ...host, phase: "discarded", finalId: 0, previews: List() }
pure def alwaysCoordinatesAreOrdered(host: HostStream): bool = host.seq >= 0 and host.acknowledged >= 0 and host.acknowledged <= host.seq
pure def alwaysOnlyDoneCarriesFinal(host: HostStream): bool = if (host.phase == "done") host.finalId > 0 else host.finalId == 0
pure def alwaysFailedAndDiscardedPreviewsAreEmpty(host: HostStream): bool =
  (host.phase == "buffer-full" or host.phase == "failed" or host.phase == "discarded") implies host.previews.length() == 0
pure def stepAcknowledgementNeverRegresses(before: HostStream, after: HostStream): bool = after.acknowledged >= before.acknowledged
pure def sometimesOverflowIsExplicit(host: HostStream): bool = host.phase == "buffer-full"
pure def sometimesTerminalSurvivesPreviewAcknowledgement(host: HostStream): bool =
  host.phase == "done" and host.finalId > 0 and host.acknowledged > 0 and host.previews.length() == 0
pure val unitsValues = Set(0, 1, 2, 262143, 262144, 262145)
pure val weight_addPreview = 6
pure val weight_acknowledgePreview = 5
pure val weight_settleReply = 5
```

## Story: Speak only admitted previews and keep the final reply separate

### The renderer can retry a lost pull, and final success requires its own message

For one accepted stream ID, the renderer begins at cursor zero. An unanswered pull can retry twice, after 250 ms, using the same stream ID and cursor. An answered status, abort, or exhausted retry budget fails the turn. The response needs an object, event array, nondecreasing safe integer cursor and boolean `done`. The pinned client checks event shape and receives events in gateway order, without independently validating each event sequence number. It prefers a string full snapshot over a string append when both occur in a supplied event. An append concatenates and ORs the provisional flag. A snapshot replaces the whole preview and sets its own provisional flag, so a confirmed snapshot can clear a prior hold. The callback sees a changed preview only when it is unheld. Its exception does not fail the turn.

A terminal pull needs an object message with string text and returns that message unchanged. A started failure or Stop invokes the preview failure callback before rejection. Cleanup requests cancel at most once, including after successful completion, and ignores cancel transport errors. The complete final payload stays distinct from this list of code units and the callback output. Grace `reply-stream.ts:38–45,85–135`.

```quint
type PreviewAssembly = { textUnits: List[int], held: bool, reportedUnits: List[int] }
type ClientToken = { fullSnapshot: bool, appendText: bool, units: List[int], provisional: bool }
pure def applyClientToken(assembly: PreviewAssembly, token: ClientToken): PreviewAssembly =
  if (token.fullSnapshot) { ...assembly, textUnits: token.units, held: token.provisional }
  else if (token.appendText) { ...assembly, textUnits: assembly.textUnits.concat(token.units), held: assembly.held or token.provisional }
  else assembly
pure def previewChanged(assembly: PreviewAssembly): bool = not(assembly.held) and assembly.textUnits != assembly.reportedUnits
type PullAnswerShape = { objectBody: bool, eventArray: bool, validEvents: bool, cursorSafe: bool, cursor: int, priorCursor: int, typedDone: bool, done: bool, messageText: bool }
pure def rendererAnswer(answer: PullAnswerShape): str =
  if (not(answer.objectBody and answer.eventArray and answer.validEvents and answer.cursorSafe and answer.cursor >= answer.priorCursor and answer.typedDone)) "invalid"
  else if (not(answer.done)) "preview-only"
  else if (answer.messageText) "complete-message" else "invalid"
pure def retryPull(transportAnswered: bool, attempt: int, aborted: bool): bool = not(transportAnswered or aborted) and attempt >= 0 and attempt < 2
pure def lawProvisionalPreviewCannotBeSpoken(assembly: PreviewAssembly): bool =
  assembly.held implies not(previewChanged(assembly))
pure def lawRendererNeedsTerminalText(answer: PullAnswerShape): bool =
  rendererAnswer(answer) == "complete-message" implies answer.done and answer.messageText
pure def lawAnsweredPullDoesNotRetry(transportAnswered: bool, attempt: int, aborted: bool): bool =
  transportAnswered or aborted implies not(retryPull(transportAnswered, attempt, aborted))
pure val assemblyValues = Set({ textUnits: List(65), held: false, reportedUnits: List() }, { textUnits: List(65), held: true, reportedUnits: List() }, { textUnits: List(65), held: false, reportedUnits: List(65) })
pure val tokenValues = Set({ fullSnapshot: true, appendText: false, units: List(66), provisional: false }, { fullSnapshot: false, appendText: true, units: List(66), provisional: true }, { fullSnapshot: false, appendText: true, units: List(66), provisional: false })
pure val completePull: PullAnswerShape = { objectBody: true, eventArray: true, validEvents: true, cursorSafe: true, cursor: 1, priorCursor: 0, typedDone: true, done: true, messageText: true }
pure val answerValues = Set(completePull, { ...completePull, done: false }, { ...completePull, messageText: false }, { ...completePull, validEvents: false }, { ...completePull, cursor: -1 }, { ...completePull, eventArray: false })
pure val attemptValues = Set(0, 1, 2, 3)
```
