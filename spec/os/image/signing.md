# Release keys and signing

A production image is signed with the consumer's own keys and recorded by
digest. The os package ships no key and no key manifest: a consumer passes
its manifest to the key ceremony (`eliza-os keys generate`, then
`keys decrypt` in the signing environment) and its release descriptor and
update channel to `signRelease`. Sources: `generate-release-keys.ts`,
`decrypt-release-keys.ts`, `aosp-release-signing.mjs`,
`aosp-release-record.mjs` and `pixel10a-release.mjs` on develop.

The shell (`src/image/signing.vibe`) reads the manifest, the key directory,
the target files and the signed outputs, runs `openssl` and the platform
release tools, and hashes what they wrote; this library decides what those
facts mean. A signed output is not an image boot, an applied update, a drill
or release qualification: the [operator update](../update/operator.md)
consumes the record, and [APK admission](./apk.md) decides what a release APK
is.

## Story: Sign a release only with keys I enrolled

> As a product maker, I want my image signed only with the keys my own
> manifest names and recorded by digest, so that no default, test or
> unmapped key reaches a release and no key material leaves my key store.

### The key set comes only from the consumer manifest, as x509-pk8 or avb-rsa keys of RSA-4096 or ed25519 keys

A manifest has schema version 1 and at least one key; each key has a name
used once, one of the three kinds, and for an RSA kind exactly 4096 bits.
There is no built-in key list, so signing without a manifest has no key
set. A product key may also record its certificate subject, its certificate
digest and that it rotates only through an APK signature scheme v3 lineage;
those are review data the shell parses and this rule does not weigh.

```quint
import apk as Apk from "./apk"
type KeyKind = X509Pk8 | AvbRsa | Ed25519
type ManifestKey = { name: str, kind: KeyKind, bits: int }
pure val rsaKeyBits = 4096
pure def keyAdmitted(key: ManifestKey): bool = key.name != "" and (key.kind == Ed25519 or key.bits == rsaKeyBits)
pure def keyNamedOnce(keys: List[ManifestKey], name: str): bool = keys.select(k => k.name == name).length() == 1
pure def manifestAdmitted(schemaVersion: int, keys: List[ManifestKey]): bool =
  schemaVersion == 1 and keys.length() > 0 and keys.every(k => keyAdmitted(k) and keyNamedOnce(keys, k.name))
pure val releaseKey: ManifestKey = { name: "releasekey", kind: X509Pk8, bits: 4096 }
pure val keysValues = Set(List(), List(releaseKey), List(releaseKey, { name: "avb", kind: AvbRsa, bits: 4096 }, { name: "manifest", kind: Ed25519, bits: 0 }),
  List(releaseKey, releaseKey), List({ name: "avb", kind: AvbRsa, bits: 2048 }), List({ name: "", kind: Ed25519, bits: 0 }))
pure val schemaVersionValues = Set(0, 1, 2)
pure def lawNoManifestMeansNoKeySet(schemaVersion: int): bool = not(manifestAdmitted(schemaVersion, List()))
pure def lawWeakRsaKeyIsRefused(key: ManifestKey): bool = (key.kind != Ed25519 and key.bits != rsaKeyBits) implies not(keyAdmitted(key))
pure val keyValues = Set(releaseKey, { name: "avb", kind: AvbRsa, bits: 2048 }, { name: "manifest", kind: Ed25519, bits: 0 }, { name: "", kind: X509Pk8, bits: 4096 })
```

### Private keys are written only into a new directory outside every work tree, under a private passphrase of at least 20 characters

Generation and decryption each write into a directory that does not exist
yet, that no Git work tree encloses and that the shell creates readable by
its owner only. Each private key is encrypted at rest with scrypt and
AES-256 under a passphrase read from a file only its owner can read; the
plaintext key exists only in memory and in the tool's own private input.
Keys made with `--test-keys` are labelled in the directory and in their
fingerprints.

