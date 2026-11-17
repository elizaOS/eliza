# Release signing

A production image is release-signed with the consumer's keys, as the os
package's key manifest lays them out, and the signed output is recorded by
digest. A signed output is not an image boot, an applied update or release
qualification; the [OS update channel](../update/channel.md) consumes the
record, and [manifest admission](../build/manifestAdmission.md) decides
what a release APK is.

## Story: Sign a release image and record exactly what was signed

> As a consumer, I want my production image signed only with my release
> keys and recorded by digest, so that an update channel can prove what it
> ships and no key material ever leaves my key store.

### Every APK, APEX, update and verified-boot key comes from the key manifest; there is no default key

Each certificate found in the target files must map to a key the manifest
names, each chained verified-boot partition must have its own mapping, and
each APEX must have a key. A platform test key, or any other default key,
is refused. A product's descriptor naming another product refuses signing.

```quint
import product.* from "./product"
import manifestAdmission.* from "../build/manifestAdmission"
pure def signingPlanAdmitted(required: Set[str], mapped: Set[str], defaultKeyUsed: bool, descriptorMatches: bool): bool =
  required.subseteq(mapped) and not(defaultKeyUsed) and descriptorMatches
pure val requiredValues = Set(Set("releasekey", "platform"), Set("releasekey", "platform", "avb"))
pure val mappedValues = Set(Set("releasekey", "platform"), Set("releasekey", "platform", "avb"), Set("releasekey"))
pure def lawDefaultKeyIsRefused(required: Set[str], mapped: Set[str], descriptorMatches: bool): bool =
  not(signingPlanAdmitted(required, mapped, true, descriptorMatches))
```

### Key material never enters the source tree or the release record

The key directory must be outside every Git working tree and private to
its owner. Private keys are passed to the release tools only by path, and
hardware-backed signing keeps them in a token whose four options are given
together or not at all. The release record holds public certificates and
digests, never private key bytes or a password.

```quint
type RecordField = TargetFilesDigest | SignedOutputDigest | CertificateDigest | VerifiedBootKeyDigest | PrivateKeyBytes | KeyPassword
pure def keyStoreAdmitted(outsideWorkingTree: bool, ownerOnly: bool, managedOptions: int): bool =
  outsideWorkingTree and ownerOnly and (managedOptions == 0 or managedOptions == 4)
pure def recordFieldsAdmitted(recorded: Set[RecordField]): bool = not(recorded.contains(PrivateKeyBytes)) and not(recorded.contains(KeyPassword))
pure val managedOptionsValues = Set(0, 1, 3, 4)
pure val recordedValues = Set(Set(TargetFilesDigest, SignedOutputDigest, CertificateDigest, VerifiedBootKeyDigest),
  Set(TargetFilesDigest, PrivateKeyBytes), Set(CertificateDigest, KeyPassword))
```

### A release record binds the target files, signed outputs and certificates by digest

The record names the unsigned target files' SHA-256 as given to signing,
the signed target files' and update package's SHA-256, the release
certificate and the verified-boot public key digest. Each must equal what
signing observed, and none may be a placeholder.

```quint
type SigningRecord = { targetFiles: str, signedTargetFiles: str, updatePackage: str, releaseCertificate: str, verifiedBootKey: str }
pure def bound(expected: str, observed: str): bool = not(placeholder(expected)) and expected == observed
pure def recordBindsOutputs(record: SigningRecord, observedRecord: SigningRecord): bool =
  bound(record.targetFiles, observedRecord.targetFiles) and bound(record.signedTargetFiles, observedRecord.signedTargetFiles) and
  bound(record.updatePackage, observedRecord.updatePackage) and bound(record.releaseCertificate, observedRecord.releaseCertificate) and
  bound(record.verifiedBootKey, observedRecord.verifiedBootKey)
pure val signedRecord: SigningRecord = { targetFiles: "t1", signedTargetFiles: "s1", updatePackage: "u1", releaseCertificate: "c1", verifiedBootKey: "k1" }
pure val recordValues = Set(signedRecord, { ...signedRecord, updatePackage: "UNSET" }, { ...signedRecord, releaseCertificate: "c2" })
pure val observedRecordValues = Set(signedRecord, { ...signedRecord, updatePackage: "UNSET" }, { ...signedRecord, signedTargetFiles: "s2" })
pure def lawRecordMatchesWhatWasSigned(record: SigningRecord, observedRecord: SigningRecord): bool =
  recordBindsOutputs(record, observedRecord) implies record == observedRecord
```

