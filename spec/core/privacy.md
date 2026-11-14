# PII scrub persistence and retirement

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/services/pii-scrub.ts`, `security/pii-scrub-markers.ts`, `security/pii-scrub-seam.ts`, `runtime/trajectory-gate.ts`, LazyPiiDrain and PiiScrubSettlement. The machine follows one exact content and ruleset key through a lazy queue. Different content or ruleset values require different keys. Pseudonym assignment storage is encrypted and must precede completion markers. Model and storage failures preserve quarantine and retry ownership.

## Story: Publish scrub completion only after durable privacy work

As an operator, I receive a completion event only after the scrub succeeded, pseudonym assignments persisted and the exact content/ruleset marker was acknowledged. A failed observer does not revoke an existing marker or repeat committed work. Concurrent initial misses may both scrub, since the marker check is not an exclusive claim.

### Admission checks shutdown again after the asynchronous marker lookup

The queue tracks accepted work as queued, in progress, processed, failed or discarded. A request waiting on a marker read owns no queue entry until that read settles and admission is checked again.

```quint
type PrivacyLife = Open | Stopping | Stopped
type Startup = Dormant | Starting | Ready
type ScrubPhase = Idle | Scrubbing | MapWriting | Marking | Notifying
type Privacy = { life: PrivacyLife, startup: Startup, checking: bool, phase: ScrubPhase, queued: int, accepted: int, processed: int, failed: int, discarded: int, attempts: int, marker: bool, mapPersisted: bool, completionObserved: bool }
pure val initial: Privacy = { life: Open, startup: Dormant, checking: false, phase: Idle, queued: 0, accepted: 0, processed: 0, failed: 0, discarded: 0, attempts: 0, marker: false, mapPersisted: false, completionObserved: false }
pure def active(s: Privacy): int = if (s.phase == Idle) 0 else 1
pure def canRequest(s: Privacy): bool = s.life == Open and not(s.checking)
pure def request(s: Privacy): Privacy = { ...s, checking: true }
pure def canFinishAdmission(s: Privacy): bool = s.checking
pure def finishAdmission(s: Privacy): Privacy =
  if (s.life == Open and not(s.marker)) { ...s, checking: false, queued: s.queued + 1, accepted: s.accepted + 1, startup: if (s.startup == Dormant) Starting else s.startup }
  else { ...s, checking: false }
pure def canStartSucceeded(s: Privacy): bool = s.startup == Starting
pure def startSucceeded(s: Privacy): Privacy = { ...s, startup: Ready }
pure def canStartFailed(s: Privacy): bool = s.startup == Starting
pure def startFailed(s: Privacy): Privacy = { ...s, startup: Dormant }
pure def alwaysAcceptedWorkIsAccounted(s: Privacy): bool = s.accepted == s.queued + active(s) + s.processed + s.failed + s.discarded
pure def alwaysCountsAreNonnegative(s: Privacy): bool = s.queued >= 0 and s.accepted >= 0 and s.processed >= 0 and s.failed >= 0 and s.discarded >= 0 and s.attempts >= 0
```

### A marker follows successful scrub and persisted pseudonym assignments

The retry threshold of four reflects PiiScrubSettlement's configured queue policy. The counter is a retry policy, not a cap on submitted content or retained context. Completion markers identify exact content and ruleset bytes and carry no raw content.

```quint
pure def canDrain(s: Privacy): bool = s.startup == Ready and s.life != Stopped and s.phase == Idle and s.queued > 0
pure def drain(s: Privacy): Privacy =
  if (s.marker) { ...s, queued: s.queued - 1, processed: s.processed + 1 }
  else { ...s, phase: Scrubbing, queued: s.queued - 1, attempts: s.attempts + 1 }
