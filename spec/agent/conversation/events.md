# Event feeds

A client keeps one or more live event feeds open while its screen is
showing. A feed is one `events_subscribe` exchange over the private socket,
or `GET /api/events?streams=…&clientId=…` as server-sent events on loopback
HTTP; the transport owns the bytes, this machine decides which feed hears
which event and when a feed ends. It lives for one start of the agent.

The subscription input is `{streams: [names], clientId?}`. The first frame
is `{type: "subscribed"}`; each event is
`{type: "event", event: {type: "agent_event", stream, …}}`. The streams are:

| Stream | Events | Published by |
|---|---|---|
| `conversation` | `conversation-updated`, `proactive-message`, `system-notice` | the agent |
| `notification` | a new notice `{id}` | the agent's notification list |
| `view-interact` | an interaction bound to one `clientId` | the agent's view routes |
| `voice-transcript` | speech-start, partial, final, error | a plugin, through the agent's `publishEvent` service |

Delivery is live only: nothing is buffered for replay, and a client that
sees its feed end subscribes again. The per-run sequence, run context and
listener fanout of each runtime event are core `events`;
this machine numbers the events it publishes to feeds in publication order,
and the event payloads stay in the shell.

## Story: Hear about my conversations while my screen is open

> As the owner, I want my open screen to hear about new messages, notices,
> view interactions and live transcripts as they happen, so that it shows
> them without asking again.

### A subscription names its streams once each, and names a client id when it asks for view interactions

An unknown stream name is refused when the input is decoded. The client id
is `[A-Za-z0-9._-]{1,128}`, checked at the boundary.

```quint
type StreamName = ConversationStream | NotificationStream | ViewInteractStream | VoiceTranscriptStream
type FeedEvent = ConversationUpdated | ProactiveMessage | SystemNotice({ code: str }) | NoticeAdded | ViewInteraction({ clientId: str }) | Transcript
type Feed = { id: int, streams: List[StreamName], clientId: str, since: int, lastSeq: int }
type EndReason = PeerClosed | Overflowed | Stopped
type Frame = SubscribedFrame({ feed: int, streams: List[StreamName] }) | EventFrame({ feed: int, seq: int, news: FeedEvent }) | EndFrame({ feed: int, reason: EndReason })
type EventFeed = { feeds: List[Feed], nextFeed: int, published: int, overflowCount: int, noticed: Set[str], stopped: bool }
type FeedStep = { state: EventFeed, out: List[Frame] }
pure val initial: EventFeed = { feeds: List(), nextFeed: 1, published: 0, overflowCount: 0, noticed: Set(), stopped: false }
pure def distinctStreams(streams: List[StreamName]): bool = streams.every(x => streams.select(y => y == x).length() == 1)
pure def validRequest(streams: List[StreamName], clientId: str): bool =
  streams.length() > 0 and distinctStreams(streams) and (streams.includes(ViewInteractStream) implies clientId != "")
pure val streamsValues = Set(List(ConversationStream), List(ViewInteractStream), List(ConversationStream, NotificationStream), List(VoiceTranscriptStream, ConversationStream), List(), List(NotificationStream, NotificationStream))
pure val clientIdValues = Set("", "c1", "c2")
pure def alwaysFeedsAskedValidly(s: EventFeed): bool = s.feeds.every(f => validRequest(f.streams, f.clientId))
```

### At most four feeds are live at once

A fifth subscription is refused while four are live, so a client that
leaks feeds cannot starve the agent.

```quint
pure val maxLiveFeeds = 4
pure def canSubscribe(s: EventFeed, streams: List[StreamName], clientId: str): bool =
  not(s.stopped) and validRequest(streams, clientId) and s.feeds.length() < maxLiveFeeds
pure def alwaysAtMostFourLiveFeeds(s: EventFeed): bool = s.feeds.length() <= maxLiveFeeds
pure def sometimesFourLiveFeeds(s: EventFeed): bool = s.feeds.length() == maxLiveFeeds
```

### Subscribing answers with one subscribed frame and replays nothing

The new feed hears only events published after its subscribed frame.

```quint
pure def subscribe(s: EventFeed, streams: List[StreamName], clientId: str): FeedStep = {
  val feed: Feed = { id: s.nextFeed, streams: streams, clientId: clientId, since: s.published, lastSeq: s.published }
  { state: { ...s, feeds: s.feeds.append(feed), nextFeed: s.nextFeed + 1 }, out: List(SubscribedFrame({ feed: s.nextFeed, streams: streams })) }
}
pure def stepSubscribeAnswersOnceWithoutReplay(before: EventFeed, via: str, after: EventFeed, out: List[Frame]): bool =
  via == "subscribe" implies
    (out.length() == 1 and after.feeds.length() == before.feeds.length() + 1 and
     after.feeds.every(f => f.id == before.nextFeed implies (f.since == before.published and f.lastSeq == before.published and out.includes(SubscribedFrame({ feed: f.id, streams: f.streams })))))
pure def alwaysFeedIdsAreFresh(s: EventFeed): bool =
  s.nextFeed > 0 and s.feeds.every(f => f.id > 0 and f.id < s.nextFeed and s.feeds.select(g => g.id == f.id).length() == 1)
```

