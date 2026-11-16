# Release signing

A production image is release-signed on the image host after the
production build. The key layout is the os package's key manifest. Before
anything runs, signing reads the unsigned target files' build information,
APK certificates and APEX keys, and refuses a certificate it does not map
to a release key, a chained verified-boot partition without its own key,
or a missing APEX key. It then signs, verifies that every non-presigned
APK and APEX carries a release certificate, builds the update package and
writes the release record. A signed output is not an image boot, an
applied update, a rollback drill or release qualification; the
[OS update channel](../update/channel.md) consumes the record.

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
pure def signingPlanAdmitted(required: Set[str], mapped: Set[str], defaultKeyUsed: bool, descriptorMatches: bool): bool =
  required.subseteq(mapped) and not(defaultKeyUsed) and descriptorMatches
pure val requiredValues = Set(Set("releasekey", "platform"), Set("releasekey", "platform", "avb"))
pure val mappedValues = Set(Set("releasekey", "platform"), Set("releasekey", "platform", "avb"), Set("releasekey"))
pure def lawEveryRequiredKeyIsMapped(required: Set[str], mapped: Set[str], defaultKeyUsed: bool, descriptorMatches: bool): bool =
  signingPlanAdmitted(required, mapped, defaultKeyUsed, descriptorMatches) implies required.subseteq(mapped) and not(defaultKeyUsed)
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
pure def lawKeysStayOutOfTheTree(outsideWorkingTree: bool, ownerOnly: bool, managedOptions: int): bool =
  keyStoreAdmitted(outsideWorkingTree, ownerOnly, managedOptions) implies outsideWorkingTree and ownerOnly and managedOptions != 1 and managedOptions != 3
pure def lawRecordHoldsNoSecret(recorded: Set[RecordField]): bool =
  recordFieldsAdmitted(recorded) implies not(recorded.contains(PrivateKeyBytes) or recorded.contains(KeyPassword))
```

### A release record binds the target files, signed outputs and certificates by digest

The record names the unsigned target files' SHA-256 as given to signing,
the signed target files' and update package's SHA-256, the release
certificate and the verified-boot public key digest. Each must equal what
signing observed and none may be empty or unset.

```quint
type SigningRecord = { targetFiles: str, signedTargetFiles: str, updatePackage: str, releaseCertificate: str, verifiedBootKey: str }
pure def bound(expected: str, observed: str): bool = expected != "" and expected != "UNSET" and expected == observed
pure def recordBindsOutputs(r: SigningRecord, o: SigningRecord): bool =
  bound(r.targetFiles, o.targetFiles) and bound(r.signedTargetFiles, o.signedTargetFiles) and bound(r.updatePackage, o.updatePackage) and
  bound(r.releaseCertificate, o.releaseCertificate) and bound(r.verifiedBootKey, o.verifiedBootKey)
pure val signedRecord: SigningRecord = { targetFiles: "t1", signedTargetFiles: "s1", updatePackage: "u1", releaseCertificate: "c1", verifiedBootKey: "k1" }
pure val rValues = Set(signedRecord, { ...signedRecord, updatePackage: "UNSET" }, { ...signedRecord, releaseCertificate: "c2" })
pure val oValues = Set(signedRecord, { ...signedRecord, updatePackage: "UNSET" }, { ...signedRecord, signedTargetFiles: "s2" })
pure def lawRecordMatchesWhatWasSigned(r: SigningRecord, o: SigningRecord): bool =
  recordBindsOutputs(r, o) implies r == o and r.updatePackage != "UNSET" and r.releaseCertificate != ""
```

### A debuggable APK is refused for a production image

An APK enters a production image only when its manifest is not
debuggable, it is not a test-mocks build, its signer is the consumer's
reviewed release signer and its digest matches the verification manifest.
Admission is staging evidence only, not a distribution decision.

```quint
pure def imageApkAdmitted(debuggable: bool, testMocks: bool, signerReviewed: bool, digestMatches: bool): bool =
  not(debuggable) and not(testMocks) and signerReviewed and digestMatches
pure def lawDebuggableApkNeverEntersProduction(testMocks: bool, signerReviewed: bool, digestMatches: bool): bool =
  not(imageApkAdmitted(true, testMocks, signerReviewed, digestMatches))
```
