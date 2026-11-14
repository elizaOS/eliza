# Notification service recovery

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/services/notification.ts` and `quint/NotificationRecovery.qnt`. Recovery owns one background load per runtime and retains that ownership until failure cleanup completes. Cooldown uses elapsed monotonic time and caps at thirty seconds. Wall-clock correction does not accelerate recovery.

## Story: Retry a failed notification service without concurrent loaders

As a host, I can request recovery and receive an explicit started, in-flight, backoff or unavailable result. Requests during failure cleanup join the existing attempt. Only failed services start a recovery load.

### Availability and in-flight ownership decide recovery admission

```quint
type Availability = Pending | Failed | Registering | Registered | Disabled
type RecoveryPhase = Idle | Loading | SuccessCleanup | FailureCleanup
type RecoveryReply = NoRequest | Started | InFlight | Backoff | Unavailable
type Recovery = { availability: Availability, phase: RecoveryPhase, failures: int, remainingMs: int, reply: RecoveryReply }
pure val initial: Recovery = { availability: Pending, phase: Idle, failures: 0, remainingMs: 0, reply: NoRequest }
pure def delayMs(failures: int): int = if (failures <= 0) 0 else if (failures == 1) 1000 else if (failures == 2) 2000 else if (failures == 3) 4000 else if (failures == 4) 8000 else if (failures == 5) 16000 else 30000
pure def canSetAvailability(s: Recovery, availability: Availability): bool = s.phase == Idle and availability != Registering
pure def setAvailability(s: Recovery, availability: Availability): Recovery = { ...s, availability: availability }
pure def request(s: Recovery): Recovery =
  if (s.phase == Loading or s.phase == FailureCleanup) { ...s, reply: InFlight }
  else if (s.availability != Failed) { ...s, reply: Unavailable, failures: if (s.availability == Registered) 0 else s.failures, remainingMs: if (s.availability == Registered) 0 else s.remainingMs }
  else if (s.remainingMs > 0) { ...s, reply: Backoff }
  else { ...s, phase: Loading, availability: Registering, reply: Started }
```

### Failure cleanup retains attempt ownership and elapsed time controls the next retry

```quint
pure def canLoaded(s: Recovery): bool = s.phase == Loading
pure def loaded(s: Recovery): Recovery = { ...s, phase: SuccessCleanup, availability: Registered, failures: 0, remainingMs: 0 }
pure def canLoadFailed(s: Recovery): bool = s.phase == Loading
pure def loadFailed(s: Recovery): Recovery = { ...s, phase: FailureCleanup, availability: Failed, failures: s.failures + 1, remainingMs: delayMs(s.failures + 1) }
pure def canFinalize(s: Recovery): bool = s.phase == SuccessCleanup or s.phase == FailureCleanup
pure def finalize(s: Recovery): Recovery = { ...s, phase: Idle }
pure def canElapse(s: Recovery, milliseconds: int): bool = milliseconds >= 0
pure def elapse(s: Recovery, milliseconds: int): Recovery = { ...s, remainingMs: if (milliseconds >= s.remainingMs) 0 else s.remainingMs - milliseconds }
pure val millisecondsValues = Set(0, 1000, 2000, 30000)
pure def wallClockChanged(s: Recovery): Recovery = s
pure def alwaysCooldownIsBounded(s: Recovery): bool = s.failures >= 0 and s.remainingMs >= 0 and s.remainingMs <= delayMs(s.failures)
pure def alwaysLoaderOwnsRegistering(s: Recovery): bool = s.phase != Loading or s.availability == Registering
pure def stepNewLoaderRequiresFailedAndCooled(before: Recovery, via: str, after: Recovery): bool =
  via != "request" or before.phase == Loading or after.phase != Loading or (before.availability == Failed and before.remainingMs == 0)
pure def sometimesFailedCleanupStillOwnsRequest(s: Recovery): bool = s.phase == FailureCleanup and s.reply == InFlight
pure def sometimesRecoveryRegistered(s: Recovery): bool = s.phase == Idle and s.availability == Registered
pure val fair_loaded = "weak"
pure val fair_finalize = "weak"
pure def leadsToAttemptSettles(s: Recovery, later: Recovery): bool = s.phase != Idle implies later.phase == Idle
```
