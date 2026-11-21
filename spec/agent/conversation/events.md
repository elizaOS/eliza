# Event feeds

A client keeps live event feeds open while its screen is showing. A feed is
one subscription over the private socket or loopback server-sent events;
the transport (`access/transport.md`) owns the frames, admits only the
Root caller (`access/auth.md`), bounds how many feeds are open
and answers a refused subscription with one refusal, which changes nothing
here. This machine decides which feed hears which event and when a feed
ends. It lives for one start of the agent.

Each event goes out as `{type: "agent_event", stream, runId, seq, payload}`;
`runId` and `seq` are core `events`' run and per-run
sequence. `published` below is only the order in which this machine hands
events to feeds; it never reaches the wire. The streams are:

| Stream | Events | Published by |
|---|---|---|
| `conversation` | `conversation-updated`, `proactive-message`, `system-notice` | the agent |
| `notification` | an acknowledged inbox change `{id}` | core notifications' fan-out |
| `view-interact` | `{clientId, frame}` for one client | the agent's view routes |
| `voice-transcript` | speech-start, partial, final, error | a plugin, through the agent's `publishEvent` service |

Delivery is live only: nothing is buffered for replay, and a client that
sees its feed end subscribes again.

## Story: Hear about my conversations while my screen is open

> As the owner, I want my open screen to hear about new messages, notices,
> view interactions and live transcripts as they happen, so that it shows
> them without asking again.

### A feed asks either for view interactions of one client or for at least one other stream

A request naming only `view-interact` with a client id
(`[A-Za-z0-9._-]{1,128}`, checked at the boundary) is a renderer feed. Any
other request names one or more of the remaining streams; the boundary
drops repeated names, as develop does. An empty list, an unknown name, or
`view-interact` beside another stream is refused: develop accepted the
last and never fed it.

```quint
type StreamName = ConversationStream | NotificationStream | ViewInteractStream | VoiceTranscriptStream
type NoticeKind = ModelUnavailable | RuntimeError
type FeedEvent = ConversationUpdated | ProactiveMessage | SystemNotice({ kind: NoticeKind }) | InboxChanged | ViewInteraction({ clientId: str }) | Transcript
type FeedKind = RendererFeed({ clientId: str }) | StreamFeed({ streams: Set[StreamName] })
type Feed = { id: int, kind: FeedKind, since: int, lastSeq: int }
type EndReason = PeerClosed | Overflowed | FrameTooLarge | Stopped
type LastEnd = NoneEnded | EndedBy({ reason: EndReason })
type Strike = { code: str, count: int }
type LastNotice = NoNotice | Noticed({ kind: NoticeKind, heardBy: int })
type Frame = Subscribed({ feed: int, streams: Set[StreamName] }) | Delivered({ feeds: Set[int], seq: int, news: FeedEvent }) | Ended({ feeds: Set[int], reason: EndReason }) | StoreNotice({ kind: NoticeKind })
type EventFeed = { feeds: List[Feed], nextFeed: int, published: int, lastEnded: LastEnd, strikes: List[Strike], lastNotice: LastNotice, stopped: bool }
type FeedStep = { state: EventFeed, out: List[Frame] }
pure val initial: EventFeed = { feeds: List(), nextFeed: 1, published: 0, lastEnded: NoneEnded, strikes: List(), lastNotice: NoNotice, stopped: false }
pure def validRequest(streams: Set[StreamName], clientId: str): bool =
  streams.size() > 0 and (streams.contains(ViewInteractStream) implies (streams.subseteq(Set(ViewInteractStream)) and clientId != ""))
pure def kindOf(streams: Set[StreamName], clientId: str): FeedKind =
  if (streams.contains(ViewInteractStream)) RendererFeed({ clientId: clientId }) else StreamFeed({ streams: streams })
pure def kindValid(k: FeedKind): bool = match k {
  | RendererFeed(r) => r.clientId != ""
  | StreamFeed(x) => x.streams.size() > 0 and not(x.streams.contains(ViewInteractStream)) }
pure def isRenderer(k: FeedKind): bool = match k { | RendererFeed(_) => true | _ => false }
pure def rendererOf(k: FeedKind, clientId: str): bool = match k { | RendererFeed(r) => r.clientId == clientId | _ => false }
pure val streamsValues = Set(Set(ConversationStream), Set(ViewInteractStream), Set(ConversationStream, NotificationStream), Set(VoiceTranscriptStream), Set(ViewInteractStream, ConversationStream), Set())
pure val clientIdValues = Set("", "c1", "c2")
pure def alwaysFeedsAskedValidly(s: EventFeed): bool = s.feeds.every(f => kindValid(f.kind))
pure def canSubscribe(s: EventFeed, streams: Set[StreamName], clientId: str): bool = not(s.stopped) and validRequest(streams, clientId)
pure def sometimesRendererAndStreamFeeds(s: EventFeed): bool =
  s.feeds.some(f => isRenderer(f.kind)) and s.feeds.some(f => not(isRenderer(f.kind)))
```

