# Release keys and signing

A production image is signed with the consumer's own keys and recorded by
digest. The os package ships no key and no key manifest: a consumer passes
its manifest to the key ceremony (`eliza-os keys generate`, then
`keys decrypt` in the signing environment), and its release descriptor and
update channel to `signRelease`. Sources: `generate-release-keys.ts`,
`decrypt-release-keys.ts`, `aosp-release-signing.mjs`,
`aosp-release-record.mjs` and `pixel10a-release.mjs` on develop.

The shell (`src/image/signing.vibe`) reads the manifest, the key directory,
the target files and the signed outputs, runs `openssl` and the platform
release tools, and hashes what they wrote; this library decides what those
facts mean. A signed output is not an image boot, an applied update, a drill
or release qualification: the [operator update](../update/operator.md)
consumes the channel and the record, and [APK admission](./apk.md) decides
what a release APK is. The channel is checked against the
[composed product](./product.md).

## Story: Sign a release only with keys I enrolled

> As a product maker, I want my image signed only with the keys my own
> manifest names and recorded by digest, so that no default, test or
> unmapped key reaches a release and no key material leaves my key store.

### The key set comes only from the consumer manifest, as x509-pk8 or avb-rsa keys of RSA-4096 or ed25519 keys

A manifest has schema version 1 and at least one key; each key has a name
used once. There is no built-in key list, so signing without a manifest has
no key set. A product key may also record its certificate subject, its
certificate digest and that it rotates only through an APK signature scheme
v3 lineage; those are review data the shell parses and this rule does not
weigh.

```quint
import apk.* from "./apk"
import product as Pr from "./product"
type KeyKind = X509Pk8({ bits: int }) | AvbRsa({ bits: int }) | Ed25519
type ManifestKey = { name: str, kind: KeyKind }
pure val rsaKeyBits = 4096
pure def kindAdmitted(kind: KeyKind): bool = match kind { | X509Pk8(k) => k.bits == rsaKeyBits | AvbRsa(k) => k.bits == rsaKeyBits | _ => true }
pure def keyNamedOnce(manifestKeys: List[ManifestKey], name: str): bool = manifestKeys.select(k => k.name == name).length() == 1
pure def manifestAdmitted(schemaVersion: int, manifestKeys: List[ManifestKey]): bool =
  schemaVersion == 1 and manifestKeys.length() > 0 and manifestKeys.every(k => k.name != "" and kindAdmitted(k.kind) and keyNamedOnce(manifestKeys, k.name))
pure val releaseKey: ManifestKey = { name: "releasekey", kind: X509Pk8({ bits: 4096 }) }
pure val weakAvbKey: ManifestKey = { name: "avb", kind: AvbRsa({ bits: 2048 }) }
pure val manifestKeysValues = Set(List(), List(releaseKey), List(releaseKey, { name: "avb", kind: AvbRsa({ bits: 4096 }) }, { name: "manifest", kind: Ed25519 }),
  List(releaseKey, releaseKey), List(releaseKey, weakAvbKey), List({ name: "", kind: Ed25519 }))
pure val schemaVersionValues = Set(0, 1, 2)
pure def lawNoManifestMeansNoKeySet(schemaVersion: int): bool = not(manifestAdmitted(schemaVersion, List()))
pure def lawOneWeakOrRepeatedKeyRefusesTheManifest(schemaVersion: int, manifestKeys: List[ManifestKey]): bool =
  manifestKeys.some(k => not(kindAdmitted(k.kind)) or not(keyNamedOnce(manifestKeys, k.name))) implies not(manifestAdmitted(schemaVersion, manifestKeys))
```

### Keys are generated and decrypted only into a new owner-only directory outside every work tree, under an owner-only passphrase of at least 20 characters

Each private key is encrypted at rest with scrypt and AES-256; the plaintext
key exists only in memory and in the decrypted directory. Keys made with
`--test-keys` are labelled in the directory and in their fingerprints.

