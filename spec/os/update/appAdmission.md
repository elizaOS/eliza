# Android app update admission and commit freshness

An installed app update is admitted by the os package's update trust
owner, one instance per update lane, so refreshes of one channel never
advance another. The [installation journal](./install.md) checks package
signer, digests, versions and the exact prepared pair before it asks for
freshness; this spec starts at an authenticated descriptor, a qualified
observation and a validated enrollment.

## Story: Remember an authenticated release without rolling back a lane

> As a device owner, I want my update lane to remember every authenticated
> release it saw and never go back, so that an older, revoked or
> equivocating release cannot be replayed to my device.

### Sequence, rollout revision, security and revocation authority only advance

The stored floor includes a core digest by sequence, a rollout digest by
sequence and revision, revocations and the most recent successful
network refresh lower bound. An authenticated and in-lane release can
advance the floor even if no update is currently eligible. The caller
delivers a validated descriptor and the persistence result separately.
A partial commit after saving the floors may leave the old refresh time.
Evaluating stored bytes supplies refresh zero and never advances time.

```quint
type ReleaseFloor = { sequence: int, revision: int, security: int, coreId: int, rolloutId: int, revoked: Set[int] }
type LaneAuthority = { floor: ReleaseFloor, refreshed: int }
type PersistResult = NoDurableWrite | FloorOnly | FloorAndRefresh
pure val initial: LaneAuthority = {
  floor: { sequence: 0, revision: 0, security: 0, coreId: 0, rolloutId: 0, revoked: Set() },
  refreshed: 0
}
pure def sameSequenceCore(previous: ReleaseFloor, proposed: ReleaseFloor): bool =
  previous.sequence != proposed.sequence or previous.coreId == proposed.coreId
pure def sameRevisionRollout(previous: ReleaseFloor, proposed: ReleaseFloor): bool =
  previous.sequence != proposed.sequence or previous.revision != proposed.revision or previous.rolloutId == proposed.rolloutId
pure def validFloor(floor: ReleaseFloor): bool =
  floor.sequence >= 1 and floor.revision >= 1 and floor.security >= 1 and floor.coreId > 0 and floor.rolloutId > 0
pure def ratchet(previous: ReleaseFloor, proposed: ReleaseFloor): bool =
  proposed.sequence >= previous.sequence and proposed.revision >= previous.revision and proposed.security >= previous.security and
  previous.revoked.subseteq(proposed.revoked) and sameSequenceCore(previous, proposed) and sameRevisionRollout(previous, proposed)
pure def canRememberRelease(s: LaneAuthority, proposed: ReleaseFloor, fetchedLower: int): bool =
  validFloor(proposed) and fetchedLower >= 0 and ratchet(s.floor, proposed)
pure def rememberRelease(s: LaneAuthority, proposed: ReleaseFloor, fetchedLower: int, persistence: PersistResult): LaneAuthority =
  if (persistence == NoDurableWrite) s else {
    floor: proposed,
    refreshed: if (persistence == FloorAndRefresh and fetchedLower > s.refreshed) fetchedLower else s.refreshed
  }
pure val proposedValues = Set(
  { sequence: 1, revision: 1, security: 1, coreId: 10, rolloutId: 10, revoked: Set() },
  { sequence: 1, revision: 1, security: 1, coreId: 11, rolloutId: 10, revoked: Set() },
  { sequence: 1, revision: 2, security: 1, coreId: 10, rolloutId: 20, revoked: Set(2) },
  { sequence: 2, revision: 3, security: 2, coreId: 12, rolloutId: 30, revoked: Set(2) }
)
pure val fetchedLowerValues = Set(0, 5, 10)
pure def alwaysRefreshNonnegative(s: LaneAuthority): bool = s.refreshed >= 0
pure def stepAuthorityRatchets(before: LaneAuthority, after: LaneAuthority): bool =
  ratchet(before.floor, after.floor) and after.refreshed >= before.refreshed
pure def sometimesRevocationRemembered(s: LaneAuthority): bool = s.floor.revoked.contains(2)
pure def sometimesFloorWithNoRefresh(s: LaneAuthority): bool = s.floor.sequence > 0 and s.refreshed == 0
pure def sometimesRefreshRemembered(s: LaneAuthority): bool = s.refreshed > 0
```

### A release that equivocates on its sequence or rollout revision is never remembered

Two authenticated releases with the same sequence but different core
digests, or with the same sequence and revision but different rollout
digests, are equivocation. The floor refuses the later one, whatever else
it advances.