### Subscribing answers with one subscribed frame and replays nothing

The new feed takes a fresh id and hears only events published after its
subscribed frame.

```quint
pure def subscribe(s: EventFeed, streams: Set[StreamName], clientId: str): FeedStep = {
  val feed: Feed = { id: s.nextFeed, kind: kindOf(streams, clientId), since: s.published, lastSeq: s.published }
  { state: { ...s, feeds: s.feeds.append(feed), nextFeed: s.nextFeed + 1 }, out: List(Subscribed({ feed: s.nextFeed, streams: streams })) }
}
pure def alwaysFeedIdsAreFresh(s: EventFeed): bool =
  s.nextFeed > 0 and s.feeds.every(f => f.id > 0 and f.id < s.nextFeed and s.feeds.select(g => g.id == f.id).length() == 1)
pure def stepSubscribeAnswersOnceWithoutReplay(before: EventFeed, via: str, after: EventFeed, out: List[Frame]): bool =
  via == "subscribe" implies out.length() == 1
```

### Each published event reaches exactly the live feeds that want it

A stream feed wants the events of its streams; a renderer feed wants only
view interactions for its own client id. The hearers form a set, so no
feed hears an event twice, and an event nobody wants writes no frame.

```quint
pure def streamOf(news: FeedEvent): StreamName = match news {
  | ConversationUpdated => ConversationStream | ProactiveMessage => ConversationStream | SystemNotice(_) => ConversationStream
  | InboxChanged => NotificationStream | ViewInteraction(_) => ViewInteractStream | Transcript => VoiceTranscriptStream }
pure def interactionFor(news: FeedEvent, clientId: str): bool = match news { | ViewInteraction(v) => v.clientId == clientId | _ => false }
pure def kindWants(k: FeedKind, news: FeedEvent): bool = match k {
  | RendererFeed(r) => interactionFor(news, r.clientId)
  | StreamFeed(x) => x.streams.contains(streamOf(news)) }
pure def wants(f: Feed, news: FeedEvent): bool = kindWants(f.kind, news)
pure def idsOf(feeds: List[Feed]): Set[int] = feeds.foldl(Set(), (acc, f) => acc.union(Set(f.id)))
pure def hearersOf(s: EventFeed, news: FeedEvent): Set[int] = idsOf(s.feeds.select(f => wants(f, news)))
pure def deliver(news: FeedEvent, s: EventFeed): FeedStep = {
  val seq = s.published + 1
  val hearers = hearersOf(s, news)
  { state: { ...s, published: seq, feeds: s.feeds.listMap(f => if (wants(f, news)) { ...f, lastSeq: seq } else f) },
    out: if (hearers.size() > 0) List(Delivered({ feeds: hearers, seq: seq, news: news })) else List() }
}
pure val newsValues = Set(ConversationUpdated, ProactiveMessage, InboxChanged, ViewInteraction({ clientId: "c1" }), ViewInteraction({ clientId: "c2" }), ViewInteraction({ clientId: "" }), Transcript, SystemNotice({ kind: RuntimeError }))
pure def stepDeliveryReachesExactlyTheAskers(before: EventFeed, after: EventFeed, out: List[Frame]): bool =
  out.every(fr => match fr {
    | Delivered(d) => d.feeds.size() > 0 and d.feeds.forall(id => before.feeds.some(f => f.id == id)) and before.feeds.every(f => d.feeds.contains(f.id) == wants(f, d.news))
    | _ => true })
pure def sometimesViewInteractionSkipsOtherClient(s: EventFeed): bool =
  s.feeds.some(a => rendererOf(a.kind, "c1") and a.lastSeq == s.published and a.since < s.published and
    s.feeds.some(b => rendererOf(b.kind, "c2") and b.since < s.published and b.lastSeq < s.published))
pure def sometimesTranscriptHeard(s: EventFeed): bool =
  s.feeds.some(f => wants(f, Transcript) and f.lastSeq > f.since)
```

### A feed hears events in publication order and only those published after it subscribed

```quint
pure def alwaysFeedOrderWithinPublished(s: EventFeed): bool =
  s.published >= 0 and s.feeds.every(f => f.since >= 0 and f.since <= f.lastSeq and f.lastSeq <= s.published)
pure def stepPublicationOrderGrows(before: EventFeed, after: EventFeed): bool = after.published >= before.published
```

### Only the voice-transcript stream is open to plugins

