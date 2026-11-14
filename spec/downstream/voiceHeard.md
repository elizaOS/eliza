# Voice interruption receipt custody

AlphaPhone projects `packages/voice/src/voice-turn-routes.ts` from
`c518127a025ab173874af9c7d304f26b25213b0d`. The
[voice endpoint model](./voiceEndpoint.md) owns submission and
[audio playback](./mobilePlayback.md) owns what was heard.

## Story: Keep reply history consistent with what the person heard

### A qualifying interruption writes at most twice for one confirmed reply identity

Only interruption with an unheard remainder can request a correction.
The conversation must identify a known assistant reply with a valid
UUID. Premature playback failure with nothing heard keeps the saved
reply. An interruption with no heard sentence explicitly sends
`nothingHeard`; otherwise send the normalized heard text. The key is
conversation and reply ID. It is reserved before I/O and excludes later
calls from replaying the report. Both attempts require the current
binding and available route. A result must return `ok: true` and the
same message ID. Conflict is final. Transport failure, 404, 429, 503
and other 5xx outcomes allow one retry after the configured delay,
1,500 ms by default. Each request has a 10-second timeout. Unchanged,
recorded, rejected, unavailable, conflict, stale, and exhausted 404
remain distinct. Diagnostics cannot change the result.

```quint
type HeardOutcome = HeardPending | HeardRecorded | HeardUnchanged | HeardConflict | HeardRejected | HeardUnavailable | HeardMissing | HeardStale
type HeardWire = WireChanged | WireUnchanged | WireMismatch | WireConflict | WireMissing | WireTransient | WireRejected
type HeardPhase = HeardUnreserved | HeardReady | HeardInFlight | HeardRetry | HeardSettled
type HeardReceipt = { phase: HeardPhase, attempts: int, outcome: HeardOutcome, nothing: bool }
pure val initial: HeardReceipt = { phase: HeardUnreserved, attempts: 0, outcome: HeardPending, nothing: false }
pure def canRetainReport(h: HeardReceipt, interrupted: bool, unheardRemainder: bool, validReply: bool, noHeard: bool, playbackFailed: bool): bool =
  h.phase == HeardUnreserved and interrupted and unheardRemainder and validReply and not(noHeard and playbackFailed)
pure def retainReport(h: HeardReceipt, interrupted: bool, unheardRemainder: bool, validReply: bool, noHeard: bool, playbackFailed: bool): HeardReceipt =
  { ...h, phase: HeardReady, nothing: noHeard }
pure def canDispatchReport(h: HeardReceipt, retryDelayElapsed: bool): bool =
  h.phase == HeardReady or (h.phase == HeardRetry and retryDelayElapsed)
pure def dispatchReport(h: HeardReceipt, retryDelayElapsed: bool, currentBinding: bool, routeReady: bool): HeardReceipt =
  if (currentBinding and routeReady) { ...h, phase: HeardInFlight, attempts: h.attempts + 1 }
  else { ...h, phase: HeardSettled, outcome: HeardStale }
pure def canReadReport(h: HeardReceipt): bool = h.phase == HeardInFlight
pure def readReport(h: HeardReceipt, received: HeardWire): HeardReceipt =
  if ((received == WireMissing or received == WireTransient) and h.attempts == 1) { ...h, phase: HeardRetry }
  else { ...h, phase: HeardSettled, outcome:
    if (received == WireChanged) HeardRecorded else if (received == WireUnchanged) HeardUnchanged else if (received == WireConflict) HeardConflict
    else if (received == WireMissing) HeardMissing else if (received == WireTransient) HeardUnavailable else HeardRejected }
pure def alwaysReportAttemptsAreBounded(h: HeardReceipt): bool =
  h.attempts >= 0 and h.attempts <= 2 and
  ((h.phase == HeardUnreserved or h.phase == HeardReady) implies h.attempts == 0) and
  (h.phase == HeardRetry implies h.attempts == 1) and
  (h.phase == HeardInFlight implies h.attempts > 0)
pure def alwaysReportSettlementIsExplicit(h: HeardReceipt): bool = (h.phase == HeardSettled) == (h.outcome != HeardPending)
pure def sometimesSecondReportSettles(h: HeardReceipt): bool = h.phase == HeardSettled and h.attempts == 2
pure def sometimesReportCanBecomeStale(h: HeardReceipt): bool = h.outcome == HeardStale
```
