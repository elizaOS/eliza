# Android video playback capabilities

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` installs
`/_alpha_owned_video/` through `AlphaPhotosPlugin` and
`AlphaMediaConfig`. At Eliza `c518127a025ab173874af9c7d304f26b25213b0d`,
`PhotosPlugin.read` issues an opaque same-origin URL through
`plugins/plugin-native-media/android/src/main/java/ai/eliza/plugins/media/OwnedVideoPlayback.java`.
[Photos permission epochs](./mobilePhotos.md) own permitted item
admission. [Video edit review](./alpha/videoEditReview.md) consumes the
stream. The capability owns one source URI and one request path.

## Story: Play or seek the exact video that Photos admitted

### A capability is scoped to the WebView origin and its current grant

Every issue creates a fresh UUID with an MP4 suffix. Keep at most
32 grants in issuance order. Eviction marks the oldest grant revoked
before removal. Revocation by URI marks and removes every associated
grant. Pause and teardown clear the registry and retire existing
grant objects. The visible URL carries neither a provider URI nor a
filesystem path. Paths outside the configured prefix use the
ordinary WebView handler.

Inside the prefix accept only a subresource of the exact scheme
and authority. A foreign origin or main-frame request returns 403.
Other methods than GET and HEAD return 405. Missing grant, missing
descriptor, unreadable size or failed source admission returns 404.
Owned grants verify an app-owned, published row and exclude trash
where the platform supports the column. A permitted grant rechecks
the exact permitted key and captured revision before and after
opening the descriptor, with the issued trash choice. Grant registry
membership is sampled for the incoming request. An already-open
stream checks its retired grant on every read, skip and availability
call. Permitted streams also check device and profile lock state.
Each accepted HTTP request has its own descriptor and closes it
or transfers it to that stream.

```quint
type RequestMethod = VideoGet | VideoHead | OtherVideoMethod
type PlaybackRequest = { exactOrigin: bool, mainFrame: bool, method: RequestMethod, grantFound: bool,
  sourceAdmitted: bool, descriptorReadable: bool }
type PlaybackAdmission = VideoForbidden | VideoMethodRefused | VideoMissing | VideoAdmitted
pure def playbackAdmission(request: PlaybackRequest): PlaybackAdmission =
  if (not(request.exactOrigin) or request.mainFrame) VideoForbidden
  else if (request.method == OtherVideoMethod) VideoMethodRefused
  else if (not(request.grantFound and request.sourceAdmitted and request.descriptorReadable)) VideoMissing
  else VideoAdmitted
pure def playbackStreamAllowed(revoked: bool, permittedLibrary: bool, unlocked: bool): bool =
  not(revoked) and (not(permittedLibrary) or unlocked)
pure def lawRevokedGrantCannotServeBytes(permittedLibrary: bool, unlocked: bool): bool =
  not(playbackStreamAllowed(true,permittedLibrary,unlocked))
pure def lawForeignFrameCannotOpenVideo(request: PlaybackRequest): bool =
  (not(request.exactOrigin) or request.mainFrame) implies playbackAdmission(request) == VideoForbidden
pure val playbackRequest: PlaybackRequest = { exactOrigin: true, mainFrame: false, method: VideoGet, grantFound: true,
  sourceAdmitted: true, descriptorReadable: true }
pure val requestValues = Set(playbackRequest, { ...playbackRequest, exactOrigin: false },
  { ...playbackRequest, mainFrame: true }, { ...playbackRequest, method: VideoHead },
  { ...playbackRequest, method: OtherVideoMethod }, { ...playbackRequest, grantFound: false },
  { ...playbackRequest, sourceAdmitted: false }, { ...playbackRequest, descriptorReadable: false })

type PlaybackGrant = { token: int, sourceId: int }
type PlaybackRegistry = { liveGrants: List[PlaybackGrant], newestToken: int }
pure val initial: PlaybackRegistry = { liveGrants: List(), newestToken: 0 }
pure def grantPublished(s: PlaybackRegistry, token: int): bool = s.liveGrants.some(g => g.token == token)
pure def canIssuePlaybackGrant(s: PlaybackRegistry, issued: PlaybackGrant): bool =
  issued.sourceId > 0 and issued.token > s.newestToken
pure def issuePlaybackGrant(s: PlaybackRegistry, issued: PlaybackGrant): PlaybackRegistry =
  { newestToken: issued.token,
    liveGrants: (if (s.liveGrants.length() == 32) s.liveGrants.removeAt(0) else s.liveGrants).append(issued) }
pure def canRevokePlaybackSource(s: PlaybackRegistry, sourceId: int): bool = s.liveGrants.some(g => g.sourceId == sourceId)
pure def revokePlaybackSource(s: PlaybackRegistry, sourceId: int): PlaybackRegistry =
  { ...s, liveGrants: s.liveGrants.select(g => g.sourceId != sourceId) }
pure def canClearPlayback(s: PlaybackRegistry): bool = s.liveGrants.length() > 0
pure def clearPlayback(s: PlaybackRegistry): PlaybackRegistry = { ...s, liveGrants: List() }
pure def alwaysPlaybackRegistryBounded(s: PlaybackRegistry): bool = s.liveGrants.length() <= 32
pure def alwaysGrantIsWithinIssueHistory(s: PlaybackRegistry): bool =
  s.newestToken >= 0 and s.liveGrants.every(g => g.token > 0 and g.token <= s.newestToken)