Conversation, notification and view events come from the agent itself, and
a view interaction always names its client. A system notice is never
published directly: only a repeated runtime error raises one (below).

```quint
type Source = AgentSource | PluginSource
pure def isSystemNotice(news: FeedEvent): bool = match news { | SystemNotice(_) => true | _ => false }
pure def namesClient(news: FeedEvent): bool = match news { | ViewInteraction(v) => v.clientId != "" | _ => true }
pure def canPublish(s: EventFeed, source: Source, news: FeedEvent): bool =
  not(s.stopped) and not(isSystemNotice(news)) and namesClient(news) and (source == PluginSource implies streamOf(news) == VoiceTranscriptStream)
pure def publish(s: EventFeed, source: Source, news: FeedEvent): FeedStep = deliver(news, s)
```

## Story: Stop hearing when I leave

> As the owner, I want a feed to end when my screen closes it, when it falls
> too far behind or when the agent stops, so that a stalled screen never
> holds the agent's memory.

### Every ended feed is announced with its reason

A feed ends when its peer closes it, when it falls behind (below), or when
the agent stops.

```quint
pure def endFeed(feed: int, reason: EndReason, s: EventFeed): FeedStep =
  { state: { ...s, feeds: s.feeds.select(f => f.id != feed), lastEnded: EndedBy({ reason: reason }) }, out: List(Ended({ feeds: Set(feed), reason: reason })) }
pure def isLive(s: EventFeed, feed: int): bool = s.feeds.some(f => f.id == feed)
pure def canCloseFeed(s: EventFeed, feed: int): bool = isLive(s, feed)
pure def closeFeed(s: EventFeed, feed: int): FeedStep = endFeed(feed, PeerClosed, s)
pure val feedValues = Set(1, 2, 3)
pure def endsFeed(fr: Frame, feed: int): bool = match fr { | Ended(e) => e.feeds.contains(feed) | _ => false }
pure def stepEndedFeedsAreAnnounced(before: EventFeed, after: EventFeed, out: List[Frame]): bool =
  before.feeds.every(f => isLive(after, f.id) or out.some(fr => endsFeed(fr, f.id)))
pure def sometimesAllFeedsClosedByPeers(s: EventFeed): bool = {
  val ending = s.lastEnded
  not(s.stopped) and s.nextFeed > 1 and s.feeds.length() == 0 and match ending {
    | EndedBy(e) => e.reason == PeerClosed | _ => false }
}
```

### A feed whose next frame passes 256 KiB, or whose unread bytes would pass 1 MiB, is closed

Before writing a frame the transport reports the frame's size and the bytes
already written to the feed and not yet read. A frame over 256 KiB (or one
that cannot be serialized, reported as oversize) ends the feed; otherwise a
frame that would bring the unread bytes over 1 MiB ends it as overflowed;
otherwise the frame is written and the feed stays.

```quint
pure val maxFrameBytes = 262144
pure val maxQueuedBytes = 1048576
pure def canBacklog(s: EventFeed, feed: int, queuedBytes: int, frameBytes: int): bool = isLive(s, feed) and queuedBytes >= 0 and frameBytes > 0
pure def backlog(s: EventFeed, feed: int, queuedBytes: int, frameBytes: int): FeedStep =
  if (frameBytes > maxFrameBytes) endFeed(feed, FrameTooLarge, s)
  else if (queuedBytes + frameBytes > maxQueuedBytes) endFeed(feed, Overflowed, s)
  else { state: s, out: List() }
pure val queuedBytesValues = Set(0, 1048000)
pure val frameBytesValues = Set(100, 262144, 262145)
pure def sometimesSlowFeedClosed(s: EventFeed): bool = s.lastEnded == EndedBy({ reason: Overflowed })
pure def sometimesOversizeFrameEndsFeed(s: EventFeed): bool = s.lastEnded == EndedBy({ reason: FrameTooLarge })
```

### Stopping ends every feed, and nothing is subscribed, published or reported afterwards

```quint
pure def canStop(s: EventFeed): bool = not(s.stopped)
pure def stop(s: EventFeed): FeedStep = {
  val ids = idsOf(s.feeds)
  { state: { ...s, stopped: true, feeds: List(), lastEnded: if (ids.size() > 0) EndedBy({ reason: Stopped }) else s.lastEnded },
    out: if (ids.size() > 0) List(Ended({ feeds: ids, reason: Stopped })) else List() }
}
pure def alwaysStoppedHasNoFeeds(s: EventFeed): bool = s.stopped implies s.feeds.length() == 0
pure def sometimesStoppedAfterPublishing(s: EventFeed): bool = s.stopped and s.lastEnded == EndedBy({ reason: Stopped }) and s.published > 0
```

