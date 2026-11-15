# Request waiters, event streams and status heartbeats

The agent API answers some requests later than it receives them. A pending
request map (`packages/agent/src/api/pending-request-map.ts`) holds the
waiter for each request generation. Chat replies and other long responses
stream frames through a writer that honours backpressure
(`chat-stream-writer.ts`), and a WebSocket client that reconnects replays
events from its cursor (`ws-event-replay.ts`). A pending OAuth sign-in
reports its status over server-sent events (`accounts-routes.ts`).
[Chat](./chat.md) owns what a reply says; this spec owns how its frames and
waiters behave.

## Story: Wait for a reply without losing it to an old timeout

> As a client, my request is answered by its own reply, and a timeout meant
> for an earlier request never discards mine.

### A stale timeout cannot remove the waiter that replaced it

A new waiter for a newer generation replaces and settles the previous one.
A timeout fires for the generation it was armed for; if that waiter was
already replaced it changes nothing. Closing the map settles the current
waiter, and a settled generation never waits again.

```quint
type Events = { waiter: int, settled: Set[int], closed: bool, timedOut: int,
  oauthOpen: bool, oauthClosed: bool, heartbeatGoal: int, ticks: int, dataFrames: int,
  sent: int, flushed: int, blocked: bool, cancelled: bool, ended: bool, provisional: bool, published: int, cursor: int }
pure val initial: Events = { waiter: 0, settled: Set(), closed: false, timedOut: 0,
  oauthOpen: false, oauthClosed: false, heartbeatGoal: 0, ticks: 0, dataFrames: 0,
  sent: 0, flushed: 0, blocked: false, cancelled: false, ended: false, provisional: false, published: 0, cursor: 0 }
pure def settledWith(e: Events, generation: int): Set[int] = if (generation != 0) e.settled.union(Set(generation)) else e.settled
pure def canWaitRequest(e: Events, generation: int): bool =
  not(e.closed) and generation > 0 and not(e.settled.contains(generation)) and e.waiter != generation
pure def waitRequest(e: Events, generation: int): Events = { ...e, waiter: generation, settled: settledWith(e, e.waiter) }
pure def canSettleRequest(e: Events, generation: int): bool = e.waiter == generation and generation > 0
pure def settleRequest(e: Events, generation: int): Events = { ...e, waiter: 0, settled: settledWith(e, generation) }
pure def canTimeoutRequest(e: Events, generation: int): bool = generation > 0
pure def timeoutRequest(e: Events, generation: int): Events =
  if (e.waiter == generation) { ...e, waiter: 0, settled: settledWith(e, generation), timedOut: generation } else { ...e, timedOut: generation }
pure def closeRequests(e: Events): Events = { ...e, closed: true, waiter: 0, settled: settledWith(e, e.waiter) }
pure val generationValues = Set(0, 1, 2, 3)
pure def alwaysWaiterIsUnsettled(e: Events): bool =
  (e.waiter != 0 implies not(e.settled.contains(e.waiter))) and (e.closed implies e.waiter == 0)
pure def stepStaleTimeoutKeepsReplacement(before: Events, via: str, after: Events): bool =
  (via == "timeoutRequest" and after.timedOut != before.waiter) implies after.waiter == before.waiter
pure def sometimesReplacementSurvivesStaleTimeout(e: Events): bool = e.waiter > 0 and e.timedOut > 0 and e.timedOut != e.waiter
```

## Story: Stream a reply under backpressure

> As a client on a slow connection, I receive every frame of a reply in
> order and its end only after all of it, and cancelling stops it.

### A stream writes one frame at a time and ends only after every frame is flushed

The writer sends a frame only when the previous one has flushed. It ends
the stream only when nothing is blocked and every frame sent has flushed,
and never after cancellation. Cancelling during backpressure leaves the
unflushed frame unflushed and the stream unended. An authoritative text
replaces provisional text.

