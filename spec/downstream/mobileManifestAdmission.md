# Android distribution manifest and callback admission

AlphaPhone `scripts/apk.ts` and `scripts/render-assetlinks.ts` consume
`packages/app/scripts/lib/android-manifest-facts.mjs` and the shared
`packages/app/scripts/mobile/artifact-inspection/apk-distribution.mjs`
at Eliza `c518127a025ab173874af9c7d304f26b25213b0d`. The inspected input
is the merged APK manifest, archive entries and DEX facts. The
[build model](./mobileBuild.md) owns artifact publication, and
[native sign-in admission](./nativeSignIn.md) owns runtime receipts.

## Story: Verify the actual APK against the reviewed distribution

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
archive files. Alpha's product policy additionally checks launcher-only
role components and permissions, restricts legacy storage declarations
to API 29 for write and API 32 for read, and requires optional camera
hardware. The asset, signature and source decoders are independent of
this admission.

```quint
type InspectMode = InspectRelease | InspectDebug | InspectUnspecified
type ManifestPolicyFacts = { mode: InspectMode, testMocks: bool, developerMarkers: bool, testNameMarkers: bool, cleartextOff: bool, backupOff: bool, releaseNetworkRequired: bool, releaseNetworkPresent: bool, exportPolicyMet: bool, forbiddenContentAbsent: bool, requiredEntriesPresent: bool, versionCodeValid: bool, versionNameValid: bool }
pure def debugFixtureAllowed(mode: InspectMode, testMocks: bool): bool = mode == InspectDebug and testMocks
pure def admitsExport(known: bool, requiresPermission: bool, permissionExact: bool, namedDevelopment: bool, mode: InspectMode, testMocks: bool): bool =
  (namedDevelopment and debugFixtureAllowed(mode, testMocks)) or
  (known and (not(requiresPermission) or permissionExact))
pure def distributionAdmitted(candidate: ManifestPolicyFacts): bool =
  (debugFixtureAllowed(candidate.mode, candidate.testMocks) or
    (not(candidate.developerMarkers or candidate.testNameMarkers) and candidate.cleartextOff)) and
  (candidate.mode != InspectRelease or not(candidate.releaseNetworkRequired) or candidate.releaseNetworkPresent) and
  candidate.backupOff and candidate.exportPolicyMet and candidate.forbiddenContentAbsent and candidate.requiredEntriesPresent and
  candidate.versionCodeValid and candidate.versionNameValid
pure def storagePermissionAdmitted(writePermission: bool, maxSdkPresent: bool, maxSdk: int): bool =
  maxSdkPresent and (if (writePermission) maxSdk <= 29 else maxSdk <= 32)
pure val cleanRelease: ManifestPolicyFacts = { mode: InspectRelease, testMocks: false, developerMarkers: false, testNameMarkers: false, cleartextOff: true, backupOff: true, releaseNetworkRequired: true, releaseNetworkPresent: true, exportPolicyMet: true, forbiddenContentAbsent: true, requiredEntriesPresent: true, versionCodeValid: true, versionNameValid: true }
pure val candidateValues = Set(cleanRelease, { ...cleanRelease, testMocks: true, developerMarkers: true }, { ...cleanRelease, mode: InspectDebug, testMocks: true, developerMarkers: true, cleartextOff: false })
pure val maxSdkValues = Set(28, 29, 30, 32, 33)
pure def lawReleaseCannotUseDebugException(candidate: ManifestPolicyFacts): bool =
  (candidate.mode == InspectRelease and distributionAdmitted(candidate)) implies not(candidate.developerMarkers) and not(candidate.testNameMarkers) and candidate.cleartextOff
pure def lawProtectedExportNeedsExactPermission(known: bool, permissionExact: bool, namedDevelopment: bool): bool =
  admitsExport(known, true, permissionExact, namedDevelopment, InspectRelease, true) implies known and permissionExact
pure def lawLegacyWriteStopsAfterAndroidTen(maxSdkPresent: bool, maxSdk: int): bool =
  storagePermissionAdmitted(true, maxSdkPresent, maxSdk) implies maxSdkPresent and maxSdk <= 29
```

### One exported activity and its own exact filter establish the callback

The common parser collects nested elements and their decoded attributes
by indentation. It keeps element and attribute association so action and
data from different filters cannot combine. The Alpha release validator
finds the expected enabled exported activity under the application.
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
pure def lawRotationRequiresOneMatchingRange(legacyCount: int, firstSigner: bool, rotatedCount: int, apiSpecified: bool, api: int, matchingRanges: int): bool =
  signerResult(legacyCount, firstSigner, rotatedCount, apiSpecified, api, matchingRanges) == RotatedCertificate implies
  legacyCount == 0 and rotatedCount > 0 and apiSpecified and api > 0 and matchingRanges == 1
pure def lawRangeEndpointsAreInclusive(minApi: int, maxApi: int): bool =
  minApi <= maxApi implies containsAndroidApi(minApi, maxApi, minApi) and containsAndroidApi(minApi, maxApi, maxApi)
```