```quint
pure val minPassphraseLength = 20
pure def keyOutputAdmitted(outsideWorkTree: bool, newDirectory: bool): bool = outsideWorkTree and newDirectory
pure def passphraseAdmitted(ownerOnly: bool, passphraseLength: int): bool = ownerOnly and passphraseLength >= minPassphraseLength
pure val passphraseLengthValues = Set(0, 19, 20, 64)
pure def lawKeysNeverWrittenIntoAWorkTree(newDirectory: bool): bool = not(keyOutputAdmitted(false, newDirectory))
pure def lawKeysNeverWrittenOverAnExistingDirectory(outsideWorkTree: bool): bool = not(keyOutputAdmitted(outsideWorkTree, false))
pure def lawShortOrSharedPassphraseIsRefused(ownerOnly: bool, passphraseLength: int): bool =
  (not(ownerOnly) or passphraseLength < minPassphraseLength) implies not(passphraseAdmitted(ownerOnly, passphraseLength))
```

### A key is decrypted only when its private half and its public identity match what the ceremony recorded

Decryption writes the plaintext layout the release tools need. It refuses a
key whose private half does not match its certificate or public key, or
whose certificate, AVB public key or SPKI digest differs from the recorded
fingerprint, and it refuses an `--only` name the fingerprints do not list.

```quint
pure def keyDecryptionAdmitted(listed: bool, privateMatchesPublic: bool, publicMatchesFingerprint: bool): bool =
  listed and privateMatchesPublic and publicMatchesFingerprint
pure def lawMismatchedKeyIsNotDecrypted(listed: bool, privateMatchesPublic: bool): bool = not(keyDecryptionAdmitted(listed, privateMatchesPublic, false))
pure def lawForeignPrivateKeyIsNotDecrypted(listed: bool, publicMatchesFingerprint: bool): bool = not(keyDecryptionAdmitted(listed, false, publicMatchesFingerprint))
```

### The key directory used for signing is private, outside every work tree, and holds managed-signing options all together or not at all

Private keys reach the release tools by path only. Hardware-backed signing
keeps them in a PKCS#11 token: its four options (token configuration, AVB
signing helper, payload signer and its signature size) are given together
or not at all, and the key directory then holds only certificates and
public keys.

```quint
pure val managedOptionCount = 4
pure def keyStoreAdmitted(outsideWorkTree: bool, ownerOnly: bool, managedOptions: int): bool =
  outsideWorkTree and ownerOnly and (managedOptions == 0 or managedOptions == managedOptionCount)
pure val managedOptionsValues = Set(0, 1, 3, 4)
pure def lawPartManagedSigningIsRefused(outsideWorkTree: bool, ownerOnly: bool, managedOptions: int): bool =
  (managedOptions > 0 and managedOptions < managedOptionCount) implies not(keyStoreAdmitted(outsideWorkTree, ownerOnly, managedOptions))
```

### An unmapped APK, APEX or verified-boot key refuses signing

Every certificate the target files name for a packaged APK, every key of an
APEX that is re-signed and every chained verified-boot partition must map
to a key the consumer enrolled. Nothing fills a gap: the shell lists every
unmapped name and signs nothing.

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
pure val algorithmValues = Set("SHA256_RSA4096", "SHA256_RSA2048", "")
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
type PackageCheck = { presigned: bool, listed: bool, verified: bool, releaseSigned: bool, apex: bool, payloadKeyMatches: bool }
pure def packageAdmitted(p: PackageCheck): bool = p.presigned or (p.listed and p.verified and p.releaseSigned and (p.apex implies p.payloadKeyMatches))
pure def updatePackageAdmitted(packages: List[PackageCheck]): bool = packages.every(p => packageAdmitted(p))
pure val signedApk: PackageCheck = { presigned: false, listed: true, verified: true, releaseSigned: true, apex: false, payloadKeyMatches: false }
pure val pValues = Set(signedApk, { ...signedApk, releaseSigned: false }, { ...signedApk, verified: false }, { ...signedApk, listed: false },
  { ...signedApk, apex: true }, { ...signedApk, apex: true, payloadKeyMatches: true }, { ...signedApk, presigned: true, verified: false })
