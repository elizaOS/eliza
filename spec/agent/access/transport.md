# Local request exchange

How a local caller reaches the agent: one exchange per connection, over the
private Unix socket the os agent service connects to, or loopback HTTP on
`127.0.0.1` for a development host (`host/launch.md` picks one). Both feed
one router; os imports the frames (`spec/os/agentService/channel.md`).

The socket carries one newline-terminated JSON frame each way per message,
byte-compatible with develop's resident. In:
`{id, method: "http_request" | "http_request_stream" | "events_subscribe", payload}`,
where a request's payload is `{path, method, headers, body | bodyBase64}`
and a subscription's is `{streams: [...], clientId?}`. Out, buffered:
`{id, ok: true, result: {status, statusText, headers, body, bodyBase64, bodyEncoding}}`,
or `{id, ok: false, error}` for a refusal. Out, streaming:
`{id, stream: "response", status, statusText, headers}`, then
`{id, stream: "chunk", dataBase64}`, then `{id, stream: "complete"[, error]}`.
Out, subscription: `{type: "subscribed"}`, then
`{type: "event", event: {type: "agent_event", stream, …}}`. Loopback HTTP
serves the same exchange as an HTTP response, a chunked response for a
stream, and server-sent events at `GET /api/events?streams=…&clientId=`.
`Frame` names these in order (`CompleteFailed` is `complete` with `error`).
Bytes, JSON and route matching stay in `access/socket.vibe` and
`access/http.vibe`; the effects write a frame, dispatch a handler with its
deadline, or abort its signal. After a terminal frame the shell ends the
connection; after an abort it destroys it. Sources: develop
`plugins/plugin-native-inference/src/android/{private-ipc,dispatch,event-subscription}.ts`,
`packages/agent/src/api/dispatch-route.ts`, Quint `api-http-body`, `api-transport`.

## Story: Answer each local request exactly once

> As the app on my phone, I want each request I hand the agent answered
> exactly once, or cut short when I hang up or it takes too long, so that I
> never act on two answers or wait for ever.

### A connection carries one request, read from one frame, and is never replayed

A connection is numbered when accepted and its number is never reused. Only
its first frame is read; the shell treats a second frame as a peer close. A
request is dispatched at most once, from its first frame, and nothing is
read while the listener is closing.

