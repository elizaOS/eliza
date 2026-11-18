# App update trust and publication authorization

The decisions of the app-update trust engine (`native/ota-trust`, Go) and of
the publisher (`src/app-update/publication.vibe`): which signed release a
device may prepare, what its update lane remembers, whether a prepared
release may still be committed, and whether a release host may publish a
signed metadata graph. The sources are develop's
`native/ota-trust/{admission,admission_state,recovery_authorization,channel_roles,host_policy,publication_graph}.go`,
`native/ota-publisher/{publication-authorizer,publisher-policy}.mjs`,
`quint/OtaFreshAdmission.qnt` and the updater's `CommitFreshness.java`.

The shell verifies TUF signatures, hashes and lengths, decodes strict JSON,
computes the content digests of a descriptor without its rollout (`core`)
and of its rollout, reads qualified time as an interval, and checks the
device's fit for an artifact (upgrade origins, SDK, ABI, model, build
fingerprint, installer capabilities, supervisor, agent, browser and database
protocols, free storage, health and activation profiles, cohort bucket) in
that order. It holds the lane floors and the publisher floors under a lock
and writes them atomically. The host policy is compiled into the reviewed
build and has no runtime setter: metadata, remote callers and pages cannot
choose it.

## Story: Install an app update only when every authority allows it

> As a device owner, I want an app update prepared and installed only while
> its channel's approvers, my update lane and my device all still allow it,
> so that an old, revoked, equivocating or foreign release never replaces my
> app.

### A Stable release needs two distinct approver keys and a Beta release one, and no channel key holds any other authority

The two channel roles are the only delegations. Each counts an authorized
key once, so a repeated signature or an alias of one key never makes two
approvals. A channel key is neither a root key nor a key of the other
channel.

```quint
import apk.* from "../image/apk"
type Channel = Stable | Beta
type RoleKeys = { threshold: int, members: List[int] }
type ChannelRoles = { stableKeys: RoleKeys, betaKeys: RoleKeys }
pure def minimumApprovals(channel: Channel): int = if (channel == Stable) 2 else 1
pure def distinctKeys(members: List[int]): bool = members.every(k => members.select(x => x == k).length() == 1)
pure def roleValid(role: RoleKeys, channel: Channel): bool = distinctKeys(role.members) and minimumApprovals(channel) <= role.threshold and role.threshold <= role.members.length()
pure def channelRolesValid(roles: ChannelRoles, rootKeys: List[int]): bool =
  roleValid(roles.stableKeys, Stable) and roleValid(roles.betaKeys, Beta) and roles.betaKeys.members.every(k => not(rootKeys.includes(k))) and roles.stableKeys.members.every(k => not(roles.betaKeys.members.includes(k)) and not(rootKeys.includes(k)))
pure def channelApproved(role: RoleKeys, approvers: List[int]): bool = role.members.select(k => approvers.includes(k)).length() >= role.threshold
pure val validRoles: ChannelRoles = { stableKeys: { threshold: 2, members: List(1, 2) }, betaKeys: { threshold: 1, members: List(3) } }
pure val rolesValues = Set(validRoles, { ...validRoles, stableKeys: { threshold: 1, members: List(1, 2) } }, { ...validRoles, stableKeys: { threshold: 2, members: List(1, 1) } }, { ...validRoles, betaKeys: { threshold: 1, members: List(1) } }, { ...validRoles, betaKeys: { threshold: 1, members: List(9) } })
pure val rootKeysValues = Set(List(9), List())
pure val approverValues = Set(1, 2, 3, 9)
pure def lawOneKeyNeverApprovesStable(roles: ChannelRoles, rootKeys: List[int], approver: int): bool =
  channelRolesValid(roles, rootKeys) implies not(channelApproved(roles.stableKeys, List(approver, approver)))
```

### Admission defers for the first failing check, in a fixed order

The order is: host policy, product, release shape, repository, channel,
distribution, metadata rollback, paused, rollout window, revoked artifact,
security floor, quarantine, signer, already installed, forward version,
device fit. The lane's remembered floors raise the configured minimums.
A release is well formed when both artifacts have real, different digests,
one signer, a recovery version above the candidate's and security epochs
at the release's floor, and its window starts before it expires. The whole
trusted interval must lie in the window. Eligibility is not permission to
install.