```quint
pure def lawEquivocationIsRefused(previous: ReleaseFloor, proposed: ReleaseFloor): bool =
  ((previous.sequence == proposed.sequence and previous.coreId != proposed.coreId) or
    (previous.sequence == proposed.sequence and previous.revision == proposed.revision and previous.rolloutId != proposed.rolloutId)) implies
    not(ratchet(previous, proposed))
pure val previousValues = proposedValues
```

## Story: Commit a previously prepared pair only with current authority

> As a device owner, I want an update prepared earlier to be committed only
> if it is still trusted now, so that a release revoked or superseded in
> the meantime is never installed.

### A current trust decision checks time, revocation, security and supersession

The qualified clock supplies an ordered interval. Expiry is exclusive
and the start is inclusive. The current lane must have observed the
prepared sequence and revision. Revocation includes both artifacts.
The security epochs of both artifacts and the descriptor must meet the
higher of the lane and global floors. A later sequence supersedes the
prepared candidate. A newer rollout at the same sequence does not
change the window in the already prepared descriptor. Recovery uses the
current lane, revocation and security independently of the original
rollout window. Identity, signer and artifact conformance of prepared
records are established by the native trust and installer ports.

```quint
type PreparedRelease = { sequence: int, revision: int, security: int, candidateSecurity: int, recoverySecurity: int, candidate: int, recovery: int, starts: int, expires: int }
type CommitPolicy = { lowerBound: int, upperBound: int, globalFloor: int, refreshedAfter: int, commitBy: int }
type TrustDecision = Eligible | InvalidPolicy | AuthorityLost | Expired | RolloutTime | RevokedArtifact | BelowSecurityFloor | Superseded | StaleMetadata | RecoveryLoadable
pure val releaseValues = Set(
  { sequence: 1, revision: 1, security: 1, candidateSecurity: 1, recoverySecurity: 1, candidate: 2, recovery: 3, starts: 1, expires: 15 },
  { sequence: 1, revision: 2, security: 1, candidateSecurity: 1, recoverySecurity: 1, candidate: 2, recovery: 3, starts: 10, expires: 20 },
  { sequence: 2, revision: 3, security: 2, candidateSecurity: 2, recoverySecurity: 2, candidate: 4, recovery: 5, starts: 1, expires: 20 }
)
pure val policyValues = Set(
  { lowerBound: 1, upperBound: 4, globalFloor: 1, refreshedAfter: 0, commitBy: 0 },
  { lowerBound: 4, upperBound: 8, globalFloor: 1, refreshedAfter: 5, commitBy: 10 },
  { lowerBound: 13, upperBound: 16, globalFloor: 2, refreshedAfter: 10, commitBy: 15 }
)
pure def validCommitPolicy(policy: CommitPolicy): bool =
  policy.lowerBound >= 1 and policy.upperBound >= policy.lowerBound and
  policy.globalFloor >= 1 and policy.refreshedAfter >= 0 and policy.commitBy >= 0
pure def remembers(floor: ReleaseFloor, release: PreparedRelease): bool =
  floor.sequence >= release.sequence and floor.revision >= release.revision
pure def reachesSecurity(floor: ReleaseFloor, release: PreparedRelease, globalFloor: int): bool =
  release.security >= globalFloor and release.candidateSecurity >= globalFloor and release.recoverySecurity >= globalFloor and
  release.security >= floor.security and release.candidateSecurity >= floor.security and release.recoverySecurity >= floor.security
pure def hasFreshMetadata(s: LaneAuthority, policy: CommitPolicy): bool =
  s.refreshed >= policy.refreshedAfter and (policy.commitBy == 0 or policy.upperBound <= policy.commitBy)
pure def inWindow(release: PreparedRelease, policy: CommitPolicy): bool =
  policy.lowerBound >= release.starts and policy.upperBound < release.expires
pure def commitDecision(s: LaneAuthority, release: PreparedRelease, policy: CommitPolicy): TrustDecision =
  if (not(validCommitPolicy(policy))) InvalidPolicy
  else if (not(remembers(s.floor, release))) AuthorityLost
  else if (policy.upperBound >= release.expires) Expired
  else if (policy.lowerBound < release.starts) RolloutTime
  else if (s.floor.revoked.contains(release.candidate) or s.floor.revoked.contains(release.recovery)) RevokedArtifact
  else if (not(reachesSecurity(s.floor, release, policy.globalFloor))) BelowSecurityFloor
  else if (s.floor.sequence > release.sequence) Superseded
  else if (not(hasFreshMetadata(s, policy))) StaleMetadata
  else Eligible
pure def recoveryDecision(s: LaneAuthority, release: PreparedRelease, globalFloor: int): TrustDecision =
  if (globalFloor < 1) InvalidPolicy
  else if (not(remembers(s.floor, release))) AuthorityLost
  else if (s.floor.revoked.contains(release.recovery)) RevokedArtifact
  else if (release.recoverySecurity < globalFloor or release.recoverySecurity < s.floor.security) BelowSecurityFloor
  else RecoveryLoadable
pure def lawCommitNeedsCurrentAuthority(floor: ReleaseFloor, refreshed: int, release: PreparedRelease, policy: CommitPolicy): bool = {
  val lane = { floor: floor, refreshed: refreshed }
  commitDecision(lane, release, policy) == Eligible implies
    validCommitPolicy(policy) and floor.sequence == release.sequence and floor.revision >= release.revision and
    inWindow(release, policy) and hasFreshMetadata(lane, policy) and reachesSecurity(floor, release, policy.globalFloor) and
    not(floor.revoked.contains(release.candidate)) and not(floor.revoked.contains(release.recovery))
}
pure def lawRecoveryUsesCurrentAuthority(floor: ReleaseFloor, release: PreparedRelease, globalFloor: int): bool =
  recoveryDecision({ floor: floor, refreshed: 0 }, release, globalFloor) == RecoveryLoadable implies
    remembers(floor, release) and globalFloor >= 1 and release.recoverySecurity >= globalFloor and
    release.recoverySecurity >= floor.security and not(floor.revoked.contains(release.recovery))
pure val floorValues = proposedValues
pure val refreshedValues = Set(0, 5, 10)
pure val globalFloorValues = Set(0, 1, 2)
```