```quint
import resources as RS from "../host/resources"
type RouteClass = MessageRoute | SpeechRoute | RunRoute | PlainRoute
type Call = { route: RouteClass, bodyBytes: int }
type Inbound = Unreadable | HttpRequest(Call) | HttpRequestStream(Call) | EventsSubscribe
type Frame = Result({ status: int }) | Refusal | Head({ code: int }) | Chunk | Complete | CompleteFailed | Subscribed | AgentEvent
type End = Answered | Malformed | TooLarge | Busy | Failed | TimedOut | PeerClosed | Stopped
type Stage = Reading | Buffering | Heading | Streaming | Feeding | Ended({ end: End })
type Exchange = { conn: int, stage: Stage }
type Effect = Write({ conn: int, frame: Frame }) | Dispatch({ conn: int, deadlineMs: int }) | Abort({ conn: int })
type Address = PrivateSocket | LoopbackHttp | OtherAddress
type Transport = { listeners: RS::Resources, exchanges: List[Exchange] }
type Wire = { state: Transport, out: List[Effect] }
type Opening = { stage: Stage, out: List[Effect] }
pure val initial: Transport = { listeners: RS::initial, exchanges: List() }
pure val connValues = Set(1, 2, 3)
pure val statusValues = Set(200, 404)
pure val inboundValues = Set(Unreadable, EventsSubscribe, HttpRequest({ route: PlainRoute, bodyBytes: 512 }), HttpRequest({ route: PlainRoute, bodyBytes: 3000000 }), HttpRequest({ route: MessageRoute, bodyBytes: 3000000 }), HttpRequest({ route: RunRoute, bodyBytes: 512 }), HttpRequestStream({ route: SpeechRoute, bodyBytes: 512 }), HttpRequestStream({ route: PlainRoute, bodyBytes: 3000000 }))
pure def isLive(st: Stage): bool = match st { | Ended(x) => false | _ => true }
pure def isDispatched(st: Stage): bool = isLive(st) and st != Reading
pure def known(s: Transport, conn: int): bool = s.exchanges.some(e => e.conn == conn)
pure def liveIn(s: Transport, conn: int): bool = s.exchanges.some(e => e.conn == conn and isLive(e.stage))
pure def dispatchedIn(s: Transport, conn: int): bool = s.exchanges.some(e => e.conn == conn and isDispatched(e.stage))
pure def inStage(s: Transport, conn: int, st: Stage): bool = s.exchanges.some(e => e.conn == conn and e.stage == st)
pure def moveTo(conn: int, s: Transport, st: Stage, out: List[Effect]): Wire =
  { state: { ...s, exchanges: s.exchanges.listMap(e => if (e.conn == conn) { ...e, stage: st } else e) }, out: out }
pure def canAccept(s: Transport, conn: int): bool = s.listeners.phase == RS::Open and s.listeners.held.length() > 0 and not(known(s, conn))
pure def accept(s: Transport, conn: int): Transport = { ...s, exchanges: s.exchanges.append({ conn: conn, stage: Reading }) }
pure def effectConn(x: Effect): int = match x { | Write(w) => w.conn | Dispatch(d) => d.conn | Abort(a) => a.conn }
pure def isDispatch(x: Effect): bool = match x { | Dispatch(d) => true | _ => false }
pure val feedLimit = 2
pure def admit(conn: int, inbound: Inbound, feeds: int): Opening = match inbound {
  | Unreadable => { stage: Ended({ end: Malformed }), out: List(Write({ conn: conn, frame: Refusal })) }
  | EventsSubscribe => if (feeds < feedLimit) { stage: Feeding, out: List(Write({ conn: conn, frame: Subscribed })) } else { stage: Ended({ end: Busy }), out: List(Write({ conn: conn, frame: Refusal })) }
  | HttpRequest(c) => if (c.bodyBytes <= bodyLimitBytes(c.route)) { stage: Buffering, out: List(Dispatch({ conn: conn, deadlineMs: deadlineMs(c.route, false) })) } else { stage: Ended({ end: TooLarge }), out: List(Write({ conn: conn, frame: Result({ status: 413 }) })) }
  | HttpRequestStream(c) => if (c.bodyBytes <= bodyLimitBytes(c.route)) { stage: Heading, out: List(Dispatch({ conn: conn, deadlineMs: deadlineMs(c.route, true) })) } else { stage: Ended({ end: TooLarge }), out: List(Write({ conn: conn, frame: Head({ code: 413 }) }), Write({ conn: conn, frame: Complete })) }
}
pure def feedCount(s: Transport): int = s.exchanges.select(e => e.stage == Feeding).length()
pure def canReceive(s: Transport, conn: int): bool = s.listeners.phase == RS::Open and inStage(s, conn, Reading)
pure def receive(s: Transport, conn: int, inbound: Inbound): Wire = {
  val o = admit(conn, inbound, feedCount(s))
  moveTo(conn, s, o.stage, o.out)
}
pure def alwaysConnectionsDistinct(s: Transport): bool = s.exchanges.every(e => s.exchanges.select(f => f.conn == e.conn).length() == 1)
pure def stepEffectsOnlyForLiveExchanges(before: Transport, after: Transport, out: List[Effect]): bool = out.every(x => liveIn(before, effectConn(x)))
pure def stepEndedIsFinal(before: Transport, after: Transport): bool = before.exchanges.every(e => known(after, e.conn) and (isLive(e.stage) or after.exchanges.includes(e)))
pure def stepDispatchedOnce(before: Transport, after: Transport, out: List[Effect]): bool =
  out.every(x => isDispatch(x) implies (inStage(before, effectConn(x), Reading) and not(inStage(after, effectConn(x), Reading)))) and
    before.exchanges.every(e => e.stage != Reading implies not(inStage(after, e.conn, Reading)))
```

### An unreadable frame gets one refusal and dispatches nothing

A frame is unreadable when it is not one line of UTF-8 JSON of at most
24 MiB, names another method, or its payload does not fit its method: a
path that is not local, a stream flag that contradicts the method, or a
stream filter that is empty, longer than 16 names or has a name outside
`[a-z0-9][a-z0-9_.:-]{0,63}`.

```quint
pure val frameLimitBytes = 25165824
pure def sometimesMalformedRefused(s: Transport): bool = s.exchanges.some(e => e.stage == Ended({ end: Malformed }))
```

### A body over its route's limit is answered 413 before dispatch

A message route takes 20 MiB and every other route 2 MiB; `GET /api/status`
reports the limit. A buffered request gets a 413 result; a stream gets a
413 head and its completion.

