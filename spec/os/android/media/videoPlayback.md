# Android video playback capabilities

The media bridge shows a video in the app's WebView through an opaque
same-origin URL, never a content URI or a file path. The host issues one
capability per playback for a video it has already checked: an app-owned
published video, or a library video the person selected. A capability URL
holds only the WebView origin, the host's playback prefix (`/_<name>/`) and a
fresh random key with an `.mp4` suffix; the model numbers each new key one
higher than the last. Requests outside the prefix keep the ordinary WebView
handler. Header parsing, descriptor opening and the provider queries stay in
the shell; this spec owns the decisions.

## Story: Play a video only for the page I granted

> As the person, I want to play and seek a video the app opened for me, and
> no other page or video to reach it, so that playback never leaks my library.

### A capability is scoped to the WebView origin and its current grant

A request under the prefix must be a subresource of the exact WebView scheme
and authority (else 403), use GET or HEAD (else 405), and name a key the
registry holds when the request arrives (else 404). Only then does the shell
open the source: an owned grant needs an app-owned, published row that is not
trashed where the platform has the column; a library grant rechecks its
selected key and revision before and after opening the descriptor. A failed
check, a missing descriptor or an unreadable size is 404. Each accepted
request opens its own descriptor and closes it or hands it to its stream.

```quint
type VideoAccess = OwnedVideo | LibraryVideo
type PlaybackGrant = { token: int, sourceId: int, access: VideoAccess }
type PlaybackRegistry = { liveGrants: List[PlaybackGrant], newestToken: int }
pure val initial: PlaybackRegistry = { liveGrants: List(), newestToken: 0 }
pure def grantPublished(s: PlaybackRegistry, token: int): bool = s.liveGrants.some(g => g.token == token)

type RequestFrame = SameOriginSubresource | ForeignOrigin | MainFrame
type RequestMethod = VideoGet | VideoHead | OtherMethod
type PlaybackRequest = { key: int, frame: RequestFrame, method: RequestMethod }
type PlaybackGate = Forbidden | MethodRefused | NoGrant | OpenSource
pure def gateRequest(request: PlaybackRequest, s: PlaybackRegistry): PlaybackGate =
  if (request.frame != SameOriginSubresource) Forbidden
  else if (request.method == OtherMethod) MethodRefused
  else if (not(grantPublished(s, request.key))) NoGrant
  else OpenSource
pure val requestValues = Set({ key: 1, frame: SameOriginSubresource, method: VideoGet },
  { key: 1, frame: SameOriginSubresource, method: VideoHead }, { key: 2, frame: SameOriginSubresource, method: VideoGet },
  { key: 1, frame: ForeignOrigin, method: VideoGet }, { key: 1, frame: MainFrame, method: VideoGet },
  { key: 1, frame: SameOriginSubresource, method: OtherMethod })
pure val registryValues = Set(initial, { liveGrants: List({ token: 1, sourceId: 1, access: OwnedVideo }), newestToken: 1 },
  { liveGrants: List({ token: 2, sourceId: 2, access: LibraryVideo }), newestToken: 2 })
```

### The registry keeps at most 32 grants and evicts the oldest

Issuing appends a grant with a new key and, at capacity, evicts the oldest,
marking it revoked under the same lock.

```quint
pure val grantCapacity = 32
pure def canIssuePlaybackGrant(s: PlaybackRegistry, sourceId: int, access: VideoAccess): bool = sourceId > 0
pure def issuePlaybackGrant(s: PlaybackRegistry, sourceId: int, access: VideoAccess): PlaybackRegistry = {
  val kept = if (s.liveGrants.length() >= grantCapacity) s.liveGrants.removeAt(0) else s.liveGrants
  { newestToken: s.newestToken + 1, liveGrants: kept.append({ token: s.newestToken + 1, sourceId: sourceId, access: access }) }
}
pure val sourceIdValues = Set(0, 1, 2)
pure def alwaysPlaybackRegistryBounded(s: PlaybackRegistry): bool = s.liveGrants.length() <= grantCapacity
pure def alwaysGrantIsWithinIssueHistory(s: PlaybackRegistry): bool =
  s.newestToken >= 0 and s.liveGrants.every(g => g.token > 0 and g.token <= s.newestToken and g.sourceId > 0)
pure def sometimesOwnedAndLibraryGrantsLive(s: PlaybackRegistry): bool =
  s.liveGrants.some(g => g.access == OwnedVideo) and s.liveGrants.some(g => g.access == LibraryVideo)
```

### A revoked grant never serves again, even to a stream it already opened

Revoking a source removes every grant for it; pause and teardown clear the
registry. A grant that leaves the registry is revoked for good, and an open
stream checks its grant at the start of every read, skip and availability
call; a library stream also needs the device and the profile unlocked. A call
already admitted may finish while revocation happens.

