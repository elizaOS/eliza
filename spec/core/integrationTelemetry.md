# Integration telemetry settlement

A span's `settled` latch is independent of the runtime error ring in [diagnostics](./diagnostics.md).
A timeout is an optional event field; this utility does not start a timer
or cancel an integration. A host calling `failure` on timeout and then
`success` on late completion still produces at most one log attempt.

## Story: Finalize integration telemetry once despite competing outcomes

> As a host, I want each integration span finalized exactly once, so a
> timeout followed by a late completion never logs twice.

I finalize one span with success or failure. The first call
claims the span before consulting the clock, severity policy or logger.
A repeated or reentrant call cannot retry a failed sink or replace the
first result. Clock, policy and sink exceptions remain observable failures.

### Finalization claims the latch before invoking dependencies

The owning package names the boundary and declares the errors that are
expected fallbacks on it when it opens the span. The event captures boundary and operation
before the final clock call, and reads optional timeout metadata afterward. Elapsed duration clamps
backward wall-clock movement to zero. The normalized error token is the
output of the error sanitization contract; successful events omit the token. Numeric-presence bits
preserve missing fields separately from a present numeric zero.

```quint
type SpanOutcome = SuccessOutcome | FailureOutcome
type SpanPhase = NotCreated | SpanOpen | ReadingClock | ChoosingSeverity | CallingSink | SpanComplete | SpanFailed
type EventSeverity = Info | Warn
type EventError = NoEventError | RuntimeUnavailable | StorageUnavailable | AuthInvalid | TimeoutKind | OtherError
type Span = { boundary: str, expectedFallbacks: List[EventError], operation: str, startedAt: int, settled: bool, phase: SpanPhase, result: SpanOutcome, duration: int, hasTimeout: bool, timeout: int, hasStatus: bool, status: int, error: EventError, errorToken: str, severity: EventSeverity, logAttempts: int }
pure val initial: Span = { boundary: "", expectedFallbacks: List(), operation: "", startedAt: 0, settled: false, phase: NotCreated, result: SuccessOutcome, duration: 0, hasTimeout: false, timeout: 0, hasStatus: false, status: 0, error: NoEventError, errorToken: "", severity: Info, logAttempts: 0 }
pure def canBeginSpan(s: Span, boundary: str, operation: str, startedAt: int, expectedFallbacks: List[EventError]): bool = s.phase == NotCreated
pure def beginSpan(s: Span, boundary: str, operation: str, startedAt: int, expectedFallbacks: List[EventError]): Span = { ...s, phase: SpanOpen, boundary: boundary, operation: operation, startedAt: startedAt, expectedFallbacks: expectedFallbacks }
pure def canFinalize(s: Span, result: SpanOutcome, hasStatus: bool, status: int): bool = s.phase != NotCreated
pure def finalize(s: Span, result: SpanOutcome, hasStatus: bool, status: int): Span =
  if (s.settled) s else { ...s, settled: true, phase: ReadingClock, result: result, hasStatus: hasStatus, status: status }
pure def canReadFinalClock(s: Span, now: int, hasTimeout: bool, timeout: int, error: EventError, errorToken: str): bool = s.phase == ReadingClock
pure def readFinalClock(s: Span, now: int, hasTimeout: bool, timeout: int, error: EventError, errorToken: str): Span =
  { ...s, phase: ChoosingSeverity, duration: if (now > s.startedAt) now - s.startedAt else 0, hasTimeout: hasTimeout, timeout: timeout, error: if (s.result == FailureOutcome) error else NoEventError, errorToken: if (s.result == FailureOutcome) errorToken else "" }
pure def canClockFailure(s: Span): bool = s.phase == ReadingClock
pure def clockFailure(s: Span): Span = { ...s, phase: SpanFailed }
pure def canChooseSeverity(s: Span, custom: bool, severity: EventSeverity): bool = s.phase == ChoosingSeverity
pure def chooseSeverity(s: Span, custom: bool, severity: EventSeverity): Span = { ...s, phase: CallingSink, severity: if (custom) severity else defaultSeverity(s), logAttempts: s.logAttempts + 1 }
pure def canPolicyFailure(s: Span): bool = s.phase == ChoosingSeverity
pure def policyFailure(s: Span): Span = { ...s, phase: SpanFailed }
pure def canFinishSink(s: Span, successful: bool): bool = s.phase == CallingSink
pure def finishSink(s: Span, successful: bool): Span = { ...s, phase: if (successful) SpanComplete else SpanFailed }
pure val startedAtValues = Set(0, 2)
pure val boundaryValues = Set("storage", "remote")
pure val expectedFallbacksValues: Set[List[EventError]] = Set(List(), List(TimeoutKind), List(OtherError))
pure val nowValues = Set(-1, 0, 1, 2, 3)
pure def alwaysLatchPrecedesDependencies(s: Span): bool = s.settled == (s.phase != SpanOpen and s.phase != NotCreated)
pure def alwaysAtMostOneLogAttempt(s: Span): bool = s.logAttempts >= 0 and s.logAttempts <= 1 and ((s.phase == CallingSink or s.phase == SpanComplete) implies s.logAttempts == 1)
pure def alwaysDurationIsClamped(s: Span): bool = s.duration >= 0
pure def alwaysSuccessOmitsFailureToken(s: Span): bool = s.result == SuccessOutcome implies s.error == NoEventError and s.errorToken == ""
pure def stepClaimedSpanCannotBeReopened(before: Span, after: Span): bool = before.settled implies after.settled
pure def stepRepeatedFinalizeIsInert(before: Span, via: str, after: Span): bool = before.settled and via == "finalize" implies before == after
pure def sometimesTimeoutWins(s: Span): bool = s.phase == SpanComplete and s.result == FailureOutcome and s.error == TimeoutKind
pure def sometimesClockFailureKeepsLatch(s: Span): bool = s.phase == SpanFailed and s.settled and s.logAttempts == 0
pure def sometimesSinkFailureKeepsLatch(s: Span): bool = s.phase == SpanFailed and s.logAttempts == 1
```

