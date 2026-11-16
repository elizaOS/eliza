# Account pool leases

After the [pool](./accountPool.md) selects an account, its broker leases
it: it waits for a token decision, then validates that the decision still
belongs to the account's current credential generation and publishes that
exact receipt, with the organization the same decision carried. Usage and
health reports against the lease are serialized per account, and each
write is fenced by the credential generation, so a report from an old
credential never touches a replacement, and a success never erases a newer
failure written by someone else.

## Story: Lease a selected account and report its usage and health

> As the agent, I want the account I was given to be the one whose token I
> use and whose usage I report, so that a relink or a concurrent failure is
> never hidden or overwritten by an old call.

### A lease publishes the exact credential receipt it validated, with that decision's organization

A credential replaced after the decision refuses the lease; the lease
expires a fixed time after it was published.

```quint
type LeasePhase = LeaseIdle | LeasePending | LeaseResolved | LeaseRefused | LeaseRejected | LeaseActive | LeaseReleased | LeaseExpired
type Lease = { phase: LeasePhase, receipt: int, receiptOrganization: int, published: int, publishedOrganization: int, issuedAt: int, expiresAt: int }
type AccountHealth = HealthOk | RateLimited | NeedsReauth
type ReportKind = ReportSuccess | ReportAuth | ReportRate | ReportTransient
type ReportPhase = ReportQueued | ReportRecorded | ReportDone | ReportUnknownLease
type Report = { id: int, kind: ReportKind, generation: int, observedDetail: int, phase: ReportPhase, usageWritten: bool, healthWritten: bool }
type PoolLeases = { now: int, generation: int, nextGeneration: int, health: AccountHealth, healthDetail: int, usage: int, lease: Lease, reports: List[Report], queue: List[int], nextReport: int }
pure val leaseLifetime = 2
pure val noLease: Lease = { phase: LeaseIdle, receipt: 0, receiptOrganization: 0, published: 0, publishedOrganization: 0, issuedAt: 0, expiresAt: 0 }
pure val initial: PoolLeases = { now: 0, generation: 1, nextGeneration: 2, health: HealthOk, healthDetail: 0, usage: 0, lease: noLease, reports: List(), queue: List(), nextReport: 1 }
pure def organizationOf(generation: int): int = generation * 10
pure def canBeginLease(s: PoolLeases): bool = s.lease.phase != LeasePending and s.lease.phase != LeaseResolved and s.lease.phase != LeaseActive
pure def beginLease(s: PoolLeases): PoolLeases = { ...s, lease: { ...noLease, phase: LeasePending } }
pure def canResolveLease(s: PoolLeases, ok: bool): bool = s.lease.phase == LeasePending
pure def resolveLease(s: PoolLeases, ok: bool): PoolLeases =
  if (ok and s.generation != 0) { ...s, lease: { ...s.lease, phase: LeaseResolved, receipt: s.generation, receiptOrganization: organizationOf(s.generation) } }
  else { ...s, lease: { ...s.lease, phase: LeaseRejected } }
pure def canPublishLease(s: PoolLeases): bool = s.lease.phase == LeaseResolved
pure def publishLease(s: PoolLeases): PoolLeases =
  if (s.lease.receipt != s.generation) { ...s, lease: { ...s.lease, phase: LeaseRefused } }
  else { ...s, lease: { ...s.lease, phase: LeaseActive, published: s.lease.receipt, publishedOrganization: s.lease.receiptOrganization, issuedAt: s.now, expiresAt: s.now + leaseLifetime } }
pure def canReleaseLease(s: PoolLeases): bool = s.lease.phase == LeaseActive
pure def releaseLease(s: PoolLeases): PoolLeases = { ...s, lease: { ...s.lease, phase: LeaseReleased } }
pure def canExpireLease(s: PoolLeases): bool = s.lease.phase == LeaseActive and s.now >= s.lease.expiresAt
pure def expireLease(s: PoolLeases): PoolLeases = { ...s, lease: { ...s.lease, phase: LeaseExpired } }
pure def elapse(s: PoolLeases): PoolLeases = { ...s, now: s.now + 1 }
pure def canReplaceCredential(s: PoolLeases, remove: bool): bool = s.generation != 0
pure def replaceCredential(s: PoolLeases, remove: bool): PoolLeases =
  { ...s, generation: if (remove) 0 else s.nextGeneration, nextGeneration: s.nextGeneration + 1, health: HealthOk, healthDetail: 0 }
pure def alwaysPublishedReceiptOwnsItsDecision(s: PoolLeases): bool =
  s.lease.published != 0 implies (s.lease.published == s.lease.receipt and s.lease.publishedOrganization == s.lease.receiptOrganization and s.lease.publishedOrganization == organizationOf(s.lease.published)
    and s.lease.expiresAt == s.lease.issuedAt + leaseLifetime and s.lease.issuedAt <= s.now)
pure def alwaysRefusedLeaseHasNoPublication(s: PoolLeases): bool = (s.lease.phase == LeaseRefused or s.lease.phase == LeaseRejected or s.lease.phase == LeasePending or s.lease.phase == LeaseResolved) implies s.lease.published == 0
pure def sometimesReplacedAfterDecisionRefused(s: PoolLeases): bool = s.lease.phase == LeaseRefused
pure def sometimesLeaseOfReplacement(s: PoolLeases): bool = s.lease.phase == LeaseActive and s.lease.published >= 2
```

### Reports against one account are serialized, and a report without an active lease has no effect