## Story: Learn when something keeps going wrong

> As the owner, I want to be told when the same runtime error keeps
> happening, and not about every passing one, so that I know without being
> nagged.

### A runtime error code raises one stored notice when it is reported three times within ten minutes

Each report of a code counts one strike; a strike leaves the count when it
is ten minutes old (the shell's clock calls `expireStrike`). The report that
brings a code to three strikes clears them and raises a notice: one
owner-chat message with `systemNotice: kind`, stored through
`conversation/conversations.md` whether or not a feed is live, and
announced as `system-notice` on the conversation stream. Its text is core
`systemNoticeText(kind)`. The kind is `model-unavailable` for
`LOCAL_INFERENCE_UNAVAILABLE` with cause (the report's `context.reason`)
`backend_unavailable` and for `NO_MODEL_PROVIDER_CONFIGURED` unless its
cause is `capability-disabled`;
otherwise `runtime-error`. A diagnostic-only report and a quiet code
(core's internal, self-healing codes) are folded by the shell into `quiet`
and count nothing. Develop's threshold and window settings are dropped
(plan D22 keeps this one rule).

```quint
pure val escalationThreshold = 3
pure def noticeKind(code: str, cause: str): NoticeKind =
  if ((code == "LOCAL_INFERENCE_UNAVAILABLE" and cause == "backend_unavailable") or (code == "NO_MODEL_PROVIDER_CONFIGURED" and cause != "capability-disabled")) ModelUnavailable else RuntimeError
pure def strikeCount(s: EventFeed, code: str): int = s.strikes.select(x => x.code == code).nthOr(0, { code: code, count: 0 }).count
pure def withStrikes(code: str, n: int, s: EventFeed): EventFeed =
  { ...s, strikes: if (n > 0) s.strikes.select(x => x.code != code).append({ code: code, count: n }) else s.strikes.select(x => x.code != code) }
pure def raiseNotice(kind: NoticeKind, s: EventFeed): FeedStep = {
  val r = deliver(SystemNotice({ kind: kind }), s)
  { state: { ...r.state, lastNotice: Noticed({ kind: kind, heardBy: hearersOf(s, SystemNotice({ kind: kind })).size() }) }, out: List(StoreNotice({ kind: kind })).concat(r.out) }
}
pure def canReportError(s: EventFeed, code: str, cause: str, quiet: bool): bool = not(s.stopped) and code != ""
pure def reportError(s: EventFeed, code: str, cause: str, quiet: bool): FeedStep = {
  val n = strikeCount(s, code) + 1
  if (quiet) { state: s, out: List() }
  else if (n >= escalationThreshold) raiseNotice(noticeKind(code, cause), withStrikes(code, 0, s))
  else { state: withStrikes(code, n, s), out: List() }
}
pure def canExpireStrike(s: EventFeed, code: str): bool = strikeCount(s, code) > 0
pure def expireStrike(s: EventFeed, code: str): FeedStep = { state: withStrikes(code, strikeCount(s, code) - 1, s), out: List() }
pure val codeValues = Set("LOCAL_INFERENCE_UNAVAILABLE", "NO_MODEL_PROVIDER_CONFIGURED", "E1", "")
pure val causeValues = Set("backend_unavailable", "capability-disabled", "")
pure def alwaysStrikesBelowThreshold(s: EventFeed): bool =
  s.strikes.every(x => x.count > 0 and x.count < escalationThreshold and s.strikes.select(y => y.code == x.code).length() == 1)
pure def isStore(fr: Frame): bool = match fr { | StoreNotice(_) => true | _ => false }
pure def announcesNotice(fr: Frame): bool = match fr { | Delivered(d) => isSystemNotice(d.news) | _ => false }
pure def stepNoticeOnlyAtThreshold(before: EventFeed, after: EventFeed, out: List[Frame]): bool =
  out.select(fr => isStore(fr)).length() <= 1 and
  (out.some(fr => announcesNotice(fr)) implies out.some(fr => isStore(fr))) and
  (out.some(fr => isStore(fr)) implies before.strikes.some(x => x.count == escalationThreshold - 1 and strikeCount(after, x.code) == 0))
pure def heardBy(n: LastNotice): int = match n { | Noticed(x) => x.heardBy | _ => -1 }
pure def noticedKind(n: LastNotice, kind: NoticeKind): bool = match n { | Noticed(x) => x.kind == kind | _ => false }
pure def sometimesNoticeStoredUnheard(s: EventFeed): bool = heardBy(s.lastNotice) == 0
pure def sometimesModelUnavailableHeard(s: EventFeed): bool = noticedKind(s.lastNotice, ModelUnavailable) and heardBy(s.lastNotice) > 0
```