pure def canScrubbed(s: Privacy): bool = s.phase == Scrubbing
pure def scrubbed(s: Privacy): Privacy = { ...s, phase: MapWriting }
pure def canPersistMap(s: Privacy): bool = s.phase == MapWriting
pure def persistMap(s: Privacy): Privacy = { ...s, phase: Marking, mapPersisted: true }
pure def canConfirmMarker(s: Privacy): bool = s.phase == Marking and s.mapPersisted
pure def confirmMarker(s: Privacy): Privacy = { ...s, phase: Notifying, marker: true }
pure def canObserveCompletion(s: Privacy, observerSucceeded: bool): bool = s.phase == Notifying
pure def observeCompletion(s: Privacy, observerSucceeded: bool): Privacy = { ...s, phase: Idle, processed: s.processed + 1, attempts: 0, completionObserved: s.completionObserved or observerSucceeded }
pure def canAttemptFailed(s: Privacy): bool = s.phase == Scrubbing or s.phase == MapWriting or s.phase == Marking
pure def attemptFailed(s: Privacy): Privacy =
  if (s.attempts >= 4) { ...s, phase: Idle, failed: s.failed + 1, attempts: 0 }
  else { ...s, phase: Idle, queued: s.queued + 1 }
pure def alwaysCompletionRequiresPersistentMarker(s: Privacy): bool = (s.completionObserved or s.phase == Notifying) implies (s.marker and s.mapPersisted)
pure def stepMarkerRemainsCommitted(before: Privacy, after: Privacy): bool = not(before.marker) or after.marker
pure def sometimesCompletedScrub(s: Privacy): bool = s.completionObserved and s.processed > 0
pure def sometimesFailureRemainsUnconfirmed(s: Privacy): bool = s.failed > 0 and not(s.marker)
```

### Stop waits for lazy startup and active work before disposing the queue

Repeated stop calls observe the same retirement owner. A stopped service cannot admit a request whose marker lookup started before shutdown. Remaining queued work is explicitly discarded by queue disposal, preserving accounting.

```quint
pure def canStop(s: Privacy): bool = s.life == Open
pure def stop(s: Privacy): Privacy = { ...s, life: Stopping }
pure def canDispose(s: Privacy): bool = s.life == Stopping and s.startup != Starting and s.phase == Idle
pure def dispose(s: Privacy): Privacy = { ...s, life: Stopped, startup: Dormant, discarded: s.discarded + s.queued, queued: 0 }
pure def alwaysStoppedOwnsNoQueue(s: Privacy): bool = s.life != Stopped or (s.startup == Dormant and s.queued == 0 and s.phase == Idle)
pure def sometimesShutdownDuringLookup(s: Privacy): bool = s.life == Stopped and s.checking and s.accepted == 0
```

## Story: Respect the operator's trajectory persistence setting

As an operator, I can disable trajectory persistence explicitly. Hard disable wins over all other settings. Explicit nonblank logging settings override environment defaults. Protected, test and production profiles default off. Development defaults on. Blank values are represented as unspecified after normalization. User-specific consent belongs to the host's policy boundary and must be supplied before publication.

### Trajectory persistence follows the existing precedence order

```quint
type LoggingChoice = Unspecified | Enabled | Disabled
pure def trajectoryEnabled(hardDisabled: bool, explicit: LoggingChoice, protectedProfile: bool, testProfile: bool, productionProfile: bool): bool =
  not(hardDisabled) and (if (explicit == Enabled) true else if (explicit == Disabled) false else not(protectedProfile or testProfile or productionProfile))
pure def lawHardDisableWins(explicit: LoggingChoice, protectedProfile: bool, testProfile: bool, productionProfile: bool): bool =
  not(trajectoryEnabled(true, explicit, protectedProfile, testProfile, productionProfile))
pure def lawProductionRequiresOptIn(protectedProfile: bool, testProfile: bool): bool =
  not(trajectoryEnabled(false, Unspecified, protectedProfile, testProfile, true))
```

### Fairly settling startup and active work lets shutdown finish

The environment must eventually settle accepted storage and model calls. The scheduler must run enabled cleanup. These are explicit fairness assumptions. A nonsettling external operation can retain shutdown ownership.

```quint
pure val fair_startSucceeded = "weak"
pure val fair_scrubbed = "weak"
pure val fair_persistMap = "weak"
pure val fair_confirmMarker = "weak"
pure val fair_observeCompletion = "weak"
pure val fair_dispose = "weak"
pure def leadsToStartupSettles(s: Privacy, later: Privacy): bool = s.startup == Starting implies later.startup != Starting
pure def leadsToStopped(s: Privacy, later: Privacy): bool = s.life == Stopping implies later.life == Stopped
```