```quint
type KeyDirectory = { insideWorkTree: bool, existed: bool, ownerOnly: bool }
type Passphrase = { ownerOnly: bool, characters: int }
pure val minPassphraseCharacters = 20
pure def keyOutputAdmitted(directory: KeyDirectory, passphrase: Passphrase): bool =
  not(directory.insideWorkTree) and not(directory.existed) and directory.ownerOnly and passphrase.ownerOnly and passphrase.characters >= minPassphraseCharacters
pure val privateDirectory: KeyDirectory = { insideWorkTree: false, existed: false, ownerOnly: true }
pure val directoryValues = Set(privateDirectory, { ...privateDirectory, insideWorkTree: true }, { ...privateDirectory, existed: true }, { ...privateDirectory, ownerOnly: false })
pure val passphraseValues = Set({ ownerOnly: true, characters: 20 }, { ownerOnly: true, characters: 19 }, { ownerOnly: false, characters: 64 })
pure def lawKeysNeverLandWhereOthersCanReadThem(directory: KeyDirectory, passphrase: Passphrase): bool =
  (directory.insideWorkTree or directory.existed or not(directory.ownerOnly) or not(passphrase.ownerOnly)) implies not(keyOutputAdmitted(directory, passphrase))
```

### A key is decrypted only when the fingerprints list it and its private half and public identity match what the ceremony recorded

Decryption refuses a key whose private half does not match its certificate
or public key, or whose certificate, AVB public key or SPKI digest differs
from the recorded fingerprint, and an `--only` name the fingerprints do not
list, so a misspelled name never succeeds by decrypting nothing.

```quint
pure def keyDecryptionAdmitted(listed: bool, privateMatchesPublic: bool, publicMatchesFingerprint: bool): bool =
  listed and privateMatchesPublic and publicMatchesFingerprint
pure def lawForeignOrSwappedKeyIsNotDecrypted(listed: bool, privateMatchesPublic: bool, publicMatchesFingerprint: bool): bool =
  keyDecryptionAdmitted(listed, privateMatchesPublic, publicMatchesFingerprint) implies (privateMatchesPublic and publicMatchesFingerprint)
```

### The key directory used for signing is owner-only, outside every work tree, and gets the token-backed signing options all together or not at all

Private keys reach the release tools by path only. Token-backed signing
keeps them in a PKCS#11 token: its four options (token configuration, AVB
signing helper, payload signer and its signature size) are given together,
and the key directory then holds only certificates and public keys.

```quint
pure val managedOptionCount = 4
pure def keyStoreAdmitted(directory: KeyDirectory, managedOptions: int): bool =
  not(directory.insideWorkTree) and directory.ownerOnly and (managedOptions == 0 or managedOptions == managedOptionCount)
pure val managedOptionsValues = Set(0, 1, 3, 4)
pure def lawPartTokenSigningIsRefused(directory: KeyDirectory, managedOptions: int): bool =
  (managedOptions > 0 and managedOptions < managedOptionCount) implies not(keyStoreAdmitted(directory, managedOptions))
```

### An unmapped APK, APEX or verified-boot key refuses signing

Every certificate the target files name for a packaged APK, every key of an
APEX that is re-signed and every chained verified-boot partition must map
to a key the consumer enrolled. Nothing fills a gap with a default: the
shell lists every unmapped name and signs nothing.

```quint
pure def unmappedKeys(required: Set[str], mapped: Set[str]): Set[str] = required.exclude(mapped)
pure def signingPlanAdmitted(required: Set[str], mapped: Set[str]): bool = unmappedKeys(required, mapped).size() == 0
pure val requiredValues = Set(Set(), Set("testkey", "platform"), Set("testkey", "platform", "vbmeta_system"))
pure val mappedValues = Set(Set(), Set("testkey", "platform"), Set("testkey", "platform", "vbmeta_system"), Set("testkey"))
pure def lawAdmittedPlanMapsEveryRequiredKey(required: Set[str], mapped: Set[str]): bool = signingPlanAdmitted(required, mapped) implies required.subseteq(mapped)
```