pure val packagesValues = Set(List(), List(signedApk), List(signedApk, { ...signedApk, releaseSigned: false }), List({ ...signedApk, apex: true }))
pure def lawRemainingTestCertificateIsRefused(p: PackageCheck): bool = (not(p.presigned) and not(p.releaseSigned)) implies not(packageAdmitted(p))
pure def lawResignedApexCarriesThePayloadKey(p: PackageCheck): bool = (packageAdmitted(p) and p.apex and not(p.presigned)) implies p.payloadKeyMatches
```

### A release descriptor is refused while a field is unset, the lock hash differs or the lock is development-only

The shell counts the descriptor's `UNSET` and placeholder values, hashes the
source lock file the descriptor pins and reads whether that lock is still
development-only. The descriptor has no qualification or acceptance field
that software may set: a descriptor that claims either is counted as a
claim and refused.

```quint
type DescriptorProblem = FieldUnset | LockHashDiffers | LockDevelopmentOnly | EvidenceClaimed
type DescriptorFacts = { unsetFields: int, lockPinned: Apk::Digest, lockRead: Apk::Digest, developmentOnly: bool, evidenceClaims: int }
pure def problemWhen(found: bool, problem: DescriptorProblem): Set[DescriptorProblem] = if (found) Set(problem) else Set()
pure def releaseDescriptorRefusals(d: DescriptorFacts): Set[DescriptorProblem] =
  problemWhen(d.unsetFields > 0, FieldUnset).union(problemWhen(not(Apk::digestsMatch(d.lockPinned, d.lockRead)), LockHashDiffers))
    .union(problemWhen(d.developmentOnly, LockDevelopmentOnly)).union(problemWhen(d.evidenceClaims > 0, EvidenceClaimed))
pure def releaseDescriptorAdmitted(d: DescriptorFacts): bool = releaseDescriptorRefusals(d).size() == 0
pure val reviewedDescriptor: DescriptorFacts = { unsetFields: 0, lockPinned: Apk::Sha256({ hex: "a1" }), lockRead: Apk::Sha256({ hex: "a1" }), developmentOnly: false, evidenceClaims: 0 }
pure val dValues = Set(reviewedDescriptor, { ...reviewedDescriptor, unsetFields: 2 }, { ...reviewedDescriptor, lockRead: Apk::Sha256({ hex: "c1" }) },
  { ...reviewedDescriptor, lockPinned: Apk::NotADigest, lockRead: Apk::NotADigest }, { ...reviewedDescriptor, developmentOnly: true }, { ...reviewedDescriptor, evidenceClaims: 1 })
pure def lawAdmittedDescriptorPinsAReleaseLock(d: DescriptorFacts): bool =
  releaseDescriptorAdmitted(d) implies (d.unsetFields <= 0 and d.lockPinned == d.lockRead and Apk::isDigest(d.lockPinned) and not(d.developmentOnly) and d.evidenceClaims <= 0)
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
type SigningRecord = { targetFiles: Apk::Digest, signedTargetFiles: Apk::Digest, updatePackage: Apk::Digest, releaseCertificate: Apk::Digest, verifiedBootKey: Apk::Digest }
pure def recordBindsOutputs(record: SigningRecord, observedRecord: SigningRecord): bool =
  Apk::digestsMatch(record.targetFiles, observedRecord.targetFiles) and Apk::digestsMatch(record.signedTargetFiles, observedRecord.signedTargetFiles) and
  Apk::digestsMatch(record.updatePackage, observedRecord.updatePackage) and Apk::digestsMatch(record.releaseCertificate, observedRecord.releaseCertificate) and
  Apk::digestsMatch(record.verifiedBootKey, observedRecord.verifiedBootKey)