### Expected fallback paths use information severity under the default policy

A host may inject its own severity policy. The default treats a success,
and a failure whose error the owning package declared as an expected
fallback when it opened the span, as information; other failures are
warnings. An unclassified error always warns, even if a package declares it
expected. This classification never changes the event outcome.

```quint
pure def expectedFallback(s: Span): bool = s.error != OtherError and s.expectedFallbacks.includes(s.error)
pure def defaultSeverity(s: Span): EventSeverity = if (s.result == SuccessOutcome or expectedFallback(s)) Info else Warn
pure def lawSuccessIsInformation(s: Span): bool = s.result == SuccessOutcome implies defaultSeverity(s) == Info
pure def lawExpectedFallbackIsInformation(s: Span): bool = expectedFallback(s) implies defaultSeverity(s) == Info
pure def lawUnexpectedFailureWarns(s: Span): bool = s.result == FailureOutcome and not(expectedFallback(s)) implies defaultSeverity(s) == Warn
pure def lawUnclassifiedFailureWarns(s: Span): bool = s.result == FailureOutcome and s.error == OtherError implies defaultSeverity(s) == Warn
```

### No result or sink attempt exists before the corresponding boundary

A fabricated open span could carry a prior
failure token, and a span awaiting severity could already count a sink
attempt. Finalization cannot inherit either state from its constructor.

```quint
pure def alwaysOpenSpanHasNoResult(s: Span): bool = (s.phase == NotCreated or s.phase == SpanOpen) implies s.result == SuccessOutcome and s.error == NoEventError and s.errorToken == ""
pure def alwaysSinkHasNotBeenCalledEarly(s: Span): bool = (s.phase == NotCreated or s.phase == SpanOpen or s.phase == ReadingClock or s.phase == ChoosingSeverity) implies s.logAttempts == 0
```