```quint
pure def canRevokePlaybackSource(s: PlaybackRegistry, sourceId: int): bool = s.liveGrants.some(g => g.sourceId == sourceId)
pure def revokePlaybackSource(s: PlaybackRegistry, sourceId: int): PlaybackRegistry =
  { ...s, liveGrants: s.liveGrants.select(g => g.sourceId != sourceId) }
pure def canClearPlayback(s: PlaybackRegistry): bool = s.liveGrants.length() > 0
pure def clearPlayback(s: PlaybackRegistry): PlaybackRegistry = { ...s, liveGrants: List() }
pure def streamMayRead(token: int, unlocked: bool, s: PlaybackRegistry): bool =
  s.liveGrants.some(g => g.token == token and (g.access == OwnedVideo or unlocked))
pure def lawRevocationOnlyNarrowsAccess(request: PlaybackRequest, registry: PlaybackRegistry, sourceId: int): bool =
  gateRequest(request, revokePlaybackSource(registry, sourceId)) == OpenSource implies gateRequest(request, registry) == OpenSource
pure def stepRetiredGrantCannotReturn(before: PlaybackRegistry, after: PlaybackRegistry): bool =
  after.newestToken >= before.newestToken and
    after.liveGrants.every(g => g.token > before.newestToken or grantPublished(before, g.token))
pure def sometimesOneGrantOutlivesAnother(s: PlaybackRegistry): bool =
  s.newestToken >= 2 and s.liveGrants.length() == 1
pure def sometimesPlaybackCleared(s: PlaybackRegistry): bool = s.newestToken > 0 and s.liveGrants.length() == 0
```

## Story: Seek within the granted video

> As the person, I want to seek anywhere in a granted video, so that long
> videos start fast and resume where I left them.

### A supported byte range advertises its bounds and the loader seeks once

Ranges are inclusive. With no Range header the reply is 200 with the whole
video. One closed (`bytes=a-b`), open (`bytes=a-`) or suffix (`bytes=-n`)
range is served as 206 with `Content-Range: bytes first-last/total`; the end
is clamped to the last byte and a suffix longer than the video takes all of
it. A zero suffix, a start at or past the end, an inverted range, several
ranges, or a header that does not parse (an empty field pair or a number that
overflows included) is 416. An unreadable or empty source is 404. A served
reply sets `no-store`, `Accept-Ranges: bytes` and `nosniff`; Chromium's
loader supplies `Content-Length`. HEAD has an empty body. For GET the stream
starts at offset zero with the descriptor's whole available length, because
the WebView loader skips to the first byte itself, exactly once; the stream
ends after the last byte.

```quint
type RangeHeader = NoRange | ClosedRange | OpenRange | SuffixRange | UnsupportedRange
type RangeRequest = { header: RangeHeader, fromByte: int, toByte: int, tail: int }
type RangeOutcome = WholeVideo | PartialVideo | Unsatisfiable | VideoUnavailable
type ByteReply = { kind: RangeOutcome, firstByte: int, lastByte: int }
pure def refusedRange(refusal: RangeOutcome): ByteReply = { kind: refusal, firstByte: 0, lastByte: 0 }
pure def servedRange(total: int, asked: RangeRequest): ByteReply = {
  val firstByte = if (asked.header == SuffixRange) (if (asked.tail < total) total - asked.tail else 0)
    else if (asked.header == NoRange) 0 else asked.fromByte
  val lastByte = if (asked.header == ClosedRange and asked.toByte < total - 1) asked.toByte else total - 1
  if (total <= 0) refusedRange(VideoUnavailable)
  else if (asked.header == UnsupportedRange or (asked.header == SuffixRange and asked.tail <= 0)) refusedRange(Unsatisfiable)
  else if (firstByte < 0 or firstByte >= total or lastByte < firstByte) refusedRange(Unsatisfiable)
  else { kind: if (asked.header == NoRange) WholeVideo else PartialVideo, firstByte: firstByte, lastByte: lastByte }
}
pure def replyStatus(reply: ByteReply): int =
  if (reply.kind == WholeVideo) 200 else if (reply.kind == PartialVideo) 206
  else if (reply.kind == Unsatisfiable) 416 else 404
pure def streamLimit(reply: ByteReply, method: RequestMethod): int =
  if (method == VideoGet and (reply.kind == WholeVideo or reply.kind == PartialVideo)) reply.lastByte + 1 else 0
pure def lawServedRangeFitsSource(total: int, asked: RangeRequest): bool = {
  val reply = servedRange(total, asked)
  (reply.kind == WholeVideo or reply.kind == PartialVideo) implies
    (0 <= reply.firstByte and reply.firstByte <= reply.lastByte and reply.lastByte < total)
}
pure def lawLoaderSkipLandsInsideStream(total: int, asked: RangeRequest): bool = {
  val reply = servedRange(total, asked)
  val limit = streamLimit(reply, VideoGet)
  limit > 0 implies (reply.firstByte < limit and limit <= total)
}
pure val noRange: RangeRequest = { header: NoRange, fromByte: 0, toByte: 0, tail: 0 }
pure val askedValues = Set(noRange, { ...noRange, header: ClosedRange, fromByte: 8, toByte: 23 },
  { ...noRange, header: ClosedRange, fromByte: 8, toByte: 500 }, { ...noRange, header: ClosedRange, fromByte: 24, toByte: 23 },
  { ...noRange, header: OpenRange, fromByte: 8 }, { ...noRange, header: OpenRange, fromByte: 128 },
  { ...noRange, header: SuffixRange, tail: 8 }, { ...noRange, header: SuffixRange, tail: 500 },
  { ...noRange, header: SuffixRange }, { ...noRange, header: UnsupportedRange })
pure val totalValues = Set(0, 1, 8, 24, 128)
```
