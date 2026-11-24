# Agent channel

How a call from the app reaches the agent through the agent service. Two
kinds of caller use the channel: the renderer, through the `ElizaAgent`
Capacitor plugin (`request`, `requestStream`, `abort`, `subscribeEvents`,
`unsubscribeEvents`), and native code, through the `AgentService` Java API
(`request`, `requestStream`, `subscribe`). Each kind has its own route list
(the renderer's from `./config`, the native one from the host profile),
checked by the imported route gate (`spec/agent/access/routes.md`). An
admitted call goes to the agent's owner-only socket as one frame of the
agent's transport (`http_request`, `http_request_stream` or
`events_subscribe`, one call per connection), with the launch's root token
attached by the service. Both callers' `request` and `requestStream` may
name request headers, which cross only as the runtime client carries them
(`spec/agent/client/runtimeClient.md`): a native host that serves the
renderer's runtime client over its own bridge passes that client's headers
on, so a device-action proposal starts the same way on either path.

The channel holds no lifecycle state of its own: the shell forwards the
service's launches (`spec/os/agentService/lifecycle.md`) as `open` when a
launch is running and `retire` when it stops serving. Sockets, JSON, the
token header and deadlines stay in the shell; a deadline or a closed
connection reaches the channel as `lost`. Sources: an embedding app's
agent contract, develop's `PendingRequests.java` and
`OwnerRoutePolicy.java`, and the stream, voice and view feeds of a phone
image's agent plugin.

## Story: Ask the agent only on the routes my app allows

> As the maker of an app that embeds the agent, I want my screens and my
> native code to reach the agent only on the routes each of them lists, so
> that nothing else on the device can ask my agent for anything.

### Each caller kind is admitted against its own route list, loaded whole or not at all

The renderer and native lists are two route gates. Loading a list uses the
gate's own rule: a broken list leaves that kind's gate unloaded, and an
unloaded gate refuses every call of that kind.

```quint
import routes as Routes from "../../agent/access/routes"
type CallerKind = Renderer | Native
type Topic = Voice | View | Notices
type Mode = Plain | Stream | Watch({ topic: Topic })
type Launch = NotServing | Serving({ epoch: int })
type Entry = { seq: int, id: str, owner: str, mode: Mode, epoch: int, delivered: int }
type FailCode = NotReady | RouteRefused | TooLarge | IdInUse | TopicInUse | Busy | Restarted | Broken
type Outcome = Response({ status: int }) | End | Error | Aborted | Failed({ code: FailCode })
type ChannelOut = Refused({ id: str, code: FailCode }) | Accepted({ id: str, seq: int }) | Delivered({ id: str, seq: int, index: int }) | Settled({ id: str, seq: int, mode: Mode, outcome: Outcome })
type SecretRootToken = str
type AgentChannel = { renderer: Routes::RouteGate, native: Routes::RouteGate, launch: Launch, lastEpoch: int, rootToken: SecretRootToken, nextSeq: int, pending: List[Entry], recent: List[ChannelOut] }
type ChannelStep = { state: AgentChannel, out: List[ChannelOut] }
pure val initial: AgentChannel = { renderer: Routes::initial, native: Routes::initial, launch: NotServing, lastEpoch: 0, rootToken: "", nextSeq: 0, pending: List(), recent: List() }
pure def gateOf(kind: CallerKind, s: AgentChannel): Routes::RouteGate = if (kind == Renderer) s.renderer else s.native
pure def loadRoutes(s: AgentChannel, kind: CallerKind, routes: List[Routes::Group]): AgentChannel =
  if (kind == Renderer) { ...s, renderer: Routes::load(s.renderer, routes) } else { ...s, native: Routes::load(s.native, routes) }
pure def emit(out: List[ChannelOut], s: AgentChannel): ChannelStep = { state: { ...s, recent: out }, out: out }
```

### The launch's root token stays inside the service

The token is the owner credential of the running launch. The service
attaches it to each socket call; no answer, frame or event the channel
gives a caller carries it, and it is dropped when the launch retires.