```quint
pure val messageBodyLimitBytes = 20971520
pure val plainBodyLimitBytes = 2097152
pure def bodyLimitBytes(route: RouteClass): int = if (route == MessageRoute) messageBodyLimitBytes else plainBodyLimitBytes
pure def withinLimit(inbound: Inbound): bool = match inbound {
  | HttpRequest(c) => c.bodyBytes <= bodyLimitBytes(c.route)
  | HttpRequestStream(c) => c.bodyBytes <= bodyLimitBytes(c.route)
  | _ => false
}
pure val feedsValues = Set(0, 1, 2)
pure def lawOnlyARequestWithinItsLimitIsDispatched(inbound: Inbound, feeds: int): bool = admit(1, inbound, feeds).out.some(x => isDispatch(x)) implies withinLimit(inbound)
pure def sometimesTooLargeRefused(s: Transport): bool = s.exchanges.some(e => e.stage == Ended({ end: TooLarge }))
```

### A request gets 10 seconds, or 600 on a message, speech or stream route

Speech covers the voice and local-speech routes. A trigger's Run now counts
as a message route here, since it answers only when its turn has ended, but
keeps the 2 MiB body limit. The deadline starts at dispatch; a subscription
has none.

```quint
pure val shortDeadlineMs = 10000
pure val longDeadlineMs = 600000
pure def deadlineMs(route: RouteClass, streamed: bool): int = if (streamed or route != PlainRoute) longDeadlineMs else shortDeadlineMs
```

### A dispatched request is answered by its handler with one result, or failed with 500

```quint
pure def isTerminal(f: Frame): bool = match f { | Result(r) => true | Refusal => true | Complete => true | CompleteFailed => true | _ => false }
pure def endsAnswered(st: Stage): bool = match st { | Ended(x) => x.end != PeerClosed and x.end != Stopped | _ => false }
pure def terminalCount(out: List[Effect], conn: int): int = out.foldl(0, (n, x) => match x { | Write(w) => if (w.conn == conn and isTerminal(w.frame)) n + 1 else n | _ => n })
pure def cutOff(conn: int, st: Stage, code: int): List[Effect] =
  if (st == Buffering) List(Write({ conn: conn, frame: Result({ status: code }) }))
  else if (st == Heading) List(Write({ conn: conn, frame: Head({ code: code }) }), Write({ conn: conn, frame: CompleteFailed }))
  else List(Write({ conn: conn, frame: CompleteFailed }))
pure def canRespond(s: Transport, conn: int): bool = inStage(s, conn, Buffering)
pure def respond(s: Transport, conn: int, status: int): Wire = moveTo(conn, s, Ended({ end: Answered }), List(Write({ conn: conn, frame: Result({ status: status }) })))
pure def canHandlerFails(s: Transport, conn: int): bool = inStage(s, conn, Buffering) or inStage(s, conn, Heading) or inStage(s, conn, Streaming)
pure def handlerFails(s: Transport, conn: int): Wire = {
  val st = if (inStage(s, conn, Buffering)) Buffering else if (inStage(s, conn, Heading)) Heading else Streaming
  moveTo(conn, s, Ended({ end: Failed }), cutOff(conn, st, 500))
}
pure def stepAnsweredOnce(before: Transport, after: Transport, out: List[Effect]): bool =
  after.exchanges.every(e => terminalCount(out, e.conn) == (if (liveIn(before, e.conn) and endsAnswered(e.stage)) 1 else 0))
pure def sometimesAnswered(s: Transport): bool = s.exchanges.some(e => e.stage == Ended({ end: Answered }))
pure def sometimesFailed(s: Transport): bool = s.exchanges.some(e => e.stage == Ended({ end: Failed }))
```

### At the deadline a request is answered 504, then its handler is aborted

A stream already under way ends with a failed completion instead.