```quint
type Distribution = Launcher | Standalone
type HostPolicy = HostConfigured({ product: str }) | HostUnconfigured
type Interval = { lower: int, upper: int }
type ReleaseArtifact = { sha256: Digest, version: PackageVersion, securityEpoch: int }
type Rollout = { revision: int, digest: Digest, paused: bool, starts: int, expires: int, revoked: List[Digest] }
type Release = { product: str, repository: str, channel: Channel, distribution: Distribution, sequence: int, securityFloor: int, core: Digest, candidate: ReleaseArtifact, recovery: ReleaseArtifact, rollout: Rollout }
type InstalledApp = { sha256: Digest, version: PackageVersion }
type FitProblem = BridgeReleaseRequired | UnqualifiedDevice | InstallerAuthority | ProtocolIncompatible | DataIncompatible | DiskReserve | UnsupportedSafetyProfile | OutsideCohort
type DeviceFit = Fits | Misfits({ fitProblem: FitProblem })
type Device = { channel: Channel, distribution: Distribution, app: InstalledApp, quarantine: List[Digest], fit: DeviceFit }
type AdmissionBounds = { repository: str, trusted: Interval, minimumSequence: int, minimumRevision: int, securityFloor: int }
type LaneFloor = { sequence: int, revision: int, security: int, core: Digest, rollout: Digest, revoked: List[Digest], refreshed: int }
type Deferral = HostNotConfigured | ProductMismatch | MalformedRelease | RepositoryMismatch | ChannelMismatch | DistributionMismatch | MetadataRollback | RolloutPaused | RolloutTime | RevokedArtifact | SecurityFloor | Quarantined | SignerMismatch | AwaitForwardVersion | Unfit({ fitProblem: FitProblem })
type Admission = Eligible | AlreadyInstalled | Deferred({ deferral: Deferral })
pure def larger(a: int, b: int): int = if (a > b) a else b
pure def smaller(a: int, b: int): int = if (a < b) a else b
pure def listed(digests: List[Digest], d: Digest): bool = digests.some(x => digestsMatch(x, d))
pure def pairListed(digests: List[Digest], r: Release): bool = listed(digests, r.candidate.sha256) or listed(digests, r.recovery.sha256)
pure def releaseSecurity(r: Release): int = smaller(r.securityFloor, smaller(r.candidate.securityEpoch, r.recovery.securityEpoch))
pure def inWindow(rollout: Rollout, trusted: Interval): bool = rollout.starts <= trusted.lower and trusted.upper < rollout.expires
pure def wellFormed(r: Release): bool =
  isDigest(r.candidate.sha256) and isDigest(r.recovery.sha256) and not(digestsMatch(r.candidate.sha256, r.recovery.sha256)) and digestsMatch(r.candidate.version.signer, r.recovery.version.signer) and r.recovery.version.versionCode > r.candidate.version.versionCode and r.sequence >= 1 and r.rollout.revision >= 1 and r.securityFloor >= 1 and releaseSecurity(r) == r.securityFloor and r.rollout.starts < r.rollout.expires
pure def hostAdmits(host: HostPolicy, product: str): bool = match host { | HostConfigured(h) => h.product == product | _ => false }
pure def fitDeferral(fit: DeviceFit): Admission = match fit { | Misfits(m) => Deferred({ deferral: Unfit({ fitProblem: m.fitProblem }) }) | _ => Eligible }
pure def admissionDecision(host: HostPolicy, r: Release, device: Device, bounds: AdmissionBounds, floor: LaneFloor): Admission =
  if (host == HostUnconfigured) Deferred({ deferral: HostNotConfigured })
  else if (not(hostAdmits(host, r.product))) Deferred({ deferral: ProductMismatch })
  else if (not(wellFormed(r))) Deferred({ deferral: MalformedRelease })
  else if (r.repository != bounds.repository) Deferred({ deferral: RepositoryMismatch })
  else if (r.channel != device.channel) Deferred({ deferral: ChannelMismatch })
  else if (r.distribution != device.distribution) Deferred({ deferral: DistributionMismatch })
  else if (r.sequence < larger(bounds.minimumSequence, floor.sequence) or r.rollout.revision < larger(bounds.minimumRevision, floor.revision)) Deferred({ deferral: MetadataRollback })
  else if (r.rollout.paused) Deferred({ deferral: RolloutPaused })
  else if (not(inWindow(r.rollout, bounds.trusted))) Deferred({ deferral: RolloutTime })
  else if (pairListed(r.rollout.revoked, r) or pairListed(floor.revoked, r)) Deferred({ deferral: RevokedArtifact })
  else if (releaseSecurity(r) < larger(bounds.securityFloor, floor.security)) Deferred({ deferral: SecurityFloor })
  else if (pairListed(device.quarantine, r)) Deferred({ deferral: Quarantined })
  else if (apkUpdateProblems(device.app.version, r.candidate.version).contains(SignerChanged)) Deferred({ deferral: SignerMismatch })
  else if (digestsMatch(r.candidate.sha256, device.app.sha256) and r.candidate.version.versionCode == device.app.version.versionCode) AlreadyInstalled
  else if (apkUpdateProblems(device.app.version, r.candidate.version).contains(VersionNotRaised)) Deferred({ deferral: AwaitForwardVersion })
  else fitDeferral(device.fit)
pure val signerC1 = Sha256({ hex: "c1" })
pure val releaseA: Release = { product: "app1", repository: "org/app", channel: Stable, distribution: Launcher, sequence: 2, securityFloor: 1, core: Sha256({ hex: "k2" }), candidate: { sha256: Sha256({ hex: "a2" }), version: { versionCode: 2, signer: signerC1 }, securityEpoch: 1 }, recovery: { sha256: Sha256({ hex: "a3" }), version: { versionCode: 3, signer: signerC1 }, securityEpoch: 1 }, rollout: { revision: 1, digest: Sha256({ hex: "r1" }), paused: false, starts: 10, expires: 100, revoked: List() } }
pure val rValues = Set(releaseA, { ...releaseA, rollout: { ...releaseA.rollout, paused: true } }, { ...releaseA, rollout: { ...releaseA.rollout, revoked: List(Sha256({ hex: "a2" })) } }, { ...releaseA, sequence: 1, core: Sha256({ hex: "k1" }) }, { ...releaseA, core: Sha256({ hex: "k9" }) }, { ...releaseA, rollout: { ...releaseA.rollout, revision: 2, digest: Sha256({ hex: "r2" }), revoked: List(Sha256({ hex: "a9" })) } }, { ...releaseA, rollout: { ...releaseA.rollout, digest: Sha256({ hex: "r9" }) } }, { ...releaseA, channel: Beta }, { ...releaseA, recovery: { ...releaseA.recovery, sha256: NotADigest } }, { ...releaseA, candidate: { ...releaseA.candidate, version: { versionCode: 1, signer: signerC1 } } }, { ...releaseA, rollout: { ...releaseA.rollout, expires: 25 } })
pure val deviceA: Device = { channel: Stable, distribution: Launcher, app: { sha256: Sha256({ hex: "a1" }), version: { versionCode: 1, signer: signerC1 } }, quarantine: List(), fit: Fits }
pure val deviceValues = Set(deviceA, { ...deviceA, quarantine: List(Sha256({ hex: "a3" })) }, { ...deviceA, channel: Beta }, { ...deviceA, app: { ...deviceA.app, version: { versionCode: 1, signer: Sha256({ hex: "c2" }) } } }, { ...deviceA, app: { sha256: Sha256({ hex: "a2" }), version: { versionCode: 2, signer: signerC1 } } }, { ...deviceA, fit: Misfits({ fitProblem: OutsideCohort }) })
pure val boundsA: AdmissionBounds = { repository: "org/app", trusted: { lower: 20, upper: 30 }, minimumSequence: 1, minimumRevision: 1, securityFloor: 1 }
pure val boundsValues = Set(boundsA, { ...boundsA, trusted: { lower: 5, upper: 6 } }, { ...boundsA, securityFloor: 2 }, { ...boundsA, minimumSequence: 3 })
pure val unseenLane: LaneFloor = { sequence: 0, revision: 0, security: 0, core: NotADigest, rollout: NotADigest, revoked: List(), refreshed: 0 }
pure val laneA: LaneFloor = { sequence: 2, revision: 1, security: 1, core: Sha256({ hex: "k2" }), rollout: Sha256({ hex: "r1" }), revoked: List(), refreshed: 20 }
pure val floorValues = Set(unseenLane, laneA, { ...laneA, sequence: 3, core: Sha256({ hex: "k3" }) }, { ...laneA, revoked: List(Sha256({ hex: "a3" })) }, { ...laneA, security: 2 }, { ...laneA, refreshed: 0 })
pure val hostValues = Set(HostConfigured({ product: "app1" }), HostConfigured({ product: "app2" }), HostUnconfigured)
pure def lawEligibleNeedsEveryAuthority(host: HostPolicy, r: Release, device: Device, bounds: AdmissionBounds, floor: LaneFloor): bool =
  admissionDecision(host, r, device, bounds, floor) == Eligible implies (hostAdmits(host, r.product) and wellFormed(r) and r.channel == device.channel and r.sequence >= floor.sequence and r.rollout.revision >= floor.revision and not(r.rollout.paused) and inWindow(r.rollout, bounds.trusted) and not(pairListed(floor.revoked, r)) and not(pairListed(device.quarantine, r)) and releaseSecurity(r) >= floor.security and apkUpdateProblems(device.app.version, r.candidate.version).size() == 0 and device.fit == Fits)
pure def lawAlreadyInstalledIsTheInstalledBuild(host: HostPolicy, r: Release, device: Device, bounds: AdmissionBounds, floor: LaneFloor): bool =
  admissionDecision(host, r, device, bounds, floor) == AlreadyInstalled implies (r.candidate.sha256 == device.app.sha256 and isDigest(device.app.sha256))
```