```quint
pure def canOpen(s: AgentChannel, epoch: int): bool = s.launch == NotServing and epoch > s.lastEpoch
pure def open(s: AgentChannel, epoch: int, rootToken: SecretRootToken): AgentChannel = { ...s, launch: Serving({ epoch: epoch }), lastEpoch: epoch, rootToken: rootToken, recent: List() }
pure val epochValues = Set(1, 2)
pure val rootTokenValues = Set("token1", "token2")
pure def alwaysTokenOnlyWhileServing(s: AgentChannel): bool = s.launch == NotServing implies s.rootToken == ""
```

### The token is written only to a socket whose peer is this app

Before the first byte of a call, the service reads the user id the kernel
reports for the other end of the agent socket. A peer of another user id,
or one whose user id cannot be read, gets no token and no request; the
socket is closed and the call fails as a lost connection.

```quint
type SocketPeer = PeerOfUser({ uid: int }) | PeerUnread
pure def peerTrusted(peer: SocketPeer, appUid: int): bool = match peer {
  | PeerOfUser(p) => p.uid == appUid
  | PeerUnread => false }
pure val peerValues = Set(PeerOfUser({ uid: 1 }), PeerOfUser({ uid: 2 }), PeerUnread)
pure val appUidValues = Set(1, 2)
pure def lawOnlyThisAppsPeerGetsTheToken(peer: SocketPeer, appUid: int): bool =
  peerTrusted(peer, appUid) implies peer == PeerOfUser({ uid: appUid })
pure def lawAnUnreadPeerGetsNothing(appUid: int): bool = not(peerTrusted(PeerUnread, appUid))
```

### A call is refused before any I/O unless the agent is serving, its id is free and its list admits it