```quint
pure def canExpire(s: Transport, conn: int): bool = canHandlerFails(s, conn)
pure def expire(s: Transport, conn: int): Wire = {
  val st = if (inStage(s, conn, Buffering)) Buffering else if (inStage(s, conn, Heading)) Heading else Streaming
  moveTo(conn, s, Ended({ end: TimedOut }), cutOff(conn, st, 504).append(Abort({ conn: conn })))
}
pure def is504OrFailedEnd(x: Effect): bool = match x {
  | Write(w) => w.frame == Result({ status: 504 }) or w.frame == Head({ code: 504 }) or w.frame == CompleteFailed
  | _ => true
}
pure def isAbort(x: Effect): bool = match x { | Abort(a) => true | _ => false }
pure def stepTimeoutAnswers504ThenAborts(before: Transport, via: str, after: Transport, out: List[Effect]): bool =
  via == "expire" implies (out.every(x => is504OrFailedEnd(x)) and out.length() > 0 and isAbort(out.nthOr(out.length() - 1, Write({ conn: 0, frame: Refusal }))))
pure def sometimesTimedOut(s: Transport): bool = s.exchanges.some(e => e.stage == Ended({ end: TimedOut }))
```

### A peer that hangs up first aborts the handler, and a late answer writes nothing

The peer closing before the terminal frame is the only way a caller cancels;
whatever the handler produces afterwards is dropped by the guards. The
handler is aborted exactly when a dispatched exchange is cut short: by the
deadline, a hang-up or a stop.

```quint
pure def cutShort(st: Stage): bool = st == Ended({ end: TimedOut }) or st == Ended({ end: PeerClosed }) or st == Ended({ end: Stopped })
pure def abortIfDispatched(conn: int, s: Transport): List[Effect] = if (dispatchedIn(s, conn)) List(Abort({ conn: conn })) else List()
pure def canPeerClose(s: Transport, conn: int): bool = liveIn(s, conn)
pure def peerClose(s: Transport, conn: int): Wire = moveTo(conn, s, Ended({ end: PeerClosed }), abortIfDispatched(conn, s))
pure def abortedIn(out: List[Effect], conn: int): bool = out.some(x => isAbort(x) and effectConn(x) == conn)
pure def stepAbortExactlyWhenCutShort(before: Transport, after: Transport, out: List[Effect]): bool =
  after.exchanges.every(e => abortedIn(out, e.conn) iff (dispatchedIn(before, e.conn) and cutShort(e.stage)))
pure def sometimesHungUpMidRequest(s: Transport): bool = s.exchanges.some(e => e.stage == Ended({ end: PeerClosed }))
```

### A dispatched request settles at the latest at its deadline

A subscription has no request deadline. It ends when its connection closes.

```quint
pure val fair_expire = "weak"
pure def leadsToSettled(s: Transport, later: Transport): bool =
  s.exchanges.every(e => (isDispatched(e.stage) and e.stage != Feeding) implies not(liveIn(later, e.conn)))
```

## Story: Stream a response and end it once

> As the app showing a reply as it is written, I want the head first, then
> the pieces in order, then one end, and my live events on the same kind of
> connection, so that I can draw the reply and know when it is done.

### A stream writes its head first, then chunks, then one completion

A frame is written only where the protocol allows it: a result to a
buffered request, a head to a stream not yet started, chunks and a
completion only after the head, events only to a confirmed subscription.

```quint
pure def isHead(f: Frame): bool = match f { | Head(h) => true | _ => false }
pure def mayWrite(before: Transport, out: List[Effect], conn: int, f: Frame): bool = {
  val reading = inStage(before, conn, Reading)
  val streaming = inStage(before, conn, Streaming)
  val headNow = out.some(x => match x { | Write(w) => w.conn == conn and isHead(w.frame) | _ => false })
  match f {
    | Result(r) => reading or inStage(before, conn, Buffering)
    | Refusal => reading
    | Head(h) => reading or inStage(before, conn, Heading)
    | Chunk => streaming
    | Complete => streaming or headNow
    | CompleteFailed => streaming or headNow
    | Subscribed => reading
    | AgentEvent => inStage(before, conn, Feeding)
  }
}
pure def canSendHead(s: Transport, conn: int): bool = inStage(s, conn, Heading)
pure def sendHead(s: Transport, conn: int, status: int): Wire = moveTo(conn, s, Streaming, List(Write({ conn: conn, frame: Head({ code: status }) })))
pure def canSendChunk(s: Transport, conn: int): bool = inStage(s, conn, Streaming)
pure def sendChunk(s: Transport, conn: int): Wire = moveTo(conn, s, Streaming, List(Write({ conn: conn, frame: Chunk })))
pure def canComplete(s: Transport, conn: int): bool = inStage(s, conn, Streaming)
pure def complete(s: Transport, conn: int): Wire = moveTo(conn, s, Ended({ end: Answered }), List(Write({ conn: conn, frame: Complete })))
pure def stepFramesFollowTheProtocol(before: Transport, after: Transport, out: List[Effect]): bool =
  out.every(x => match x { | Write(w) => mayWrite(before, out, w.conn, w.frame) | _ => true })
pure def sometimesStreaming(s: Transport): bool = s.exchanges.some(e => e.stage == Streaming)
```