### A lane remembers an authenticated release only forward, and never one that equivocates

An authenticated release of this repository, channel and distribution at
or above the lane's sequence, rollout revision and security is remembered
even when it is not eligible, so a later sequence still withdraws an older
prepared release. A release that drops a remembered revocation, or that
reuses the remembered sequence with another core, or the remembered
revision with another rollout, is refused and changes nothing. Only a
fetch advances the refresh time; evaluating stored bytes never does.

```quint
type Fetch = StoredBytes | Fetched({ fetchedLower: int })
type Lanes = { stable: LaneFloor, beta: LaneFloor }
type RememberCheck = Remembered | Unchanged | RevocationRegression | SequenceEquivocation | RolloutEquivocation
type Memory = { lanes: Lanes, check: RememberCheck }
pure def laneFor(lanes: Lanes, channel: Channel): LaneFloor = if (channel == Stable) lanes.stable else lanes.beta
pure def refreshAfter(fetch: Fetch, refreshed: int): int = match fetch { | Fetched(f) => larger(refreshed, f.fetchedLower) | _ => refreshed }
pure def rememberRelease(lanes: Lanes, r: Release, device: Device, repository: str, fetch: Fetch): Memory = {
  val floor = laneFor(lanes, device.channel)
  val remembered = { sequence: r.sequence, revision: r.rollout.revision, security: r.securityFloor, core: r.core, rollout: r.rollout.digest, revoked: r.rollout.revoked, refreshed: refreshAfter(fetch, floor.refreshed) }
  if (not(wellFormed(r)) or r.repository != repository or r.channel != device.channel or r.distribution != device.distribution) { lanes: lanes, check: Unchanged }
  else if (r.sequence < floor.sequence or r.rollout.revision < floor.revision or r.securityFloor < floor.security) { lanes: lanes, check: Unchanged }
  else if (floor.revoked.some(d => not(listed(r.rollout.revoked, d)))) { lanes: lanes, check: RevocationRegression }
  else if (floor.sequence == r.sequence and floor.core != r.core) { lanes: lanes, check: SequenceEquivocation }
  else if (floor.sequence == r.sequence and floor.revision == r.rollout.revision and floor.rollout != r.rollout.digest) { lanes: lanes, check: RolloutEquivocation }
  else { lanes: if (device.channel == Stable) { ...lanes, stable: remembered } else { ...lanes, beta: remembered }, check: Remembered }
}
pure val lanesValues = Set({ stable: unseenLane, beta: unseenLane }, { stable: laneA, beta: unseenLane }, { stable: { ...laneA, revoked: List(Sha256({ hex: "a9" })) }, beta: laneA })
pure val repositoryValues = Set("org/app", "org/other")
pure val fetchValues = Set(StoredBytes, Fetched({ fetchedLower: 25 }), Fetched({ fetchedLower: 5 }))
pure def lawRememberingOnlyRatchets(lanes: Lanes, r: Release, device: Device, repository: str, fetch: Fetch): bool = {
  val before = laneFor(lanes, device.channel)
  val after = laneFor(rememberRelease(lanes, r, device, repository, fetch).lanes, device.channel)
  after.sequence >= before.sequence and after.revision >= before.revision and after.security >= before.security and before.revoked.every(d => listed(after.revoked, d) or not(isDigest(d))) and after.refreshed >= before.refreshed
}
pure def lawEquivocationIsNeverRemembered(lanes: Lanes, r: Release, device: Device, repository: str, fetch: Fetch): bool = {
  val before = laneFor(lanes, device.channel)
  rememberRelease(lanes, r, device, repository, fetch).check == Remembered implies
    ((before.sequence == r.sequence implies before.core == r.core) and ((before.sequence == r.sequence and before.revision == r.rollout.revision) implies before.rollout == r.rollout.digest))
}
pure def lawRefusedReleaseChangesNothing(lanes: Lanes, r: Release, device: Device, repository: str, fetch: Fetch): bool =
  rememberRelease(lanes, r, device, repository, fetch).check != Remembered implies rememberRelease(lanes, r, device, repository, fetch).lanes == lanes
pure def lawStoredBytesNeverRefresh(lanes: Lanes, r: Release, device: Device, repository: str): bool =
  laneFor(rememberRelease(lanes, r, device, repository, StoredBytes).lanes, device.channel).refreshed == laneFor(lanes, device.channel).refreshed
```