```quint
pure def canSubmitReport(s: PoolLeases, kind: ReportKind): bool = s.lease.phase != LeaseIdle
pure def submitReport(s: PoolLeases, kind: ReportKind): PoolLeases = {
  val active = s.lease.phase == LeaseActive and s.now < s.lease.expiresAt
  val report = { id: s.nextReport, kind: kind, generation: s.lease.published, observedDetail: s.healthDetail, phase: if (active) ReportQueued else ReportUnknownLease, usageWritten: false, healthWritten: false }
  { ...s, reports: s.reports.append(report), queue: if (active) s.queue.append(s.nextReport) else s.queue, nextReport: s.nextReport + 1 }
}
pure def reportOf(s: PoolLeases, id: int): Report = s.reports.select(r => r.id == id).nthOr(0, { id: 0, kind: ReportTransient, generation: 0, observedDetail: 0, phase: ReportDone, usageWritten: false, healthWritten: false })
pure def withReport(id: int, change: Report, s: PoolLeases): List[Report] = s.reports.listMap(r => if (r.id == id) change else r)
pure def alwaysOnlyTheHeadIsWorking(s: PoolLeases): bool =
  s.reports.every(r => (r.phase == ReportRecorded implies s.queue.nthOr(0, 0) == r.id) and (r.phase == ReportUnknownLease implies (not(r.usageWritten) and not(r.healthWritten))) and ((r.phase == ReportQueued or r.phase == ReportRecorded) iff s.queue.includes(r.id)))
pure def sometimesReportAfterLeaseEnded(s: PoolLeases): bool = s.reports.some(r => r.phase == ReportUnknownLease)
```

### A report from an old credential generation writes nothing

```quint
pure def canRecordUsage(s: PoolLeases, id: int): bool = s.queue.nthOr(0, 0) == id and reportOf(s, id).phase == ReportQueued
pure def recordUsage(s: PoolLeases, id: int): PoolLeases = {
  val r = reportOf(s, id)
  val ownGeneration = r.generation == s.generation
  { ...s, usage: if (ownGeneration) s.usage + 1 else s.usage, reports: withReport(id, { ...r, phase: ReportRecorded, usageWritten: ownGeneration }, s) }
}
pure val idValues = Set(1, 2)
pure def alwaysReportEffectsOwnTheirGeneration(s: PoolLeases): bool = s.reports.every(r => (r.usageWritten or r.healthWritten) implies r.generation > 0)
pure def stepOldGenerationWritesNothing(before: PoolLeases, via: str, after: PoolLeases): bool =
  (via == "recordUsage" or via == "commitHealth") implies after.reports.every(r => (r.phase != reportOf(before, r.id).phase and r.generation != before.generation) implies (r.usageWritten == reportOf(before, r.id).usageWritten and not(r.healthWritten) and after.usage == before.usage and after.health == before.health and after.healthDetail == before.healthDetail))
pure def sometimesOldReportFenced(s: PoolLeases): bool = s.reports.some(r => r.phase == ReportDone and not(r.usageWritten) and r.generation > 0)
```

### A success never overwrites a newer health written by someone else

A failure report invalidates the health directly. A success restores it
only when nobody wrote the health since the report was admitted.

```quint
pure def canCommitHealth(s: PoolLeases, id: int): bool = s.queue.nthOr(0, 0) == id and reportOf(s, id).phase == ReportRecorded
pure def commitHealth(s: PoolLeases, id: int): PoolLeases = {
  val r = reportOf(s, id)
  val ownGeneration = r.generation == s.generation
  val invalidates = r.kind == ReportAuth or r.kind == ReportRate
  val write = ownGeneration and (invalidates or (r.kind == ReportSuccess and s.healthDetail == r.observedDetail))
  { ...s, queue: s.queue.tail(), reports: withReport(id, { ...r, phase: ReportDone, healthWritten: write }, s),
    health: if (not(write)) s.health else if (r.kind == ReportAuth) NeedsReauth else if (r.kind == ReportRate) RateLimited else HealthOk,
    healthDetail: if (write) s.healthDetail + 1 else s.healthDetail }
}
pure def canOtherWriterSetsHealth(s: PoolLeases, health: AccountHealth): bool = s.generation != 0
pure def otherWriterSetsHealth(s: PoolLeases, health: AccountHealth): PoolLeases = { ...s, health: health, healthDetail: s.healthDetail + 1 }
pure def stepSuccessKeepsNewerHealth(before: PoolLeases, via: str, after: PoolLeases): bool =
  via == "commitHealth" implies after.reports.every(r => (r.kind == ReportSuccess and r.healthWritten and not(reportOf(before, r.id).healthWritten)) implies before.healthDetail == r.observedDetail)
pure def sometimesNewerFailureSurvivesSuccess(s: PoolLeases): bool = s.health == NeedsReauth and s.reports.some(r => r.kind == ReportSuccess and r.phase == ReportDone and not(r.healthWritten))
```

### A removed account never reappears

```quint
pure def stepRemovedAccountStaysRemoved(before: PoolLeases, via: str, after: PoolLeases): bool = before.generation == 0 implies after.generation == 0
pure def alwaysGenerationsAreFresh(s: PoolLeases): bool = s.generation < s.nextGeneration and s.generation >= 0 and s.lease.published < s.nextGeneration and s.reports.every(r => r.generation < s.nextGeneration)
pure def sometimesRemovedAccountLeaseRejected(s: PoolLeases): bool = s.generation == 0 and s.lease.phase == LeaseRejected
```