### Verified boot is signed with SHA256_RSA4096 and chains exactly vbmeta_system and vbmeta_vendor

The release descriptor and the target files must both name this algorithm
and exactly these two chained partitions, each signed with the consumer's
AVB key.

```quint
pure val avbAlgorithm = "SHA256_RSA4096"
pure val chainedBootPartitions: Set[str] = Set("vbmeta_system", "vbmeta_vendor")
pure def bootChainAdmitted(algorithm: str, chained: Set[str]): bool =
  algorithm == avbAlgorithm and chained.subseteq(chainedBootPartitions) and chainedBootPartitions.subseteq(chained)
pure val algorithmValues = Set("SHA256_RSA4096", "SHA256_RSA8192", "")
pure val chainedValues = Set(Set(), Set("vbmeta_system", "vbmeta_vendor"), Set("vbmeta_system"), Set("vbmeta_system", "vbmeta_vendor", "boot"))
pure def lawMissingOrExtraChainIsRefused(algorithm: str, chained: Set[str]): bool =
  bootChainAdmitted(algorithm, chained) implies (chained.contains("vbmeta_system") and chained.contains("vbmeta_vendor") and chained.size() == 2)
```

### The update package is built only after every re-signed APK and APEX verifies with a release certificate

After the target files are signed, each APK and APEX in them that is not
presigned must be listed by the signed metadata, verify, carry only
certificates of the key directory, and for an APEX carry the release payload
key. A remaining test, development or unknown certificate stops the job
before any update package exists.

```quint
type PackageKind = ApkPackage | ApexPackage({ payloadKeyMatches: bool })
type PackageCheck = { presigned: bool, listed: bool, verified: bool, releaseSigned: bool, kind: PackageKind }
pure def payloadAdmitted(kind: PackageKind): bool = match kind { | ApexPackage(a) => a.payloadKeyMatches | _ => true }
pure def packageAdmitted(p: PackageCheck): bool = p.presigned or (p.listed and p.verified and p.releaseSigned and payloadAdmitted(p.kind))
pure def updatePackageAdmitted(packages: List[PackageCheck]): bool = packages.every(p => packageAdmitted(p))
pure val signedApk: PackageCheck = { presigned: false, listed: true, verified: true, releaseSigned: true, kind: ApkPackage }
pure val pValues = Set(signedApk, { ...signedApk, releaseSigned: false }, { ...signedApk, verified: false }, { ...signedApk, listed: false },
  { ...signedApk, kind: ApexPackage({ payloadKeyMatches: false }) }, { ...signedApk, kind: ApexPackage({ payloadKeyMatches: true }) }, { ...signedApk, presigned: true, verified: false })
pure val packagesValues = Set(List(), List(signedApk), List(signedApk, { ...signedApk, releaseSigned: false }), List({ ...signedApk, kind: ApexPackage({ payloadKeyMatches: false }) }))
pure def lawOneTestCertificateStopsTheUpdatePackage(packages: List[PackageCheck]): bool =
  packages.some(p => not(p.presigned) and not(p.releaseSigned)) implies not(updatePackageAdmitted(packages))
pure def lawResignedApexCarriesThePayloadKey(p: PackageCheck): bool =
  (packageAdmitted(p) and not(p.presigned)) implies p.kind != ApexPackage({ payloadKeyMatches: false })
```

### A release descriptor is refused while a field is unset, a signer or AVB key is unpinned, the lock hash differs or the lock is development-only

The shell counts the descriptor's `UNSET` and placeholder values, reads the
application and platform certificate digests and the AVB public key digest
it pins, hashes the source lock file it pins and reads whether that lock is
still development-only. The descriptor has no qualification or acceptance
field that software may set: a descriptor that claims either is refused.