### Remembering a release on one channel never changes the other channel's lane

```quint
pure def otherChannel(channel: Channel): Channel = if (channel == Stable) Beta else Stable
pure def lawLanesAreIsolated(lanes: Lanes, r: Release, device: Device, repository: str, fetch: Fetch): bool =
  laneFor(rememberRelease(lanes, r, device, repository, fetch).lanes, otherChannel(device.channel)) == laneFor(lanes, otherChannel(device.channel))
```

### A prepared release commits only under current lane authority and a refresh at most ten minutes older than the commit

Just before the install session is written, under the journal lock and
with no network call, the prepared release is checked against the lane as
it is now: lost authority, expiry, the start of its window, revocation of
either artifact, the security floor, a later sequence, then freshness. The
window is the prepared descriptor's, so a newer rollout at the same
sequence neither pauses nor shortens it. An activation run accepts a
refresh no older than its own start and must commit within ten minutes of
it, so a revocation published before the commit is missed only when it is
newer than the run. The periodic recheck of a verified plan has no
freshness bound.

```quint
type CommitFreshness = AnyRefresh | RefreshedFor({ refreshedAfter: int, commitBy: int })
type CommitTerms = { trusted: Interval, securityFloor: int, freshness: CommitFreshness }
type CommitDecision = CommitEligible | AuthorityLost | Expired | BeforeRollout | RevokedSinceAdmission | BelowSecurityFloor | Superseded | StaleMetadata
pure val maxCommitStalenessMs = 0
pure val maxActivationRunMs = 600000
pure def activationFreshness(activationStarted: int): CommitFreshness =
  RefreshedFor({ refreshedAfter: larger(1, activationStarted - maxCommitStalenessMs), commitBy: activationStarted + maxActivationRunMs })
pure def freshEnough(freshness: CommitFreshness, refreshed: int, upper: int): bool = match freshness { | RefreshedFor(f) => refreshed >= f.refreshedAfter and upper <= f.commitBy | _ => true }
pure def remembersRelease(floor: LaneFloor, r: Release): bool = floor.sequence >= r.sequence and floor.revision >= r.rollout.revision
pure def commitDecision(r: Release, floor: LaneFloor, commitTerms: CommitTerms): CommitDecision =
  if (not(remembersRelease(floor, r))) AuthorityLost
  else if (commitTerms.trusted.upper >= r.rollout.expires) Expired
  else if (commitTerms.trusted.lower < r.rollout.starts) BeforeRollout
  else if (pairListed(floor.revoked, r)) RevokedSinceAdmission
  else if (releaseSecurity(r) < larger(commitTerms.securityFloor, floor.security)) BelowSecurityFloor
  else if (floor.sequence > r.sequence) Superseded
  else if (not(freshEnough(commitTerms.freshness, floor.refreshed, commitTerms.trusted.upper))) StaleMetadata
  else CommitEligible
pure val trustedValues = Set({ lower: 20, upper: 30 }, { lower: 5, upper: 6 }, { lower: 20, upper: 99 })
pure val securityFloorValues = Set(1, 2)
pure val activationStartedValues = Set(15, 20, 25)
pure val commitTermsValues = Set({ trusted: { lower: 20, upper: 30 }, securityFloor: 1, freshness: AnyRefresh }, { trusted: { lower: 20, upper: 30 }, securityFloor: 1, freshness: activationFreshness(20) },
  { trusted: { lower: 20, upper: 30 }, securityFloor: 1, freshness: activationFreshness(25) })
pure def lawCommitNeedsCurrentAuthority(r: Release, floor: LaneFloor, commitTerms: CommitTerms): bool =
  commitDecision(r, floor, commitTerms) == CommitEligible implies (floor.sequence == r.sequence and floor.revision >= r.rollout.revision and inWindow(r.rollout, commitTerms.trusted) and not(pairListed(floor.revoked, r)) and releaseSecurity(r) >= larger(commitTerms.securityFloor, floor.security))
pure def lawActivationCommitIsBoundedAfterRefresh(r: Release, floor: LaneFloor, trusted: Interval, securityFloor: int, activationStarted: int): bool =
  commitDecision(r, floor, { trusted: trusted, securityFloor: securityFloor, freshness: activationFreshness(activationStarted) }) == CommitEligible implies trusted.upper - floor.refreshed <= maxCommitStalenessMs + maxActivationRunMs
```