### An image APK is a release APK whose digest matches the verification manifest

An APK enters a production image only when it is a release APK (not
debuggable, not a test-mocks build, signed by the consumer's reviewed
release signer) and its digest matches the verification manifest.
Admission is staging evidence only, not a distribution decision.

```quint
pure def imageApkAdmitted(manifest: ManifestPolicyFacts, signerReviewed: bool, digestMatches: bool): bool =
  releaseApk(manifest, signerReviewed) and digestMatches
pure def lawDebuggableApkNeverEntersProduction(manifest: ManifestPolicyFacts, signerReviewed: bool, digestMatches: bool): bool =
  manifest.debuggable implies not(imageApkAdmitted(manifest, signerReviewed, digestMatches))
```

### Release keys are generated and decrypted only into new private directories outside every working tree

The key ceremony generates every key the key manifest names into a new
directory outside the os package's repository and outside any Git working
tree, readable only by its owner. Each private key is written encrypted
under a passphrase of at least 20 characters read from a file only its
owner can read; the unencrypted key exists only in memory and the tools'
pipes, and the public fingerprints are recorded for review. Keys made for
tests are labelled as such and never sign a release. Decryption for
signing writes the plaintext layout the release tools need into another
new owner-only directory, meant to be memory-backed and removed after
signing, and refuses a key whose certificate differs from its recorded
fingerprint or whose private half does not match its public half.

```quint
pure def keyOutputAdmitted(outsideRepository: bool, outsideWorkingTree: bool, newDirectory: bool, ownerOnly: bool): bool =
  outsideRepository and outsideWorkingTree and newDirectory and ownerOnly
pure def passphraseAdmitted(ownerOnly: bool, passphraseLength: int): bool = ownerOnly and passphraseLength >= 20
pure def keyDecryptionAdmitted(outputAdmitted: bool, certificateMatchesFingerprint: bool, privateMatchesPublic: bool): bool =
  outputAdmitted and certificateMatchesFingerprint and privateMatchesPublic
pure def releaseKeysAdmitted(testKeys: bool, decryptionAdmitted: bool): bool = not(testKeys) and decryptionAdmitted
pure val passphraseLengthValues = Set(0, 19, 20, 64)
pure def lawKeysNeverWrittenIntoAWorkingTree(outsideRepository: bool, newDirectory: bool, ownerOnly: bool): bool =
  not(keyOutputAdmitted(outsideRepository, false, newDirectory, ownerOnly))
pure def lawKeysNeverWrittenWhereOthersCanRead(outsideRepository: bool, outsideWorkingTree: bool, newDirectory: bool): bool =
  not(keyOutputAdmitted(outsideRepository, outsideWorkingTree, newDirectory, false))
pure def lawShortOrSharedPassphraseIsRefused(ownerOnly: bool, passphraseLength: int): bool =
  (not(ownerOnly) or passphraseLength < 20) implies not(passphraseAdmitted(ownerOnly, passphraseLength))
pure def lawMismatchedKeyIsNotDecrypted(outputAdmitted: bool, privateMatchesPublic: bool): bool =
  not(keyDecryptionAdmitted(outputAdmitted, false, privateMatchesPublic))
pure def lawTestKeysNeverSignARelease(decryptionAdmitted: bool): bool = not(releaseKeysAdmitted(true, decryptionAdmitted))
```