### Each published event reaches every live feed that asked for its stream, and no other

A view interaction counts as asked for only by the feeds of its own client
id.

```quint
pure def streamOf(news: FeedEvent): StreamName = match news {
  | ConversationUpdated => ConversationStream | ProactiveMessage => ConversationStream | SystemNotice(_) => ConversationStream
  | NoticeAdded => NotificationStream | ViewInteraction(_) => ViewInteractStream | Transcript => VoiceTranscriptStream }
pure def boundToFeed(f: Feed, news: FeedEvent): bool = match news { | ViewInteraction(v) => v.clientId == f.clientId | _ => true }
pure def wants(f: Feed, news: FeedEvent): bool = f.streams.includes(streamOf(news)) and boundToFeed(f, news)
pure def deliver(news: FeedEvent, s: EventFeed): FeedStep = {
  val seq = s.published + 1
  { state: { ...s, published: seq, feeds: s.feeds.listMap(f => if (wants(f, news)) { ...f, lastSeq: seq } else f) },
    out: s.feeds.select(f => wants(f, news)).listMap(f => EventFrame({ feed: f.id, seq: seq, news: news })) }
}
pure def framesFor(out: List[Frame], feed: int): int = out.select(fr => match fr { | EventFrame(e) => e.feed == feed | _ => false }).length()
pure def lawEveryAskingFeedHearsOnce(s: EventFeed, news: FeedEvent): bool = {
  val r = deliver(news, s)
  s.feeds.every(f => framesFor(r.out, f.id) == (if (wants(f, news)) 1 else 0)) and r.out.length() == s.feeds.select(f => wants(f, news)).length()
}
pure val newsValues = Set(ConversationUpdated, ProactiveMessage, NoticeAdded, ViewInteraction({ clientId: "c1" }), ViewInteraction({ clientId: "c2" }), Transcript, SystemNotice({ code: "E1" }))
pure val sValues = Set(initial,
  { ...initial, nextFeed: 4, published: 2, feeds: List({ id: 1, streams: List(ConversationStream), clientId: "", since: 0, lastSeq: 2 }, { id: 2, streams: List(ViewInteractStream), clientId: "c1", since: 1, lastSeq: 1 }, { id: 3, streams: List(ViewInteractStream, VoiceTranscriptStream), clientId: "c2", since: 2, lastSeq: 2 }) })
pure def sometimesViewInteractionSkipsOtherClient(s: EventFeed): bool =
  s.feeds.some(a => a.streams == List(ViewInteractStream) and a.lastSeq == s.published and a.since < s.published and
    s.feeds.some(b => b.streams == List(ViewInteractStream) and b.clientId != a.clientId and b.since < s.published and b.lastSeq < s.published))
```

### A feed hears events in publication order and only those published after it subscribed

```quint
pure def alwaysFeedOrderWithinPublished(s: EventFeed): bool =
  s.published >= 0 and s.feeds.every(f => f.since >= 0 and f.since <= f.lastSeq and f.lastSeq <= s.published)
pure def stepFeedsAdvanceToNewestEvent(before: EventFeed, after: EventFeed): bool =
  after.feeds.every(f => before.feeds.every(g => g.id == f.id implies (f.since == g.since and (f.lastSeq == g.lastSeq or (f.lastSeq > g.lastSeq and f.lastSeq == after.published)))))
pure def sometimesTranscriptHeard(s: EventFeed): bool = s.feeds.some(f => f.streams.includes(VoiceTranscriptStream) and f.lastSeq > f.since)
```

### Only the voice-transcript stream is open to plugins

Conversation, notification and view events come from the agent itself, and
a view interaction always names its client. A system notice is never
published directly: only a runtime error report raises one (below).

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

### A feed ends when its peer closes it