pure def stepRetiredGrantCannotReturn(before: PlaybackRegistry, after: PlaybackRegistry): bool =
  after.liveGrants.every(g => g.token > before.newestToken or grantPublished(before,g.token))
pure val issuedValues = Set({ token: 1, sourceId: 1 }, { token: 2, sourceId: 1 }, { token: 3, sourceId: 2 }, { token: 0, sourceId: 1 })
pure def sometimesTwoPlaybackGrants(s: PlaybackRegistry): bool = s.liveGrants.length() == 2
pure def sometimesPlaybackCleared(s: PlaybackRegistry): bool = s.newestToken > 0 and s.liveGrants.length() == 0
```

### A supported byte range advertises its bounds and seeks once

A nonempty readable object uses inclusive ranges. With no Range
header serve status 200 and the entire object. One numeric closed,
open-ended or suffix range is supported. Clamp the end to the
last byte and a large suffix to the whole file. A zero suffix, a
start past the object, an inverted range, an unsupported header
shape or multiple ranges returns 416. A numeric conversion error
after parsing the header shape, including overflow or both digit
fields empty, follows the producer's 404 exception path.

A valid range returns 206 with Content-Range. The successful
response sets no-store, Accept-Ranges bytes and nosniff. HEAD has an
empty body. For GET leave the descriptor at offset zero and expose
its original available length. The Android loader applies the
initial range skip once. Bound the stream at end plus one despite
advertising the original available length. Chromium supplies the
Content-Length header. The model receives header decoding and
descriptor results as port facts. Long provider lengths beyond
safe JavaScript integers require validated range normalization
at the native port.

```quint
type PlaybackRange = WholeVideo | ClosedVideoRange | OpenVideoRange | SuffixVideoRange | UnsupportedVideoRange | UnreadableVideoRange
type VideoRangeInput = { kind: PlaybackRange, offset: int, requestedEnd: int, tailBytes: int }
type VideoRangeReply = { status: int, firstByte: int, lastByte: int, hasContentRange: bool }
pure def missingVideoRange(status: int): VideoRangeReply = { status: status, firstByte: 0, lastByte: 0, hasContentRange: false }
pure def videoRange(total: int, bounds: VideoRangeInput): VideoRangeReply = {
  val firstByte = if (bounds.kind == SuffixVideoRange and bounds.tailBytes > 0 and bounds.tailBytes < total) total - bounds.tailBytes
    else if (bounds.kind == SuffixVideoRange) 0 else bounds.offset
  val lastByte = if (total <= 0) 0 else if (bounds.kind == ClosedVideoRange and bounds.requestedEnd < total) bounds.requestedEnd else total - 1
  if (total <= 0 or bounds.kind == UnreadableVideoRange) missingVideoRange(404)
  else if (bounds.kind == UnsupportedVideoRange) missingVideoRange(416)
  else if (bounds.kind == WholeVideo) { status: 200, firstByte: 0, lastByte: lastByte, hasContentRange: false }
  else if (firstByte < 0 or firstByte >= total or lastByte < firstByte or (bounds.kind == SuffixVideoRange and bounds.tailBytes <= 0))
    missingVideoRange(416)
  else { status: 206, firstByte: firstByte, lastByte: lastByte, hasContentRange: true }
}
pure def lawSuccessfulVideoRangeFitsSource(total: int, bounds: VideoRangeInput): bool = {
  val response = videoRange(total,bounds)
  response.status == 200 or response.status == 206 implies response.firstByte >= 0 and response.lastByte >= response.firstByte and response.lastByte < total
}
pure def initialStreamLimit(total: int, bounds: VideoRangeInput, method: RequestMethod): int = {
  val response = videoRange(total,bounds)
  if (method == VideoGet and (response.status == 200 or response.status == 206)) response.lastByte + 1 else 0
}
pure def lawVideoHeadHasEmptyStream(total: int, bounds: VideoRangeInput): bool =
  initialStreamLimit(total,bounds,VideoHead) == 0
pure val plainRange: VideoRangeInput = { kind: WholeVideo, offset: 0, requestedEnd: 0, tailBytes: 0 }
pure val boundsValues = Set(plainRange, { ...plainRange, kind: ClosedVideoRange, offset: 8, requestedEnd: 23 },
  { ...plainRange, kind: ClosedVideoRange, offset: 24, requestedEnd: 23 },
  { ...plainRange, kind: OpenVideoRange, offset: 8 }, { ...plainRange, kind: SuffixVideoRange, tailBytes: 8 },
  { ...plainRange, kind: SuffixVideoRange, tailBytes: 128 }, { ...plainRange, kind: SuffixVideoRange },
  { ...plainRange, kind: UnsupportedVideoRange }, { ...plainRange, kind: UnreadableVideoRange })
pure val totalValues = Set(0,1,8,24,128)
```

Alpha's pinned `VideoInstrumentedTest.recordsDurableVideoAndPrototypeControlsDriveRealPlayback`
tests the installed WebView, including an actual Range fetch and
playback. Files, media decoding, provider permissions and Chromium's
range loader are external to the model.