```quint
pure def canOpenStream(e: Events): bool = e.ended or e.cancelled
pure def openStream(e: Events): Events = { ...e, sent: 0, flushed: 0, blocked: false, cancelled: false, ended: false, provisional: false }
pure def canWriteFrame(e: Events): bool = not(e.cancelled) and not(e.ended) and not(e.blocked) and e.sent == e.flushed
pure def writeFrame(e: Events, provisional: bool): Events = { ...e, sent: e.sent + 1, blocked: true, provisional: provisional }
pure def canFlushFrame(e: Events): bool = not(e.cancelled) and e.blocked
pure def flushFrame(e: Events): Events = { ...e, flushed: e.sent, blocked: false }
pure def canCancelStream(e: Events): bool = not(e.ended) and not(e.cancelled)
pure def cancelStream(e: Events): Events = { ...e, cancelled: true }
pure def canEndStream(e: Events): bool = not(e.cancelled) and not(e.ended) and not(e.blocked) and e.sent == e.flushed and e.sent > 0 and not(e.provisional)
pure def endStream(e: Events): Events = { ...e, ended: true }
pure def alwaysFramesFlushInOrder(e: Events): bool =
  e.flushed <= e.sent and e.sent <= e.flushed + 1 and (e.blocked == (e.sent > e.flushed)) and
  (e.ended implies (not(e.cancelled) and e.flushed == e.sent and not(e.provisional)))
pure def sometimesCancelledDuringBackpressure(e: Events): bool = e.cancelled and e.blocked
pure def sometimesStreamEnded(e: Events): bool = e.ended and e.sent > 1
```

### A reconnecting client replays events from its cursor and never past the latest

Each published event takes the next position. A reconnecting client
replays from its cursor up to the latest event, so its cursor never passes
what was published.

```quint
pure def publishEvent(e: Events): Events = { ...e, published: e.published + 1 }
pure def canReplayEvents(e: Events): bool = e.cursor < e.published
pure def replayEvents(e: Events): Events = { ...e, cursor: e.published }
pure def alwaysCursorWithinPublished(e: Events): bool = e.cursor >= 0 and e.cursor <= e.published
pure def sometimesReplayCaughtUp(e: Events): bool = e.cursor > 1 and e.cursor == e.published
```

## Story: Keep a pending sign-in status stream alive until it finishes

> As a user signing in to an account, the page keeps waiting while the
> sign-in is pending, and learns the result when it ends.

### Heartbeats are comments that never change the reported status

While an OAuth status stream is pending it sends a comment heartbeat every
five seconds. A heartbeat carries no data frame: the stream has exactly its
pending data frame until the terminal one.

```quint
pure def canOpenOAuthStatus(e: Events, heartbeatGoal: int): bool = not(e.oauthOpen) and heartbeatGoal >= 1
pure def openOAuthStatus(e: Events, heartbeatGoal: int): Events =
  { ...e, oauthOpen: true, oauthClosed: false, heartbeatGoal: heartbeatGoal, ticks: 0, dataFrames: 1 }
pure def canHeartbeat(e: Events): bool = e.oauthOpen and not(e.oauthClosed) and e.ticks < e.heartbeatGoal
pure def heartbeat(e: Events): Events = { ...e, ticks: e.ticks + 1 }
pure def canFinishOAuthStatus(e: Events): bool = e.oauthOpen and not(e.oauthClosed) and e.ticks == e.heartbeatGoal
pure def finishOAuthStatus(e: Events): Events = { ...e, oauthClosed: true, dataFrames: e.dataFrames + 1 }
pure def canReopenOAuthStatus(e: Events): bool = e.oauthClosed
pure def reopenOAuthStatus(e: Events): Events = { ...e, oauthOpen: false, oauthClosed: false, heartbeatGoal: 0, ticks: 0, dataFrames: 0 }
pure val heartbeatGoalValues = Set(0, 1, 2)
pure def alwaysHeartbeatsCarryNoData(e: Events): bool =
  e.dataFrames == (if (e.oauthClosed) 2 else if (e.oauthOpen) 1 else 0) and e.ticks >= 0 and e.ticks <= e.heartbeatGoal and
  (e.oauthClosed implies e.oauthOpen)
pure def sometimesHeartbeatsThenTerminal(e: Events): bool = e.oauthClosed and e.ticks == 2
```

### A pending status stream reaches its terminal frame

Assuming the heartbeat timer runs and the flow ends, every pending status
stream closes with its terminal frame.

```quint
pure def leadsToOAuthStatusCloses(e: Events, later: Events): bool = (e.oauthOpen and not(e.oauthClosed)) implies later.oauthClosed
pure val fair_heartbeat = "weak"
pure val fair_finishOAuthStatus = "weak"
```
