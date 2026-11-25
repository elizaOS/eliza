# PTY session store, access and spawn policy

This specification covers the access gates, spawn configuration policy,
concurrency capacity, failure-safe teardown, and bounded output windows for
interactive PTY sessions.

## Story: Gate interactive and vendor PTY access

> As an operator, I want HTTP PTY routes to enforce step-up terminal tokens,
> build-variant restrictions, fail-closed feature gates, and immutable launcher
> Cloud authority before any process is spawned.

### HTTP routes enforce terminal token or trusted local access

When no terminal run token is configured, only in-process or trusted local
callers may access PTY routes; remote HTTP callers receive 403. When a token is
configured, trusted local callers pass and all other HTTP callers must present a
matching token or receive 401.

```quint
type AccessVerdict = AccessAllowed | AccessForbiddenNoToken | AccessUnauthorizedMissing | AccessUnauthorizedInvalid
pure def evaluateRouteAccess(hasToken: bool, inProcess: bool, isTrustedLocal: bool, tokenProvided: bool, tokenMatches: bool): AccessVerdict =
  if (not(hasToken)) (if (inProcess or isTrustedLocal) AccessAllowed else AccessForbiddenNoToken)
  else if (isTrustedLocal) AccessAllowed
  else if (not(tokenProvided)) AccessUnauthorizedMissing
  else if (tokenMatches) AccessAllowed
  else AccessUnauthorizedInvalid
pure def lawRemoteHttpDeniedWithoutToken(tokenProvided: bool, tokenMatches: bool): bool =
  evaluateRouteAccess(false, false, false, tokenProvided, tokenMatches) == AccessForbiddenNoToken
pure def lawInvalidTokenRejected(inProcess: bool): bool =
  evaluateRouteAccess(true, inProcess, false, true, false) == AccessUnauthorizedInvalid
```

### Interactive and vendor CLI spawning fail closed

Store builds reject all interactive and vendor CLI spawns. The interactive flag
defaults on when unset, allows explicit truthy values, and fails closed on any
other explicit value. Vendor CLI sessions (`claude` and `codex`) require both
interactive spawning and an explicit truthy vendor flag. Unsupported session
kinds are rejected with bad-kind status.

```quint
type FlagState = FlagUnset | FlagTrue | FlagOther
type SpawnKind = KindElizaCode | KindClaude | KindCodex | KindUnsupported
type SpawnGateResult = SpawnAdmitted | SpawnDisabled | SpawnVendorDisabled | SpawnBadKind
pure def interactiveAllowed(isStoreBuild: bool, flag: FlagState): bool =
  not(isStoreBuild) and (flag == FlagUnset or flag == FlagTrue)
pure def vendorAllowed(isStoreBuild: bool, flag: FlagState): bool =
  not(isStoreBuild) and flag == FlagTrue
pure def evaluateSpawnGate(isStoreBuild: bool, interactiveFlag: FlagState, vendorFlag: FlagState, kind: SpawnKind): SpawnGateResult =
  if (not(interactiveAllowed(isStoreBuild, interactiveFlag))) SpawnDisabled
  else match kind {
    | KindElizaCode => SpawnAdmitted
    | KindClaude => if (vendorAllowed(isStoreBuild, vendorFlag)) SpawnAdmitted else SpawnVendorDisabled
    | KindCodex => if (vendorAllowed(isStoreBuild, vendorFlag)) SpawnAdmitted else SpawnVendorDisabled
    | KindUnsupported => SpawnBadKind
  }
pure def lawStoreBuildBlocksAllSpawns(interactiveFlag: FlagState, vendorFlag: FlagState, kind: SpawnKind): bool =
  evaluateSpawnGate(true, interactiveFlag, vendorFlag, kind) == SpawnDisabled
pure def lawVendorDefaultsClosed(interactiveFlag: FlagState): bool =
  evaluateSpawnGate(false, interactiveFlag, FlagUnset, KindClaude) != SpawnAdmitted and
  evaluateSpawnGate(false, interactiveFlag, FlagUnset, KindCodex) != SpawnAdmitted
```

### Launcher Cloud authority owns or disables the Cloud tuple

Under `staging-default` or `offline` launcher authority, Eliza Cloud PTY
sessions are disabled regardless of body or runtime inputs. Explicit launcher
authorities freeze the launcher-provided Cloud tuple and ignore caller overrides.

```quint
type CloudAuthority = NoAuthority | StagingDefault | Offline | StagingExplicit | ProductionExplicit
type CloudTupleMode = CloudDisabled | CloudLauncherFrozen | CloudOperatorInput
pure def resolveCloudTupleMode(authority: CloudAuthority): CloudTupleMode =
  match authority {
    | StagingDefault => CloudDisabled
    | Offline => CloudDisabled
    | StagingExplicit => CloudLauncherFrozen
    | ProductionExplicit => CloudLauncherFrozen
    | NoAuthority => CloudOperatorInput
  }
pure def lawBlockedAuthorityDisablesCloud(authority: CloudAuthority): bool =
  (authority == StagingDefault or authority == Offline) implies resolveCloudTupleMode(authority) == CloudDisabled
```

### Idle timeout and terminal geometry stay within safe bounds

An idle timeout is either 0 (disabled) or a positive integer up to 2147483647
milliseconds. Terminal resize geometry requires positive finite columns and rows
within bounds.