## Story: Prepare only a release compatible with the installed device

> As a device owner, I want an update prepared only when it suits my
> installed app and device, so that an incompatible, paused or unqualified
> release waits instead of breaking my phone.

### Admission returns the first qualified reason for deferral

After authenticated descriptor, policy and device decoding, a general
admission check evaluates repository, channel and distribution. It uses
the higher configured and remembered floors. A paused release, an
out-of-window interval, revocation, quarantine, or insufficient
security stops eligibility. Candidate identity includes digest and
version. A forward candidate must accept the installed origin.
Each artifact must satisfy signer, Android device and installer
capability, supervisor, agent, browser and database compatibility.
Available storage, supported health and activation profiles, and
cohort are checked after artifact qualification. An eligible result
returns the authenticated release's exact pair. The Boolean evidence
fields represent attestations for the corresponding source checks.

```quint
type AdmissionEvidence = {
  repositoryMatches: bool, laneMatches: bool, distributionMatches: bool,
  paused: bool, qualifiedWindow: bool, pairRevoked: bool, securityQualified: bool,
  quarantined: bool, candidateSignerMatches: bool, pairSignerMatches: bool,
  exactInstalledIdentity: bool, candidateVersion: int, installedVersion: int,
  originAllowed: bool, androidQualified: bool, installerAuthorized: bool,
  protocolsCompatible: bool, databaseCompatible: bool, diskReserve: bool,
  safetySupported: bool, inCohort: bool, metadataQualified: bool
}
type PrepareDecision = PrepareEligible | RepositoryMismatch | ChannelMismatch | DistributionMismatch | MetadataRollback | RolloutPaused | OutsideQualifiedTime | PairRevoked | ReleaseBelowSecurity | PairQuarantined | SignerMismatch | AlreadyInstalled | AwaitForwardVersion | BridgeReleaseRequired | UnqualifiedDevice | InstallerAuthority | ProtocolIncompatible | DataIncompatible | DiskReserve | UnsupportedSafetyProfile | OutsideCohort
pure def preparationDecision(e: AdmissionEvidence): PrepareDecision =
  if (not(e.repositoryMatches)) RepositoryMismatch
  else if (not(e.laneMatches)) ChannelMismatch
  else if (not(e.distributionMatches)) DistributionMismatch
  else if (not(e.metadataQualified)) MetadataRollback
  else if (e.paused) RolloutPaused
  else if (not(e.qualifiedWindow)) OutsideQualifiedTime
  else if (e.pairRevoked) PairRevoked
  else if (not(e.securityQualified)) ReleaseBelowSecurity
  else if (e.quarantined) PairQuarantined
  else if (not(e.candidateSignerMatches)) SignerMismatch
  else if (e.exactInstalledIdentity) AlreadyInstalled
  else if (e.candidateVersion <= e.installedVersion) AwaitForwardVersion
  else if (not(e.originAllowed)) BridgeReleaseRequired
  else if (not(e.pairSignerMatches)) SignerMismatch
  else if (not(e.androidQualified)) UnqualifiedDevice
  else if (not(e.installerAuthorized)) InstallerAuthority
  else if (not(e.protocolsCompatible)) ProtocolIncompatible
  else if (not(e.databaseCompatible)) DataIncompatible
  else if (not(e.diskReserve)) DiskReserve
  else if (not(e.safetySupported)) UnsupportedSafetyProfile
  else if (not(e.inCohort)) OutsideCohort
  else PrepareEligible
pure val qualifiedRelease: AdmissionEvidence = {
  repositoryMatches: true, laneMatches: true, distributionMatches: true, paused: false,
  qualifiedWindow: true, pairRevoked: false, securityQualified: true, quarantined: false,
  candidateSignerMatches: true, pairSignerMatches: true, exactInstalledIdentity: false,
  candidateVersion: 2, installedVersion: 1, originAllowed: true, androidQualified: true,
  installerAuthorized: true, protocolsCompatible: true, databaseCompatible: true, diskReserve: true,
  safetySupported: true, inCohort: true, metadataQualified: true
}
pure val eValues = Set(qualifiedRelease, { ...qualifiedRelease, pairRevoked: true },
  { ...qualifiedRelease, paused: true }, { ...qualifiedRelease, laneMatches: false },
  { ...qualifiedRelease, candidateVersion: 1 }, { ...qualifiedRelease, pairSignerMatches: false },
  { ...qualifiedRelease, protocolsCompatible: false }, { ...qualifiedRelease, inCohort: false })
pure def lawPausedOrRevokedNeverPrepares(e: AdmissionEvidence): bool =
  (e.paused or e.pairRevoked or e.quarantined) implies preparationDecision(e) != PrepareEligible
```