```quint
type DescriptorProblem = FieldUnset | SignerUnpinned | LockHashDiffers | LockDevelopmentOnly | EvidenceClaimed
type ReleaseDescriptor = { unsetFields: int, applicationCertificate: Digest, platformCertificate: Digest, avbPublicKey: Digest,
  lockPinned: Digest, lockRead: Digest, developmentOnly: bool, evidenceClaims: int }
pure def problemWhen(found: bool, problem: DescriptorProblem): Set[DescriptorProblem] = if (found) Set(problem) else Set()
pure def releaseDescriptorProblems(r: ReleaseDescriptor): Set[DescriptorProblem] =
  problemWhen(r.unsetFields > 0, FieldUnset)
    .union(problemWhen(not(isDigest(r.applicationCertificate) and isDigest(r.platformCertificate) and isDigest(r.avbPublicKey)), SignerUnpinned))
    .union(problemWhen(not(digestsMatch(r.lockPinned, r.lockRead)), LockHashDiffers))
    .union(problemWhen(r.developmentOnly, LockDevelopmentOnly)).union(problemWhen(r.evidenceClaims > 0, EvidenceClaimed))
pure def releaseDescriptorAdmitted(r: ReleaseDescriptor): bool = releaseDescriptorProblems(r).size() == 0
pure val reviewedRelease: ReleaseDescriptor = { unsetFields: 0, applicationCertificate: Sha256({ hex: "a1" }), platformCertificate: Sha256({ hex: "c1" }),
  avbPublicKey: Sha256({ hex: "k1" }), lockPinned: Sha256({ hex: "l1" }), lockRead: Sha256({ hex: "l1" }), developmentOnly: false, evidenceClaims: 0 }
pure val rValues = Set(reviewedRelease, { ...reviewedRelease, unsetFields: 2 }, { ...reviewedRelease, lockRead: Sha256({ hex: "l2" }) },
  { ...reviewedRelease, lockPinned: NotADigest, lockRead: NotADigest }, { ...reviewedRelease, developmentOnly: true }, { ...reviewedRelease, evidenceClaims: 1 },
  { ...reviewedRelease, avbPublicKey: NotADigest })
pure def lawAdmittedDescriptorPinsAReleaseLock(r: ReleaseDescriptor): bool =
  releaseDescriptorAdmitted(r) implies (r.lockPinned == r.lockRead and isDigest(r.lockPinned) and isDigest(r.avbPublicKey) and not(r.developmentOnly) and r.evidenceClaims <= 0)
```

### A channel signs only for its product and device, under a pinned OTA certificate and the descriptor's AVB key, with downgrades refused

The channel record also pins the stock factory image the device recovers
to. Its drills and its known-good release are weighed only for
distribution, below.