The checks run in this order: no serving launch is `NotReady`; an id
already pending is `IdInUse`; then the caller kind's gate decides, and its
`RouteRefused` and `TooLarge` (a body over the route's limit) are passed on;
last, the call's headers decide (next rule). A refused call opens no
connection. A streamed request matches only a streaming route and a plain one
only a route that does not stream; that is the gate's rule.

```quint
pure def launchEpoch(launch: Launch): int = match launch { | Serving(l) => l.epoch | NotServing => 0 }
pure def servingEpoch(s: AgentChannel): int = launchEpoch(s.launch)
pure def idPending(s: AgentChannel, id: str): bool = s.pending.some(e => e.id == id)
pure def refusalOf(s: AgentChannel, kind: CallerKind, id: str, request: Routes::Request, headers: List[RC::RequestHeader]): List[FailCode] = {
  val a = Routes::admission(Routes::served(gateOf(kind, s).table), request)
  if (s.launch == NotServing) List(NotReady)
  else if (id == "" or idPending(s, id)) List(IdInUse)
  else if (a == Routes::RouteRefused) List(RouteRefused)
  else if (a == Routes::TooLarge) List(TooLarge)
  else headerRefusal(headers)
}
pure def admitEntry(id: str, owner: str, mode: Mode, s: AgentChannel): ChannelStep =
  emit(List(Accepted({ id: id, seq: s.nextSeq })), { ...s, nextSeq: s.nextSeq + 1, pending: s.pending.append({ seq: s.nextSeq, id: id, owner: owner, mode: mode, epoch: servingEpoch(s), delivered: 0 }) })
pure def ask(s: AgentChannel, kind: CallerKind, owner: str, id: str, request: Routes::Request, headers: List[RC::RequestHeader]): ChannelStep = {
  val refused = refusalOf(s, kind, id, request, headers)
  if (refused.length() > 0) emit(List(Refused({ id: id, code: refused.nthOr(0, NotReady) })), s)
  else admitEntry(id, owner, if (request.delivery == Routes::Streamed) Stream else Plain, s)
}
pure val idValues = Set("call1", "call2", "call3")
pure val ownerValues = Set("screen1", "screen2")
pure def stepRefusalOpensNothing(before: AgentChannel, via: str, after: AgentChannel, out: List[ChannelOut]): bool =
  out.some(o => match o { | Refused(r) => true | _ => false }) implies (after.pending == before.pending and after.nextSeq == before.nextSeq)
```

### Only the device headers and client id the runtime client carries cross the channel

The service classifies a call's headers by the runtime client's rule, the
same for a renderer call and a native one: a call
naming a header the client would not carry (a credential such as
`x-eliza-device-token`, an `x-eliza-device-key` whose value is not 64
lowercase hexadecimal digits, an authorization, cookie or hop-by-hop header,
any name outside `x-eliza-device-*` and `x-elizaos-client-id`, a value that
is not printable ASCII or a name given twice) is `RouteRefused`, and one with
more headers or bytes than the client's bounds is `TooLarge`. A well-formed
`x-eliza-device-key` crosses: this channel is an owner-only boundary on the
same device, where the root token proves the owner but not which enrolled
installation is speaking, and enrollment is keyed per installation. An
admitted call's
headers reach the agent's socket with lowercase names, beside the
`authorization` and content type the service sets, which no carried name can
replace; the agent's routes read them as they read headers over HTTP.

```quint
import runtimeClient as RC from "../../agent/client/runtimeClient"
pure def headerRefusal(headers: List[RC::RequestHeader]): List[FailCode] =
  if (not(RC::headersCross(headers))) List(RouteRefused) else if (not(RC::headersFit(headers))) List(TooLarge) else List()
pure def lawWithheldHeadersAreRefused(headers: List[RC::RequestHeader]): bool =
  headers.some(h => h.name == RC::DeviceCredential or h.name == RC::OtherHeader or not(h.printable)) implies headerRefusal(headers) == List(RouteRefused)
pure def lawOnlyCarriedHeadersAreAdmitted(headers: List[RC::RequestHeader]): bool =
  headerRefusal(headers).length() == 0 iff RC::headersCarried(headers)
pure def lawAWellFormedEnrollmentKeyCrosses(headers: List[RC::RequestHeader]): bool =
  (headers.length() == 1 and headers.every(h => h.name == RC::EnrollmentKey and h.printable and h.bytes <= RC::headerBytesLimit)) implies headerRefusal(headers) == List()
```

### An admitted call is bound to the serving launch and gets a sequence number never used before

The service answers the caller with the sequence number and addresses the
call's socket by it, so a caller may reuse an id once its call settled
without ever receiving an earlier call's frames.

```quint
pure def alwaysLaunchIsTheLatest(s: AgentChannel): bool = s.lastEpoch >= 0 and s.nextSeq >= 0 and (s.launch == NotServing or servingEpoch(s) == s.lastEpoch) and servingEpoch(s) >= 0
pure def alwaysPendingBelongToServingLaunch(s: AgentChannel): bool = s.pending.every(e => s.launch != NotServing and e.epoch == servingEpoch(s))
pure def alwaysSeqsFreshAndDistinct(s: AgentChannel): bool =
  s.pending.every(e => e.seq >= 0 and e.seq < s.nextSeq and s.pending.select(o => o.seq == e.seq).length() == 1 and s.pending.select(o => o.id == e.id).length() == 1)
pure def stepAcceptedTakesTheNextSeq(before: AgentChannel, via: str, after: AgentChannel, out: List[ChannelOut]): bool =
  out.every(o => match o { | Accepted(a) => a.seq == before.nextSeq and after.nextSeq == before.nextSeq + 1 | _ => true })
```

### A pending call settles exactly once, and nothing else leaves the pending list

Every call that leaves the pending list is announced by one `Settled`
answer in the same step, and a `Settled` answer names only a call that was
pending and is gone. Because a sequence number is never reused, a call that
settled can never settle again. A plain call settles with the agent's one
`result` frame as `Response`; a refusal or any other frame is
`Failed(Broken)`. The agent's frames are the transport's
(`spec/agent/access/transport.md`); a connection that closes, or a deadline
the shell enforces, arrives as `lost` and ends a call that is still pending.

```quint
import transport as Tr from "../../agent/access/transport"
type Reaction = Deliver | Settle({ outcome: Outcome }) | Drop
pure def plainReaction(frame: Tr::Frame): Reaction = match frame { | Result(r) => Settle({ outcome: Response({ status: r.status }) }) | _ => Settle({ outcome: Failed({ code: Broken }) }) }
pure def streamReaction(frame: Tr::Frame): Reaction = match frame { | Head(h) => Deliver | Chunk => Deliver | Complete => Settle({ outcome: End }) | _ => Settle({ outcome: Error }) }
pure def watchReaction(frame: Tr::Frame): Reaction =
  if (frame == Tr::AgentEvent) Deliver else if (frame == Tr::Subscribed) Drop else Settle({ outcome: End })
pure def reactionOf(mode: Mode, frame: Tr::Frame): Reaction = match mode { | Plain => plainReaction(frame) | Stream => streamReaction(frame) | Watch(w) => watchReaction(frame) }
pure def lostOutcome(mode: Mode): Outcome = match mode { | Plain => Failed({ code: Broken }) | Stream => Error | Watch(w) => End }
pure val modeValues = Set(Plain, Stream, Watch({ topic: Voice }), Watch({ topic: View }))
pure def isWatch(mode: Mode): bool = match mode { | Watch(w) => true | _ => false }
pure val noEntry: Entry = { seq: -1, id: "", owner: "", mode: Plain, epoch: 0, delivered: 0 }
pure def entryAt(seq: int, s: AgentChannel): Entry = s.pending.select(e => e.seq == seq).nthOr(0, noEntry)
pure def settledOut(e: Entry, ending: Outcome): ChannelOut = Settled({ id: e.id, seq: e.seq, mode: e.mode, outcome: ending })
pure def react(seq: int, s: AgentChannel, r: Reaction): ChannelStep = {
  val e = entryAt(seq, s)
  if (e.seq < 0) { state: s, out: List() }
  else match r {
    | Deliver => emit(List(Delivered({ id: e.id, seq: seq, index: e.delivered + 1 })), { ...s, pending: s.pending.listMap(o => if (o.seq == seq) { ...o, delivered: o.delivered + 1 } else o) })
    | Settle(x) => emit(List(settledOut(e, x.outcome)), { ...s, pending: s.pending.select(o => o.seq != seq) })
    | Drop => { state: s, out: List() }
  }
}
pure def reply(s: AgentChannel, seq: int, frame: Tr::Frame): ChannelStep = react(seq, s, reactionOf(entryAt(seq, s).mode, frame))
pure def lost(s: AgentChannel, seq: int): ChannelStep = react(seq, s, Settle({ outcome: lostOutcome(entryAt(seq, s).mode) }))
pure val seqValues = Set(0, 1, 2, 7)
pure val frameValues = Set(Tr::Result({ status: 200 }), Tr::Refusal, Tr::Head({ code: 200 }), Tr::Chunk, Tr::Complete, Tr::CompleteFailed, Tr::Subscribed, Tr::AgentEvent)
pure def settledSeqs(out: List[ChannelOut]): List[int] = out.foldl(List(), (acc, o) => match o { | Settled(x) => acc.append(x.seq) | _ => acc })
pure def stepEveryLeavingCallSettlesOnce(before: AgentChannel, via: str, after: AgentChannel, out: List[ChannelOut]): bool = {
  val closed = settledSeqs(out)
  before.pending.every(e => after.pending.some(o => o.seq == e.seq) or closed.select(q => q == e.seq).length() == 1) and
    closed.every(q => before.pending.some(e => e.seq == q) and not(after.pending.some(o => o.seq == q)) and closed.select(p => p == q).length() == 1)
}
pure def alwaysPlainCallsDeliverNothing(s: AgentChannel): bool = s.pending.every(e => e.delivered >= 0 and (e.mode == Plain implies e.delivered == 0))
pure def lastOutcome(s: AgentChannel): List[Outcome] = s.recent.foldl(List(), (acc, o) => match o { | Settled(x) => acc.append(x.outcome) | _ => acc })
pure def sometimesPlainResponse(s: AgentChannel): bool = lastOutcome(s).some(o => match o { | Response(r) => true | _ => false })
pure def sometimesRouteRefused(s: AgentChannel): bool = s.launch != NotServing and s.recent.some(o => match o { | Refused(r) => r.code == RouteRefused | _ => false })
pure def sometimesBodyTooLarge(s: AgentChannel): bool = s.recent.some(o => match o { | Refused(r) => r.code == TooLarge | _ => false })
pure def sometimesIdInUse(s: AgentChannel): bool = s.recent.some(o => match o { | Refused(r) => r.code == IdInUse | _ => false })
```

## Story: Stream a reply and stop it

> As a person chatting with my agent, I want its reply to appear as it is
> written and to stop it when I want, so that I never wait for or keep an
> answer I did not want.

### A stream delivers its frames in order and ends once with End, Error or Aborted

The agent's `response` head and each `chunk` are delivered with the next
index of the call. Its `complete` frame ends the stream with `End`; a failed
completion, a refusal, a buffered `result` or a lost connection ends it with
`Error`.

```quint
pure def stepFramesArriveInOrder(before: AgentChannel, via: str, after: AgentChannel, out: List[ChannelOut]): bool =
  out.every(o => match o { | Delivered(d) => entryAt(d.seq, before).delivered + 1 == d.index and entryAt(d.seq, after).delivered == d.index | _ => true })
pure def sometimesStreamDelivering(s: AgentChannel): bool = s.pending.some(e => e.mode == Stream and e.delivered >= 2)
pure val eval_witness_sometimesStreamDelivering = (
  ("loadRoutes", Renderer, List({ prefixes: List(List()), id: Routes::flatParam, routes: List(
    { method: Routes::Post, delivery: Routes::Streamed, path: List(Routes::Literal({ text: "stream" })), query: List(), limit: Routes::AnySize }
  ) })),
  ("open", 1, "token1"),
  ("ask", Renderer, "screen1", "call1", { method: Routes::Post, delivery: Routes::Streamed,
    segments: List({ text: "stream", fits: List() }), query: List(), flaws: List(), body: Routes::JsonObject({ size: 5 }) }, List()),
  ("reply", 0, Tr::Head({ code: 200 })),
  ("reply", 0, Tr::Chunk)
)
pure def sometimesStreamEnded(s: AgentChannel): bool = s.recent.some(o => match o { | Settled(x) => x.mode == Stream and x.outcome == End | _ => false })
pure def sometimesStreamError(s: AgentChannel): bool = lastOutcome(s).includes(Error)
```

### Abort settles only the caller's own pending call, once

`abort` names the caller's id and is allowed only to the owner that made
the call. It ends a request or stream as `Aborted` and closes a
subscription as `End`; no other call changes. The shell then closes that
call's connection.

```quint
pure def ownCall(s: AgentChannel, owner: str, id: str): bool = s.pending.some(e => e.id == id and e.owner == owner)
pure def canAbort(s: AgentChannel, owner: str, id: str): bool = ownCall(s, owner, id)
pure def abort(s: AgentChannel, owner: str, id: str): ChannelStep = {
  val e = s.pending.select(o => o.id == id).nthOr(0, noEntry)
  val ending = if (isWatch(e.mode)) End else Aborted
  emit(List(settledOut(e, ending)), { ...s, pending: s.pending.select(o => o.id != id) })
}
pure def stepAbortTouchesOnlyThatCall(before: AgentChannel, via: str, after: AgentChannel): bool =
  via == "abort" implies (after.pending.length() == before.pending.length() - 1 and after.pending.every(o => before.pending.includes(o)))
pure def sometimesStreamAborted(s: AgentChannel): bool = lastOutcome(s).includes(Aborted)
```

### Retiring the serving launch fails every pending call with Restarted and drops its late frames

The shell forwards the end of a launch with its epoch. Every pending call
and subscription of it settles as `Failed(Restarted)` and its token is
dropped; a frame that arrives afterwards names no pending call and changes
nothing.

```quint
pure def canRetire(s: AgentChannel, epoch: int): bool = s.launch != NotServing and servingEpoch(s) == epoch
pure def retire(s: AgentChannel, epoch: int): ChannelStep =
  emit(s.pending.listMap(e => settledOut(e, Failed({ code: Restarted }))), { ...s, launch: NotServing, rootToken: "", pending: List() })
pure def stepUnansweredFrameChangesNothing(before: AgentChannel, via: str, after: AgentChannel, out: List[ChannelOut]): bool =
  ((via == "reply" or via == "lost") and out.length() == 0) implies after == before
pure def sometimesRestartedCall(s: AgentChannel): bool = s.launch == NotServing and lastOutcome(s).includes(Failed({ code: Restarted }))
```

## Story: Receive the agent's live events for my screen

> As a person using my app, I want my screen to show the agent's voice
> transcript and view updates as they happen, and to stop receiving them
> when I close it or the agent restarts.

### At most one subscription per topic is open, and no more than the agent serves at once

A subscription is an `events_subscribe` call on the serving launch, bound
to its epoch and its owner. The topics are the renderer's voice transcript
and view events and native code's notices. A second one on a topic already
open is `TopicInUse`, and one beyond the agent's feed limit
(`Tr::feedLimit`) is `Busy`, so the agent never refuses a feed the channel
admitted; the other refusals are a call's.

```quint
pure def feeds(s: AgentChannel): int = s.pending.select(e => isWatch(e.mode)).length()
pure def topicOpen(s: AgentChannel, topic: Topic): bool = s.pending.some(e => e.mode == Watch({ topic: topic }))
pure def subscribe(s: AgentChannel, owner: str, id: str, topic: Topic): ChannelStep =
  if (s.launch == NotServing) emit(List(Refused({ id: id, code: NotReady })), s)
  else if (id == "" or idPending(s, id)) emit(List(Refused({ id: id, code: IdInUse })), s)
  else if (topicOpen(s, topic)) emit(List(Refused({ id: id, code: TopicInUse })), s)
  else if (feeds(s) >= Tr::feedLimit) emit(List(Refused({ id: id, code: Busy })), s)
  else admitEntry(id, owner, Watch({ topic: topic }), s)
pure def alwaysOneSubscriptionPerTopic(s: AgentChannel): bool = feeds(s) <= Tr::feedLimit and s.pending.every(e => not(isWatch(e.mode)) or s.pending.select(o => o.mode == e.mode).length() == 1)
pure def sometimesTopicInUse(s: AgentChannel): bool = s.recent.some(o => match o { | Refused(r) => r.code == TopicInUse | _ => false })
pure def sometimesFeedsFull(s: AgentChannel): bool = s.recent.some(o => match o { | Refused(r) => r.code == Busy | _ => false })
```

### A subscription's events arrive in order to its owner, and it ends once with End or Restarted

Each agent `event` frame is delivered with the next index, to the owner
that subscribed; the agent's `subscribed` confirmation only answers the
caller. The agent ending the feed, an abort by its owner or a lost
connection ends it with `End`; a retired launch ends it with
`Failed(Restarted)`. Both go through the rules of a pending call.

```quint
pure def sometimesEventsDelivered(s: AgentChannel): bool = s.pending.some(e => e.mode == Watch({ topic: View }) and e.delivered >= 2)
pure def sometimesSubscriptionRestarted(s: AgentChannel): bool = s.recent.some(o => match o { | Settled(x) => isWatch(x.mode) and x.outcome == Failed({ code: Restarted }) | _ => false })
pure def sometimesSubscriptionClosed(s: AgentChannel): bool = s.recent.some(o => match o { | Settled(x) => x.mode == Watch({ topic: Voice }) and x.outcome == End | _ => false })
```