```quint
pure def hasFeed(s: EventFeed, feed: int): bool = s.feeds.some(f => f.id == feed)
pure def endFeed(feed: int, reason: EndReason, s: EventFeed): FeedStep =
  { state: { ...s, feeds: s.feeds.select(f => f.id != feed), overflowCount: s.overflowCount + (if (reason == Overflowed) 1 else 0) }, out: List(EndFrame({ feed: feed, reason: reason })) }
pure def canCloseFeed(s: EventFeed, feed: int): bool = hasFeed(s, feed)
pure def closeFeed(s: EventFeed, feed: int): FeedStep = endFeed(feed, PeerClosed, s)
pure val feedValues = Set(1, 2, 3, 4, 5)
pure def stepEndedFeedsAreAnnounced(before: EventFeed, after: EventFeed, out: List[Frame]): bool =
  before.feeds.every(f => hasFeed(after, f.id) or out.some(fr => match fr { | EndFrame(e) => e.feed == f.id | _ => false }))
pure def sometimesFeedClosedAfterHearing(s: EventFeed): bool = s.nextFeed > 2 and s.feeds.length() == 0 and s.published > 0
```

### A feed with 256 events waiting unread is closed

The transport counts the frames it has written for a feed that the peer has
not yet read, and reports that count. At 256 the feed ends; below it the
feed stays.

```quint
pure val maxWaiting = 256
pure def canBacklog(s: EventFeed, feed: int, waiting: int): bool = hasFeed(s, feed) and waiting >= 0
pure def backlog(s: EventFeed, feed: int, waiting: int): FeedStep =
  if (waiting >= maxWaiting) endFeed(feed, Overflowed, s) else { state: s, out: List() }
pure val waitingValues = Set(0, 255, 256, 900)
pure def lawBacklogEndsAFeedOnlyAtTheLimit(s: EventFeed, feed: int, waiting: int): bool =
  canBacklog(s, feed, waiting) implies (hasFeed(backlog(s, feed, waiting).state, feed) iff waiting < maxWaiting)
pure def stepOverflowCountsOneEndedFeed(before: EventFeed, after: EventFeed): bool =
  after.overflowCount == before.overflowCount or (after.overflowCount == before.overflowCount + 1 and after.feeds.length() == before.feeds.length() - 1)
pure def sometimesSlowFeedClosed(s: EventFeed): bool = s.overflowCount > 0
```

### Stopping ends every feed and refuses new subscriptions and events

```quint
pure def canStop(s: EventFeed): bool = not(s.stopped)
pure def stop(s: EventFeed): FeedStep =
  { state: { ...s, stopped: true, feeds: List() }, out: s.feeds.listMap(f => EndFrame({ feed: f.id, reason: Stopped })) }
pure def alwaysStoppedHasNoFeeds(s: EventFeed): bool = s.stopped implies s.feeds.length() == 0
pure def stepStoppedStaysQuiet(before: EventFeed, after: EventFeed): bool =
  before.stopped implies (after.stopped and after.published == before.published and after.nextFeed == before.nextFeed)
pure def sometimesStoppedWithLiveFeed(s: EventFeed): bool = s.stopped and s.nextFeed > 1 and s.published > 0
```

## Story: Learn once that something keeps going wrong

> As the owner, I want to be told once when the agent hits a runtime error,
> so that I know without being nagged.

### Each runtime error code raises at most one system notice per start

The first report of a code publishes a `system-notice` on the conversation
stream; later reports of the same code until the next start publish
nothing. A diagnostic-only report or a quiet code (core's internal,
self-healing codes) raises no notice.

```quint
pure def canReportError(s: EventFeed, code: str, quiet: bool): bool = not(s.stopped) and code != ""
pure def raiseNotice(code: str, s: EventFeed): FeedStep = {
  val r = deliver(SystemNotice({ code: code }), s)
  { state: { ...r.state, noticed: s.noticed.union(Set(code)) }, out: r.out }
}
pure def reportError(s: EventFeed, code: str, quiet: bool): FeedStep =
  if (quiet or s.noticed.contains(code)) { state: s, out: List() } else raiseNotice(code, s)
pure val codeValues = Set("E1", "E2", "")
pure def codeOf(news: FeedEvent): str = match news { | SystemNotice(n) => n.code | _ => "" }
pure def noticeCode(fr: Frame): str = match fr { | EventFrame(e) => codeOf(e.news) | _ => "" }
pure def stepNoticeOncePerCode(before: EventFeed, after: EventFeed, out: List[Frame]): bool =
  before.noticed.subseteq(after.noticed) and out.every(fr => noticeCode(fr) == "" or (not(before.noticed.contains(noticeCode(fr))) and after.noticed.contains(noticeCode(fr))))
pure def lawQuietErrorRaisesNothing(s: EventFeed, code: str): bool = {
  val r = reportError(s, code, true)
  r.out.length() == 0 and r.state.published == s.published and r.state.noticed.subseteq(s.noticed)
}
pure def sometimesNoticeHeard(s: EventFeed): bool = s.noticed.size() > 0 and s.feeds.some(f => f.streams.includes(ConversationStream) and f.lastSeq > f.since)
```
