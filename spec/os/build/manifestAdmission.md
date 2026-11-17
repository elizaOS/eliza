# Android distribution manifest and callback admission

A consumer's APK and asset-link tooling read the os package's Android
manifest facts and shared APK distribution assessor. The inspected input
is the merged APK manifest, archive entries and DEX facts. The
[consumer build](./consumerBuild.md) owns artifact publication, and
[native sign-in admission](../../auth/native/receipt.md) owns runtime
receipts.

## Story: Verify the actual APK against the reviewed distribution

> As a consumer, I want the APK I distribute checked from its own merged
> manifest and signer, so that a debug build, a loose callback filter or
> an unexpected certificate never reaches a device.

### Debug-only markers require explicit authorization for a debug candidate

The shared APK assessor takes a normalized host policy and decoded
observations from aapt and archive inspection. It reports every problem.
Only debug mode with an explicit test-mocks switch admits the declared
development fixtures and relaxes the cleartext and test-name checks. All
other builds require `usesCleartextTraffic=0x0`. Every mode requires
`allowBackup=0x0`, a positive decimal version code and a version name
other than the empty or zero value. Release additionally requires a
network security configuration when that policy is active.

Every exported component needs an allowlist entry and any required
permission. The named fixture class exception applies only to debug
test-mocks. Explicit test-mocks do not relax forbidden permissions,
forbidden archive or DEX entries, source-map policy, or mandatory
archive files. A consumer's own policy may additionally check
launcher-only role components and permissions, restricts legacy storage
declarations to API 29 for write and API 32 for read, and requires
optional camera hardware. The asset, signature and source decoders are independent of
this admission.

```quint
type InspectMode = InspectRelease | InspectDebug | InspectUnspecified
type ManifestPolicyFacts = { mode: InspectMode, debuggable: bool, testMocks: bool, developerMarkers: bool, testNameMarkers: bool, cleartextOff: bool, backupOff: bool, releaseNetworkRequired: bool, releaseNetworkPresent: bool, exportPolicyMet: bool, forbiddenContentAbsent: bool, requiredEntriesPresent: bool, versionCodeValid: bool, versionNameValid: bool }
pure def debugFixtureAllowed(mode: InspectMode, testMocks: bool): bool = mode == InspectDebug and testMocks
pure def admitsExport(known: bool, requiresPermission: bool, permissionExact: bool, namedDevelopment: bool, mode: InspectMode, testMocks: bool): bool =
  (namedDevelopment and debugFixtureAllowed(mode, testMocks)) or
  (known and (not(requiresPermission) or permissionExact))
pure def distributionAdmitted(manifest: ManifestPolicyFacts): bool =
  (debugFixtureAllowed(manifest.mode, manifest.testMocks) or
    (not(manifest.developerMarkers or manifest.testNameMarkers) and manifest.cleartextOff)) and
  (manifest.mode != InspectRelease or not(manifest.releaseNetworkRequired) or manifest.releaseNetworkPresent) and
  manifest.backupOff and manifest.exportPolicyMet and manifest.forbiddenContentAbsent and manifest.requiredEntriesPresent and
  manifest.versionCodeValid and manifest.versionNameValid
pure def storagePermissionAdmitted(writePermission: bool, maxSdkPresent: bool, maxSdk: int): bool =
  maxSdkPresent and (if (writePermission) maxSdk <= 29 else maxSdk <= 32)
pure val cleanRelease: ManifestPolicyFacts = { mode: InspectRelease, debuggable: false, testMocks: false, developerMarkers: false, testNameMarkers: false, cleartextOff: true, backupOff: true, releaseNetworkRequired: true, releaseNetworkPresent: true, exportPolicyMet: true, forbiddenContentAbsent: true, requiredEntriesPresent: true, versionCodeValid: true, versionNameValid: true }
pure val manifestValues = Set(cleanRelease, { ...cleanRelease, debuggable: true }, { ...cleanRelease, testMocks: true, developerMarkers: true }, { ...cleanRelease, mode: InspectDebug, testMocks: true, developerMarkers: true, cleartextOff: false })
pure val maxSdkValues = Set(28, 29, 30, 32, 33)
pure def lawReleaseCannotUseDebugException(manifest: ManifestPolicyFacts): bool =
  (manifest.mode == InspectRelease and distributionAdmitted(manifest)) implies not(manifest.developerMarkers) and not(manifest.testNameMarkers) and manifest.cleartextOff
pure def lawProtectedExportNeedsExactPermission(known: bool, permissionExact: bool, namedDevelopment: bool): bool =
  admitsExport(known, true, permissionExact, namedDevelopment, InspectRelease, true) implies known and permissionExact
pure def lawLegacyWriteStopsAfterAndroidTen(maxSdkPresent: bool, maxSdk: int): bool =
  storagePermissionAdmitted(true, maxSdkPresent, maxSdk) implies maxSdkPresent and maxSdk <= 29
```