### A subscription is confirmed once, carries events in order, and at most two are open

A subscription beyond the second open one is refused as busy. It ends when
the peer hangs up, the agent stops or the [event feed](../conversation/events.md)
closes its connection. A subscription is never replayed.

```quint
pure def canPublish(s: Transport, conn: int): bool = inStage(s, conn, Feeding)
pure def publish(s: Transport, conn: int): Wire = { state: s, out: List(Write({ conn: conn, frame: AgentEvent })) }
pure def alwaysAtMostTwoFeeds(s: Transport): bool = feedCount(s) <= feedLimit
pure def sometimesTwoFeeds(s: Transport): bool = feedCount(s) == feedLimit
pure def sometimesBusyRefused(s: Transport): bool = s.exchanges.some(e => e.stage == Ended({ end: Busy }))
pure val eval_witness_sometimesTwoFeeds = (("listen", PrivateSocket), ("accept", 1), ("receive", 1, EventsSubscribe), ("accept", 2), ("receive", 2, EventsSubscribe))
pure val eval_witness_sometimesBusyRefused = (("listen", PrivateSocket), ("accept", 1), ("receive", 1, EventsSubscribe), ("accept", 2), ("receive", 2, EventsSubscribe), ("accept", 3), ("receive", 3, EventsSubscribe))
```

## Story: Close the listeners once

> As the agent process, I want to listen only where my host can reach me
> privately and, when I stop, to stop taking requests, cut the open ones
> short and give the listener back once.

### The agent listens on one address, its private socket or 127.0.0.1

It never binds another address. The listener is held in `RS` as `socket`
or `loopback`.

```quint
pure def listenerName(address: Address): str = match address { | PrivateSocket => "socket" | LoopbackHttp => "loopback" | OtherAddress => "" }
pure def canListen(s: Transport, address: Address): bool = RS::canAcquire(s.listeners) and address != OtherAddress and s.listeners.held.length() == 0
pure def listen(s: Transport, address: Address): Transport = { ...s, listeners: RS::acquire(s.listeners, listenerName(address)) }
pure def alwaysListensLocallyOnce(s: Transport): bool =
  s.listeners.held.length() <= 1 and s.listeners.held.every(l => l == "socket" or l == "loopback")
pure def alwaysExchangesCameThroughAListener(s: Transport): bool = s.exchanges.length() > 0 implies s.listeners.held.length() > 0
pure def sometimesServingLoopback(s: Transport): bool = s.listeners.held == List("loopback") and s.exchanges.length() > 0
```

### Stopping takes nothing new, cuts every open exchange short, then releases the listener

Closing goes through `RS`: a second close changes nothing. While closing no
connection is accepted and no frame is read; each open exchange is dropped,
which aborts its handler; the listener is released only when none is open.

```quint
pure def close(s: Transport): Transport = { ...s, listeners: RS::close(s.listeners) }
pure def canDrop(s: Transport, conn: int): bool = s.listeners.phase != RS::Open and liveIn(s, conn)
pure def drop(s: Transport, conn: int): Wire = moveTo(conn, s, Ended({ end: Stopped }), abortIfDispatched(conn, s))
pure def canReleaseNext(s: Transport, ok: bool): bool = RS::canReleaseNext(s.listeners) and not(s.exchanges.some(e => isLive(e.stage)))
pure def releaseNext(s: Transport, ok: bool): Transport = { ...s, listeners: RS::releaseNext(s.listeners, ok) }
pure def alwaysNothingOpenOnceClosed(s: Transport): bool = s.listeners.phase == RS::Closed implies not(s.exchanges.some(e => isLive(e.stage)))
pure def sometimesClosedAfterCuttingShort(s: Transport): bool = s.listeners.phase == RS::Closed and s.exchanges.some(e => e.stage == Ended({ end: Stopped }))
pure val fair_drop = "weak"
pure val fair_releaseNext = "weak"
pure def leadsToListenerReleased(s: Transport, later: Transport): bool = s.listeners.phase == RS::Closing implies later.listeners.phase == RS::Closed
```