### Recovery loads only an unrevoked recovery artifact at the current security floor

A revoked candidate is why recovery can be needed, so it never blocks
recovery; a revoked recovery artifact is never an escape route.

```quint
type RecoveryDecision = RecoveryLoadable | RecoveryAuthorityLost | RecoveryRevoked | RecoveryBelowSecurityFloor
pure def recoveryDecision(r: Release, floor: LaneFloor, globalSecurityFloor: int): RecoveryDecision =
  if (not(remembersRelease(floor, r))) RecoveryAuthorityLost
  else if (listed(floor.revoked, r.recovery.sha256)) RecoveryRevoked
  else if (r.recovery.securityEpoch < larger(globalSecurityFloor, floor.security)) RecoveryBelowSecurityFloor
  else RecoveryLoadable
pure val globalSecurityFloorValues = Set(1, 2)
pure def lawRevokedCandidateStillRecovers(r: Release, floor: LaneFloor, globalSecurityFloor: int): bool =
  not(digestsMatch(r.candidate.sha256, r.recovery.sha256)) implies
    recoveryDecision(r, { ...floor, revoked: floor.revoked.append(r.candidate.sha256) }, globalSecurityFloor) == recoveryDecision(r, floor, globalSecurityFloor)
pure def lawRevokedRecoveryNeverLoads(r: Release, floor: LaneFloor, globalSecurityFloor: int): bool =
  isDigest(r.recovery.sha256) implies recoveryDecision(r, { ...floor, revoked: floor.revoked.append(r.recovery.sha256) }, globalSecurityFloor) != RecoveryLoadable
```