### A release APK is a non-debuggable release-mode build without test mocks, admitted from its manifest and signed by the reviewed signer

The one release-APK predicate the image and the app updater share: the
merged manifest was inspected in release mode, does not declare the APK
debuggable, is admitted by the distribution policy above and carries no
test mocks, and the APK's signer is the consumer's reviewed release
signer. A debuggable or test-mocks build is never a release APK.

```quint
pure def releaseApk(manifest: ManifestPolicyFacts, signerReviewed: bool): bool =
  manifest.mode == InspectRelease and not(manifest.debuggable) and not(manifest.testMocks) and distributionAdmitted(manifest) and signerReviewed
pure def lawDebugBuildIsNeverARelease(manifest: ManifestPolicyFacts, signerReviewed: bool): bool =
  (manifest.debuggable or manifest.testMocks or manifest.developerMarkers or manifest.mode != InspectRelease) implies not(releaseApk(manifest, signerReviewed))
```

### One exported activity and its own exact filter establish the callback

The common parser collects nested elements and their decoded attributes
by indentation. It keeps element and attribute association so action and
data from different filters cannot combine. The consumer's release
validator finds the expected enabled exported activity under the application.
One child filter needs `autoVerify`, VIEW, DEFAULT and BROWSABLE. Within
that filter, Android combines the data nodes. Accept separate data rows
for scheme, host and path when their distinct sets are exactly HTTPS,
the configured host and the callback path. Reject extra data attributes
including path prefixes or patterns and extra authorities. Independently,
the complete web VIEW summary must equal the product's allowed shape
set. The callback model consumes decoded elements and exact sets. The
Android host's live domain verification requires separate evidence.