pure val signedRecord: SigningRecord = { targetFiles: Apk::Sha256({ hex: "t1" }), signedTargetFiles: Apk::Sha256({ hex: "s1" }), updatePackage: Apk::Sha256({ hex: "u1" }),
  releaseCertificate: Apk::Sha256({ hex: "c1" }), verifiedBootKey: Apk::Sha256({ hex: "k1" }) }
pure val recordValues = Set(signedRecord, { ...signedRecord, updatePackage: Apk::NotADigest }, { ...signedRecord, releaseCertificate: Apk::Sha256({ hex: "c2" }) })
pure val observedRecordValues = Set(signedRecord, { ...signedRecord, updatePackage: Apk::NotADigest }, { ...signedRecord, signedTargetFiles: Apk::Sha256({ hex: "s2" }) })
pure val recordedValues = Set(Set(TargetFilesDigest, SignedTargetFilesDigest, UpdatePackageDigest, CertificateDigest, VerifiedBootKeyDigest),
  Set(TargetFilesDigest, SignedTargetFilesDigest, UpdatePackageDigest, CertificateDigest, VerifiedBootKeyDigest, PrivateKeyBytes),
  Set(TargetFilesDigest, SignedTargetFilesDigest, UpdatePackageDigest, CertificateDigest, VerifiedBootKeyDigest, QualificationClaim), Set(TargetFilesDigest, KeyPassword))
pure def lawRecordMatchesWhatWasSigned(record: SigningRecord, observedRecord: SigningRecord): bool = recordBindsOutputs(record, observedRecord) implies record == observedRecord
pure def lawRecordCarriesNoKeyMaterialOrClaim(recorded: Set[RecordField]): bool = recordFieldsAdmitted(recorded) implies
  (not(recorded.contains(PrivateKeyBytes)) and not(recorded.contains(KeyPassword)) and not(recorded.contains(QualificationClaim)) and not(recorded.contains(AcceptanceClaim)))
```

### A channel is distributable only when the signed-update, interrupted-update, compatible-rollback and stock-recovery drills all passed

Drill results are recorded from executed drills; nothing in the os package
runs or records them. A signed release is also not distributable while the
channel retains no known-good release to recover to, or when its keys were
made for tests.

```quint
type DrillResult = DrillNotRun | DrillFailed | DrillPassed
type Drills = { signedUpdate: DrillResult, interruptedUpdate: DrillResult, compatibleRollback: DrillResult, stockRecovery: DrillResult }
pure def drillsPassed(drills: Drills): bool =
  drills.signedUpdate == DrillPassed and drills.interruptedUpdate == DrillPassed and drills.compatibleRollback == DrillPassed and drills.stockRecovery == DrillPassed
pure def channelDistributable(drills: Drills, knownGoodRetained: bool, testKeys: bool): bool = drillsPassed(drills) and knownGoodRetained and not(testKeys)
pure val allDrillsPassed: Drills = { signedUpdate: DrillPassed, interruptedUpdate: DrillPassed, compatibleRollback: DrillPassed, stockRecovery: DrillPassed }
pure val drillsValues = Set(allDrillsPassed, { ...allDrillsPassed, stockRecovery: DrillNotRun }, { ...allDrillsPassed, interruptedUpdate: DrillFailed },
  { signedUpdate: DrillNotRun, interruptedUpdate: DrillNotRun, compatibleRollback: DrillNotRun, stockRecovery: DrillNotRun })
pure def lawOneDrillShortIsNotDistributable(drills: Drills, knownGoodRetained: bool, testKeys: bool): bool =
  (drills.signedUpdate != DrillPassed or drills.interruptedUpdate != DrillPassed or drills.compatibleRollback != DrillPassed or drills.stockRecovery != DrillPassed)
    implies not(channelDistributable(drills, knownGoodRetained, testKeys))
pure def lawTestKeysAreNeverDistributable(drills: Drills, knownGoodRetained: bool): bool = not(channelDistributable(drills, knownGoodRetained, true))
```