```quint
pure def validIdleTimeoutMs(ms: int): bool = ms >= 0 and ms <= 2147483647
pure def validTerminalGeometry(cols: int, rows: int): bool = cols >= 1 and rows >= 1 and cols <= 500 and rows <= 500
pure def boundedOutputSlice(totalChars: int, maxChars: int): int =
  if (totalChars <= 0 or maxChars <= 0) 0
  else if (totalChars < maxChars) totalChars
  else maxChars
pure def lawBoundedOutputNeverExceedsCap(totalChars: int, maxChars: int): bool =
  maxChars >= 0 implies boundedOutputSlice(totalChars, maxChars) <= maxChars and boundedOutputSlice(totalChars, maxChars) >= 0
```

## Story: Enforce session capacity, confinement, and safe teardown

> As the host, I want the PTY session store to enforce a strict capacity cap,
> require canonical directory confinement, preserve a live session when kill
> fails so operators can observe and retry it, and reap exited sessions only
> after they exit.

### Sessions respect capacity, unique ids, and safe stop semantics

Starting a session requires available capacity, a confined canonical working
directory, and a fresh non-empty identifier. Exiting transitions a live session
to exited so late subscribers can drain scrollback before reaping. Stopping a
live session removes it only when the OS kill succeeds; a failed kill leaves the
live session tracked and observable.

```quint
type PoolStatus = PoolLive | PoolExited
type PoolEntry = { sessionId: str, epoch: int, status: PoolStatus }
type PtyPool = { entries: List[PoolEntry], maxSessions: int, nextEpoch: int }
pure val initial: PtyPool = { entries: List(), maxSessions: 2, nextEpoch: 1 }
pure val sessionIdValues = Set("s1", "s2", "s3")
pure def hasEntry(entries: List[PoolEntry], sid: str): bool = entries.some(e => e.sessionId == sid)
pure def isLiveEntry(entries: List[PoolEntry], sid: str): bool = entries.some(e => e.sessionId == sid and e.status == PoolLive)
pure def isExitedEntry(entries: List[PoolEntry], sid: str): bool = entries.some(e => e.sessionId == sid and e.status == PoolExited)
pure def canStartPoolSession(pool: PtyPool, sessionId: str, cwdConfined: bool): bool =
  cwdConfined and sessionId != "" and pool.entries.length() < pool.maxSessions and not(hasEntry(pool.entries, sessionId))
pure def startPoolSession(pool: PtyPool, sessionId: str, cwdConfined: bool): PtyPool =
  { ...pool, entries: pool.entries.append({ sessionId: sessionId, epoch: pool.nextEpoch, status: PoolLive }), nextEpoch: pool.nextEpoch + 1 }
pure def canExitPoolSession(pool: PtyPool, sessionId: str): bool = isLiveEntry(pool.entries, sessionId)
pure def exitPoolSession(pool: PtyPool, sessionId: str): PtyPool =
  { ...pool, entries: pool.entries.listMap(e => if (e.sessionId == sessionId) { ...e, status: PoolExited } else e) }
pure def canStopPoolSession(pool: PtyPool, sessionId: str, killSucceeded: bool): bool =
  isExitedEntry(pool.entries, sessionId) or (isLiveEntry(pool.entries, sessionId) and killSucceeded)
pure def stopPoolSession(pool: PtyPool, sessionId: str, killSucceeded: bool): PtyPool =
  { ...pool, entries: pool.entries.select(e => e.sessionId != sessionId) }
pure def canReapPoolSession(pool: PtyPool, sessionId: str): bool = isExitedEntry(pool.entries, sessionId)
pure def reapPoolSession(pool: PtyPool, sessionId: str): PtyPool =
  { ...pool, entries: pool.entries.select(e => e.sessionId != sessionId) }
pure def alwaysPoolWithinCapacity(pool: PtyPool): bool =
  pool.maxSessions >= 0 and pool.entries.length() <= pool.maxSessions
pure def alwaysPoolIdsUnique(pool: PtyPool): bool =
  pool.entries.every(a => pool.entries.select(b => b.sessionId == a.sessionId).length() == 1)
pure def stepPoolEpochMonotonic(before: PtyPool, after: PtyPool): bool =
  after.nextEpoch >= before.nextEpoch and after.maxSessions == before.maxSessions
pure def lawFailedKillCannotRemoveLive(pool: PtyPool, sessionId: str): bool =
  isLiveEntry(pool.entries, sessionId) and not(isExitedEntry(pool.entries, sessionId)) implies not(canStopPoolSession(pool, sessionId, false))
pure def sometimesPoolAtCapacity(pool: PtyPool): bool = pool.entries.length() == pool.maxSessions
pure val eval_witness_sometimesPoolAtCapacity = (("startPoolSession", "s1", true), ("startPoolSession", "s2", true))
pure def sometimesPoolExitedReaped(pool: PtyPool): bool = pool.nextEpoch > 1 and pool.entries.length() == 0
pure val eval_witness_sometimesPoolExitedReaped = (("startPoolSession", "s1", true), ("exitPoolSession", "s1"), ("reapPoolSession", "s1"))
pure val poolValues = Set(initial, { entries: List({ sessionId: "s1", epoch: 1, status: PoolLive }), maxSessions: 2, nextEpoch: 2 })
```