## Story: Publish an app update only with authorized versions

> As a release owner, I want a signed update published only when its
> channel's approvers signed it and no metadata role goes back, so that a
> single key, a stale graph or an unreviewed descriptor never reaches
> devices.

### Publisher role floors only ratchet

The six role versions (root, timestamp, snapshot, targets, stable, beta)
are provisioned explicitly; a missing or corrupt record is never reset.
Floors advance to a freshly verified graph's versions before the timestamp
is published; retrying the same versions is allowed, and a concurrent
lower authorization is refused.

```quint
type RoleVersions = { root: int, timestamp: int, snapshot: int, targets: int, stable: int, beta: int }
type FloorAdvance = FloorsAdvanced({ floors: RoleVersions }) | FloorsRefused
pure def completeVersions(versions: RoleVersions): bool = versions.root >= 1 and versions.timestamp >= 1 and versions.snapshot >= 1 and versions.targets >= 1 and versions.stable >= 1 and versions.beta >= 1
pure def atOrAbove(versions: RoleVersions, floors: RoleVersions): bool = versions.root >= floors.root and versions.timestamp >= floors.timestamp and versions.snapshot >= floors.snapshot and versions.targets >= floors.targets and versions.stable >= floors.stable and versions.beta >= floors.beta
pure def advancePublisherFloors(floors: RoleVersions, verified: RoleVersions): FloorAdvance = if (completeVersions(verified) and atOrAbove(verified, floors)) FloorsAdvanced({ floors: verified }) else FloorsRefused
pure def advancedFloors(advance: FloorAdvance, floors: RoleVersions): RoleVersions = match advance { | FloorsAdvanced(a) => a.floors | _ => floors }
pure val versionsA: RoleVersions = { root: 1, timestamp: 1, snapshot: 1, targets: 1, stable: 1, beta: 1 }
pure val floorsValues = Set(versionsA, { ...versionsA, timestamp: 2, snapshot: 2 }, { ...versionsA, root: 3 })
pure val verifiedValues = Set(versionsA, { ...versionsA, timestamp: 2, snapshot: 2 }, { ...versionsA, beta: 0 })
pure def lawPublisherFloorsNeverGoBack(floors: RoleVersions, verified: RoleVersions): bool = atOrAbove(advancedFloors(advancePublisherFloors(floors, verified), floors), floors)
pure def lawRetryAtTheFloorsIsAccepted(floors: RoleVersions): bool = completeVersions(floors) implies advancePublisherFloors(floors, floors) == FloorsAdvanced({ floors: floors })
```