```quint
type ReleaseChannel = { name: str, product: str, device: str, otaCertificate: Digest, avbPublicKey: Digest, downgradeAllowed: bool, stockFactoryImage: Digest }
type ChannelProblem = ChannelUnnamed | ChannelForAnotherProduct | OtaCertificateUnpinned | AvbKeyDiffers | DowngradeAllowed | StockImageUnpinned
pure def channelProblemWhen(found: bool, problem: ChannelProblem): Set[ChannelProblem] = if (found) Set(problem) else Set()
pure def channelSigningProblems(ch: ReleaseChannel, product: Pr::ProductDescriptor, r: ReleaseDescriptor): Set[ChannelProblem] =
  channelProblemWhen(ch.name == "", ChannelUnnamed)
    .union(channelProblemWhen(ch.product != product.productName or ch.device != Pr::deviceName(product), ChannelForAnotherProduct))
    .union(channelProblemWhen(not(isDigest(ch.otaCertificate)), OtaCertificateUnpinned))
    .union(channelProblemWhen(not(digestsMatch(ch.avbPublicKey, r.avbPublicKey)), AvbKeyDiffers))
    .union(channelProblemWhen(ch.downgradeAllowed, DowngradeAllowed)).union(channelProblemWhen(not(isDigest(ch.stockFactoryImage)), StockImageUnpinned))
pure def channelSigningAdmitted(ch: ReleaseChannel, product: Pr::ProductDescriptor, r: ReleaseDescriptor): bool = channelSigningProblems(ch, product, r).size() == 0
pure val acmeChannel: ReleaseChannel = { name: "stable", product: "acme_stallion", device: "stallion", otaCertificate: Sha256({ hex: "o1" }),
  avbPublicKey: Sha256({ hex: "k1" }), downgradeAllowed: false, stockFactoryImage: Sha256({ hex: "f1" }) }
pure val chValues = Set(acmeChannel, { ...acmeChannel, name: "" }, { ...acmeChannel, device: "vsoc_x86_64_only" }, { ...acmeChannel, otaCertificate: NotADigest },
  { ...acmeChannel, avbPublicKey: Sha256({ hex: "k2" }) }, { ...acmeChannel, downgradeAllowed: true }, { ...acmeChannel, stockFactoryImage: NotADigest })
pure val productValues = Set(Pr::acmePixel, Pr::acmeCuttlefish)
pure def lawAdmittedChannelTrustsOnlyTheProductsKeys(ch: ReleaseChannel, product: Pr::ProductDescriptor, r: ReleaseDescriptor): bool =
  channelSigningAdmitted(ch, product, r) implies
    (ch.device == Pr::deviceName(product) and ch.avbPublicKey == r.avbPublicKey and isDigest(ch.otaCertificate) and not(ch.downgradeAllowed))
```

### The release record binds the target files, the signed outputs and the certificates by digest and carries no key material

The record names the unsigned target files' SHA-256 as given to signing,
the signed target files' and update package's SHA-256, the release
certificate and the verified-boot public key digest. Each must be a real
digest equal to what signing observed. The record type has no private key,
no passphrase and no qualification or acceptance field: a record that
carries one is refused.

```quint
type RecordField = TargetFilesDigest | SignedTargetFilesDigest | UpdatePackageDigest | CertificateDigest | VerifiedBootKeyDigest | PrivateKeyBytes | KeyPassword | QualificationClaim | AcceptanceClaim
pure val boundRecordFields: Set[RecordField] = Set(TargetFilesDigest, SignedTargetFilesDigest, UpdatePackageDigest, CertificateDigest, VerifiedBootKeyDigest)
pure def recordFieldsAdmitted(recorded: Set[RecordField]): bool = boundRecordFields.subseteq(recorded) and recorded.subseteq(boundRecordFields)
type SigningRecord = { targetFiles: Digest, signedTargetFiles: Digest, updatePackage: Digest, releaseCertificate: Digest, verifiedBootKey: Digest }
pure def recordBindsOutputs(record: SigningRecord, observedRecord: SigningRecord): bool =
  digestsMatch(record.targetFiles, observedRecord.targetFiles) and digestsMatch(record.signedTargetFiles, observedRecord.signedTargetFiles) and
  digestsMatch(record.updatePackage, observedRecord.updatePackage) and digestsMatch(record.releaseCertificate, observedRecord.releaseCertificate) and
  digestsMatch(record.verifiedBootKey, observedRecord.verifiedBootKey)
pure val signedRecord: SigningRecord = { targetFiles: Sha256({ hex: "t1" }), signedTargetFiles: Sha256({ hex: "s1" }), updatePackage: Sha256({ hex: "u1" }),
  releaseCertificate: Sha256({ hex: "c1" }), verifiedBootKey: Sha256({ hex: "k1" }) }
pure val recordValues = Set(signedRecord, { ...signedRecord, updatePackage: NotADigest }, { ...signedRecord, releaseCertificate: Sha256({ hex: "c2" }) })
pure val observedRecordValues = Set(signedRecord, { ...signedRecord, updatePackage: NotADigest }, { ...signedRecord, signedTargetFiles: Sha256({ hex: "s2" }) })
pure val recordedValues = Set(boundRecordFields, boundRecordFields.union(Set(PrivateKeyBytes)), boundRecordFields.union(Set(QualificationClaim)), Set(TargetFilesDigest, KeyPassword))
pure def lawRecordMatchesWhatWasSigned(record: SigningRecord, observedRecord: SigningRecord): bool = recordBindsOutputs(record, observedRecord) implies record == observedRecord
pure def lawRecordCarriesNoKeyMaterialOrClaim(recorded: Set[RecordField]): bool = recordFieldsAdmitted(recorded) implies
  (not(recorded.contains(PrivateKeyBytes)) and not(recorded.contains(KeyPassword)) and not(recorded.contains(QualificationClaim)) and not(recorded.contains(AcceptanceClaim)))
```