```quint
type CallbackFilter = { activity: str, activityEnabled: bool, exported: bool, autoVerify: bool, viewAction: bool, defaultCategory: bool, browsableCategory: bool, schemes: Set[str], hosts: Set[str], paths: Set[str], attributesExact: bool }
pure def exactValues(left: Set[str], right: Set[str]): bool = left.subseteq(right) and right.subseteq(left)
pure def callbackFilterMatches(row: CallbackFilter, activityName: str, hostName: str, callbackPath: str): bool =
  row.activity == activityName and row.activityEnabled and row.exported and row.autoVerify and
  row.viewAction and row.defaultCategory and row.browsableCategory and row.attributesExact and
  exactValues(row.schemes, Set("https")) and exactValues(row.hosts, Set(hostName)) and exactValues(row.paths, Set(callbackPath))
pure def manifestHasCallback(filters: List[CallbackFilter], activityName: str, hostName: str, callbackPath: str): bool =
  filters.some(row => callbackFilterMatches(row, activityName, hostName, callbackPath))
pure def allowedWebFilters(actual: Set[str], allowed: Set[str]): bool = exactValues(actual, allowed)
pure val exactCallback: CallbackFilter = { activity: "MainActivity", activityEnabled: true, exported: true, autoVerify: true, viewAction: true, defaultCategory: true, browsableCategory: true, schemes: Set("https"), hosts: Set("login.example"), paths: Set("/callback"), attributesExact: true }
pure val rowValues = Set(exactCallback, { ...exactCallback, hosts: Set("login.example", "other.example") }, { ...exactCallback, attributesExact: false })
pure val filtersValues = Set(List(), List(exactCallback), List({ ...exactCallback, hosts: Set("other.example") }, { ...exactCallback, autoVerify: false }))
pure val activityNameValues = Set("MainActivity", "OtherActivity")
pure val hostNameValues = Set("login.example", "other.example")
pure val callbackPathValues = Set("/callback", "/other")
pure def lawBroaderDataCannotAuthorize(row: CallbackFilter, activityName: str, hostName: str, callbackPath: str): bool =
  (not(row.attributesExact) or not(exactValues(row.hosts, Set(hostName))) or not(exactValues(row.paths, Set(callbackPath)))) implies
  not(callbackFilterMatches(row, activityName, hostName, callbackPath))
pure val separateFilterValues = rowValues
pure val unverifiedFilterValues = Set({ ...exactCallback, autoVerify: false }, exactCallback)
pure def lawDifferentFilterFactsCannotCombine(separateFilter: CallbackFilter, unverifiedFilter: CallbackFilter, activityName: str, hostName: str, callbackPath: str): bool =
  (not(exactValues(separateFilter.hosts, Set(hostName))) and not(unverifiedFilter.autoVerify)) implies
  not(manifestHasCallback(List(separateFilter, unverifiedFilter), activityName, hostName, callbackPath))
pure def lawUnexpectedWebShapeFails(actual: Set[str], allowed: Set[str]): bool = not(actual.subseteq(allowed)) implies not(allowedWebFilters(actual, allowed))
```

### An APK signer observation identifies exactly one certificate for the requested API

The shared reader asks apksigner to verify and print certificate
evidence. When the caller supplies an API level it sets the exact same
minimum and maximum. The decoder recognizes legacy numbered and rotated
inclusive-range rows with a 64-hex SHA-256 digest. Legacy reporting
requires exactly one row numbered one. A mixture of report forms, an
empty report and multiple legacy rows are refused. Rotated reporting
requires a positive integer API and exactly one applicable row.
The digest is returned in lowercase. The model projects the decoded
row counts and selected digest evidence. APK signature validity itself
comes from the apksigner port.

```quint
type SignerResult = LegacyCertificate | RotatedCertificate | SignerRefused
pure def signerResult(legacyCount: int, firstSigner: bool, rotatedCount: int, apiSpecified: bool, api: int, matchingRanges: int): SignerResult =
  if (legacyCount == 1 and firstSigner and rotatedCount == 0) LegacyCertificate
  else if (legacyCount == 0 and rotatedCount > 0 and apiSpecified and api > 0 and matchingRanges == 1) RotatedCertificate
  else SignerRefused
pure def containsAndroidApi(minApi: int, maxApi: int, api: int): bool = minApi <= api and api <= maxApi
pure val apiValues = Set(0, 1, 23, 24, 32, 33, 34)
pure def lawMixedApkSignerFormsRefused(legacyCount: int, firstSigner: bool, rotatedCount: int, apiSpecified: bool, api: int, matchingRanges: int): bool =
  (legacyCount > 0 and rotatedCount > 0) implies signerResult(legacyCount, firstSigner, rotatedCount, apiSpecified, api, matchingRanges) == SignerRefused
pure def lawRangeEndpointsAreInclusive(minApi: int, maxApi: int): bool =
  minApi <= maxApi implies containsAndroidApi(minApi, maxApi, minApi) and containsAndroidApi(minApi, maxApi, maxApi)
```