### A publication is authorized only when one approved graph at the floors binds the plan and every descriptor is approved and preflighted

The graph is verified twice: first, then again under freshly read floors
after the slow source approvals and artifact preflights, and it must not
change in between. Both channel roles must be signed by their thresholds
of distinct approvers. The plan's timestamp and its descriptors, one per
channel and distribution, must be exactly the graph's. A saved approval or
preflight is never reused. The authorized versions then become the floors.

```quint
type TargetPath = { channel: Channel, distribution: Distribution }
type SignedDescriptor = { path: TargetPath, sha256: Digest }
type PublicationGraph = { timestamp: Digest, versions: RoleVersions, roles: ChannelRoles, stableApprovers: List[int], betaApprovers: List[int], descriptors: List[SignedDescriptor] }
type PublicationPlan = { planTimestamp: Digest, planDescriptors: List[SignedDescriptor] }
type SourceEvidence = { approved: List[Digest], preflighted: List[SignedDescriptor] }
type PublicationProblem = PlanMalformed | GraphNotApproved | TimestampNotBound | RoleBelowFloor | DescriptorsDiffer | SourceNotApproved | PreflightMismatch | GraphChanged
type Publication = PublicationAuthorized({ versions: RoleVersions }) | PublicationRefused({ why: PublicationProblem })
pure def graphApproved(graph: PublicationGraph, rootKeys: List[int]): bool = channelRolesValid(graph.roles, rootKeys) and channelApproved(graph.roles.stableKeys, graph.stableApprovers) and channelApproved(graph.roles.betaKeys, graph.betaApprovers) and completeVersions(graph.versions)
pure def sameDescriptors(one: List[SignedDescriptor], other: List[SignedDescriptor]): bool = one.every(d => other.includes(d)) and other.every(d => one.includes(d))
pure def planWellFormed(plan: PublicationPlan): bool = plan.planDescriptors.length() > 0 and plan.planDescriptors.every(d => isDigest(d.sha256) and plan.planDescriptors.select(e => e.path == d.path).length() == 1)
pure def authorizePublication(plan: PublicationPlan, rootKeys: List[int], floors: RoleVersions, graph: PublicationGraph, evidence: SourceEvidence, recheckFloors: RoleVersions, recheck: PublicationGraph): Publication =
  if (not(planWellFormed(plan))) PublicationRefused({ why: PlanMalformed })
  else if (not(graphApproved(graph, rootKeys))) PublicationRefused({ why: GraphNotApproved })
  else if (not(digestsMatch(graph.timestamp, plan.planTimestamp))) PublicationRefused({ why: TimestampNotBound })
  else if (not(atOrAbove(graph.versions, floors))) PublicationRefused({ why: RoleBelowFloor })
  else if (not(sameDescriptors(graph.descriptors, plan.planDescriptors))) PublicationRefused({ why: DescriptorsDiffer })
  else if (not(plan.planDescriptors.every(d => listed(evidence.approved, d.sha256)))) PublicationRefused({ why: SourceNotApproved })
  else if (not(plan.planDescriptors.every(d => evidence.preflighted.includes(d)))) PublicationRefused({ why: PreflightMismatch })
  else if (not(graphApproved(recheck, rootKeys) and recheck.timestamp == graph.timestamp and recheck.versions == graph.versions and sameDescriptors(recheck.descriptors, graph.descriptors) and atOrAbove(recheck.versions, recheckFloors))) PublicationRefused({ why: GraphChanged })
  else PublicationAuthorized({ versions: graph.versions })
pure def authorizedVersions(publication: Publication): RoleVersions = match publication { | PublicationAuthorized(p) => p.versions | _ => { ...versionsA, root: 0 } }
pure val descriptorA: SignedDescriptor = { path: { channel: Stable, distribution: Launcher }, sha256: Sha256({ hex: "d1" }) }
pure val graphA: PublicationGraph = { timestamp: Sha256({ hex: "t1" }), versions: { ...versionsA, timestamp: 2, snapshot: 2 }, roles: validRoles, stableApprovers: List(1, 2), betaApprovers: List(3), descriptors: List(descriptorA) }
pure val graphValues = Set(graphA, { ...graphA, stableApprovers: List(1, 1) }, { ...graphA, versions: versionsA }, { ...graphA, timestamp: Sha256({ hex: "t2" }) }, { ...graphA, descriptors: List() }, { ...graphA, roles: { ...validRoles, stableKeys: { threshold: 1, members: List(1, 2) } }, stableApprovers: List(1) })
pure val recheckValues = graphValues
pure val planValues = Set({ planTimestamp: Sha256({ hex: "t1" }), planDescriptors: List(descriptorA) }, { planTimestamp: Sha256({ hex: "t1" }), planDescriptors: List() },
  { planTimestamp: Sha256({ hex: "t1" }), planDescriptors: List(descriptorA, { ...descriptorA, sha256: Sha256({ hex: "d2" }) }) })
pure val evidenceValues = Set({ approved: List(Sha256({ hex: "d1" })), preflighted: List(descriptorA) }, { approved: List(), preflighted: List(descriptorA) },
  { approved: List(Sha256({ hex: "d1" })), preflighted: List({ ...descriptorA, path: { channel: Beta, distribution: Launcher } }) })
pure val recheckFloorsValues = floorsValues
pure def lawAuthorizedPublicationIsApprovedAtTheFloors(plan: PublicationPlan, rootKeys: List[int], floors: RoleVersions, graph: PublicationGraph, evidence: SourceEvidence, recheckFloors: RoleVersions, recheck: PublicationGraph): bool =
  authorizePublication(plan, rootKeys, floors, graph, evidence, recheckFloors, recheck) == PublicationAuthorized({ versions: graph.versions }) implies
    (graphApproved(graph, rootKeys) and graphApproved(recheck, rootKeys) and atOrAbove(graph.versions, floors) and atOrAbove(graph.versions, recheckFloors) and plan.planDescriptors.every(d => listed(evidence.approved, d.sha256) and evidence.preflighted.includes(d) and graph.descriptors.includes(d)))
pure def lawAuthorizedVersionsBecomeTheFloors(plan: PublicationPlan, rootKeys: List[int], floors: RoleVersions, graph: PublicationGraph, evidence: SourceEvidence, recheckFloors: RoleVersions, recheck: PublicationGraph): bool = {
  val publication = authorizePublication(plan, rootKeys, floors, graph, evidence, recheckFloors, recheck)
  publication == PublicationAuthorized({ versions: graph.versions }) implies advancePublisherFloors(recheckFloors, authorizedVersions(publication)) == FloorsAdvanced({ floors: graph.versions })
}
```