### A channel is distributable only with a retained known-good release, release keys, and the signed-update, interrupted-update, compatible-rollback and stock-recovery drills all passed

Drill results are recorded from executed drills; nothing in the os package
runs or records them. The known-good release is the one a failed update
recovers to: its build fingerprint and update package digest are pinned.

```quint
type DrillResult = DrillNotRun | DrillFailed | DrillPassed
type Drills = { signedUpdate: DrillResult, interruptedUpdate: DrillResult, compatibleRollback: DrillResult, stockRecovery: DrillResult }
type KnownGood = NoKnownGood | KnownGoodRelease({ buildFingerprint: str, updatePackage: Digest })
pure def knownGoodRetained(knownGood: KnownGood): bool = match knownGood { | KnownGoodRelease(k) => k.buildFingerprint != "" and isDigest(k.updatePackage) | _ => false }
pure def drillsPassed(drills: Drills): bool =
  drills.signedUpdate == DrillPassed and drills.interruptedUpdate == DrillPassed and drills.compatibleRollback == DrillPassed and drills.stockRecovery == DrillPassed
pure def channelDistributable(drills: Drills, knownGood: KnownGood, testKeys: bool): bool = drillsPassed(drills) and knownGoodRetained(knownGood) and not(testKeys)
pure val allDrillsPassed: Drills = { signedUpdate: DrillPassed, interruptedUpdate: DrillPassed, compatibleRollback: DrillPassed, stockRecovery: DrillPassed }
pure val drillsValues = Set(allDrillsPassed, { ...allDrillsPassed, stockRecovery: DrillNotRun }, { ...allDrillsPassed, interruptedUpdate: DrillFailed },
  { signedUpdate: DrillNotRun, interruptedUpdate: DrillNotRun, compatibleRollback: DrillNotRun, stockRecovery: DrillNotRun })
pure val knownGoodValues = Set(NoKnownGood, KnownGoodRelease({ buildFingerprint: "acme/stallion:17/1", updatePackage: Sha256({ hex: "u0" }) }),
  KnownGoodRelease({ buildFingerprint: "", updatePackage: Sha256({ hex: "u0" }) }), KnownGoodRelease({ buildFingerprint: "acme/stallion:17/1", updatePackage: NotADigest }))
pure def lawOneDrillShortIsNotDistributable(drills: Drills, knownGood: KnownGood, testKeys: bool): bool =
  (drills.signedUpdate != DrillPassed or drills.interruptedUpdate != DrillPassed or drills.compatibleRollback != DrillPassed or drills.stockRecovery != DrillPassed)
    implies not(channelDistributable(drills, knownGood, testKeys))
pure def lawTestKeysOrNoRecoveryAreNeverDistributable(drills: Drills, knownGood: KnownGood): bool =
  not(channelDistributable(drills, knownGood, true)) and not(channelDistributable(drills, NoKnownGood, false))
```