## Story: Admit an in-place APK update only for the same signer and its declared qualifications

> As a device owner, I want an app update installed over my app only when
> it is a release from the same signer, is newer, and passed every
> qualification its consumer declares for that exact build, so that an
> update never replaces my app with a foreign or unqualified build.

### An APK update keeps the installed signer, raises the version code and passes every declared qualification for its digest

The candidate is a signed [release APK](../build/manifestAdmission.md)
whose signer equals the installed signer, and its version code is
strictly higher. The installed app's record declares the qualifications
its consumer requires, such as a voice route qualified on the device or
by a cloud provider. The candidate must carry, for each declared name, a
qualification of that name that passed for this exact APK digest; one
it leaves out, one that failed, or one recorded for another digest
blocks it. An empty list of blockers is the only admissible answer.

```quint
import manifestAdmission.* from "../build/manifestAdmission"
type Qualification = { name: str, passed: bool, apkDigest: str }
type ApkCandidate = {
  signed: bool, manifest: ManifestPolicyFacts, signerMatchesInstalled: bool, versionCode: int, apkDigest: str,
  qualifications: List[Qualification]
}
pure def passedFor(c: ApkCandidate, name: str): bool =
  c.qualifications.some(q => q.name == name and q.passed and q.apkDigest == c.apkDigest)
pure def apkUpdateAdmitted(installedVersion: int, declared: Set[str], c: ApkCandidate): bool =
  c.signed and releaseApk(c.manifest, c.signerMatchesInstalled) and c.versionCode > installedVersion and c.apkDigest != "" and
  declared.forall(name => passedFor(c, name))
pure val voiceQualified: Qualification = { name: "voice", passed: true, apkDigest: "apk3" }
pure val releaseCandidate: ApkCandidate = {
  signed: true, manifest: cleanRelease, signerMatchesInstalled: true, versionCode: 3, apkDigest: "apk3", qualifications: List(voiceQualified)
}
pure val cValues = Set(releaseCandidate, { ...releaseCandidate, qualifications: List() },
  { ...releaseCandidate, signerMatchesInstalled: false }, { ...releaseCandidate, manifest: { ...cleanRelease, testMocks: true } },
  { ...releaseCandidate, qualifications: List({ ...voiceQualified, passed: false }) },
  { ...releaseCandidate, qualifications: List({ ...voiceQualified, apkDigest: "apk2" }) })
pure val installedVersionValues = Set(1, 2, 3)
pure val declaredValues = Set(Set(), Set("voice"), Set("voice", "storage"))
pure def lawEveryDeclaredQualificationPassedForThisApk(installedVersion: int, declared: Set[str], c: ApkCandidate): bool =
  declared.exists(name => c.qualifications.every(q => q.name != name or not(q.passed) or q.apkDigest != c.apkDigest)) implies
    not(apkUpdateAdmitted(installedVersion, declared, c))
```
