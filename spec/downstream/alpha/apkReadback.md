# Alpha APK replacement and data readback

An AlphaPhone operator verifies an admitted in-place APK replacement
against package facts and app data read before and after installation.
At AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43`,
`scripts/pilot-update.ts` calls
`packages/os/scripts/android/apk-release-record.mjs` from its Eliza pin
`c518127a025ab173874af9c7d304f26b25213b0d`.
The [native installation journal](../mobileInstall.md) owns installer
session and health receipts. The [renderer update gate](./updateGate.md)
owns editor and activation coordination. This spec checks one controlled
operator replacement after candidate admission.

The shell binds observations to the selected package and Android user,
checks that the caller's required HOME is held, and checks app process
quiescence before installation and around the readbacks. The separate,
read-only integrity process can answer data queries during these checks.
HOME restoration and agent startup have separate outcomes. They cannot
certify the installed artifact or its data.

## Story: Verify which APK Android installed and what app data survived

> As an operator, I want the install record to show the exact APK Android
> installed and what was actually read back, so a missing inspection is
> visible and an update cannot silently lose my app's data.

### The observed APK matches the candidate and the available install identity remains the same

The observed APK digest and version must equal the admitted candidate's.
The observed Android app UID and first-install time must equal their
pre-install values. The source's equality allows both values of an
identity field to be missing. Such a pass establishes only the package
facts that were present. A reviewed signer migration requires a complete
pre-install identity. The shell represents a missing field by an empty
reference, and decodes actual digests and package metadata before comparing.

```quint
type PackageReadback = { candidateDigest: str, installedDigest: str, candidateVersion: int, installedVersion: int,
  priorUid: str, installedUid: str, priorInstallTime: str, installedInstallTime: str }
pure def installedCandidateMatches(packageRead: PackageReadback): bool =
  packageRead.candidateDigest == packageRead.installedDigest and packageRead.candidateVersion == packageRead.installedVersion
pure def sameInstallIdentity(packageRead: PackageReadback): bool =
  packageRead.priorUid == packageRead.installedUid and packageRead.priorInstallTime == packageRead.installedInstallTime
pure def installIdentityObserved(packageRead: PackageReadback): bool =
  packageRead.priorUid != "" and packageRead.priorInstallTime != "" and sameInstallIdentity(packageRead)
pure def packageReadbackMatches(packageRead: PackageReadback): bool =
  installedCandidateMatches(packageRead) and sameInstallIdentity(packageRead)
pure val matchingPackage: PackageReadback = { candidateDigest: "apk-a", installedDigest: "apk-a", candidateVersion: 2, installedVersion: 2,
  priorUid: "uid-a", installedUid: "uid-a", priorInstallTime: "time-a", installedInstallTime: "time-a" }
pure val packageReadValues = Set(matchingPackage, { ...matchingPackage, installedDigest: "apk-b" },
  { ...matchingPackage, installedVersion: 3 }, { ...matchingPackage, installedUid: "uid-b" },
  { ...matchingPackage, installedInstallTime: "time-b" }, { ...matchingPackage, priorUid: "", installedUid: "" })
pure def lawMatchingPackageUsesExactCandidate(packageRead: PackageReadback): bool =
  packageReadbackMatches(packageRead) implies packageRead.candidateDigest == packageRead.installedDigest and
    packageRead.candidateVersion == packageRead.installedVersion
pure def lawMissingUidCannotProveIdentity(packageRead: PackageReadback): bool =
  packageRead.priorUid == "" implies not(installIdentityObserved(packageRead))
```

### A missing readback remains distinct from a failed or truncated inspection

The inspector tries Android's private file walk first. Only explicit
`run-as` unavailability selects the integrity provider. A successful
walk needs its zero exit marker. A failed walk aborts the comparison.
A missing integrity provider leaves data readback unavailable. A refused
or failed export aborts, and a returned export needs valid rows and its
end row with an exact file count. The parser checks the count and digest
field shape. That check establishes stream completeness, with access
controlled by the device's integrity-provider permission.

```quint
type InventoryResult = InventoryAvailable | InventoryUnavailable | InventoryFailed
type ReadbackMethod = PrivateFileWalk | IntegrityProvider
type ExportEvidence = { providerMissing: bool, accessOrReadFailed: bool, validRows: bool, endSeen: bool, endCount: int, rowsSeen: int }
pure def privateWalkResult(unavailable: bool, exitZero: bool): InventoryResult =
  if (unavailable) InventoryUnavailable else if (exitZero) InventoryAvailable else InventoryFailed
pure def exportResult(exportRead: ExportEvidence): InventoryResult =
  if (exportRead.providerMissing) InventoryUnavailable
  else if (exportRead.accessOrReadFailed or not(exportRead.validRows and exportRead.endSeen) or exportRead.endCount != exportRead.rowsSeen) InventoryFailed
  else InventoryAvailable
pure def preReadbackResult(privateResult: InventoryResult, providerResult: InventoryResult): InventoryResult =
  if (privateResult == InventoryUnavailable) providerResult else privateResult
pure val completeExport: ExportEvidence = { providerMissing: false, accessOrReadFailed: false, validRows: true, endSeen: true, endCount: 2, rowsSeen: 2 }
pure val exportReadValues = Set(completeExport, { ...completeExport, providerMissing: true }, { ...completeExport, accessOrReadFailed: true },
  { ...completeExport, validRows: false }, { ...completeExport, endSeen: false }, { ...completeExport, endCount: 3 })
pure def lawExportNeedsCompleteRows(exportRead: ExportEvidence): bool =
  exportResult(exportRead) == InventoryAvailable implies exportRead.endSeen and exportRead.validRows and exportRead.endCount == exportRead.rowsSeen
pure def lawFailedWalkCannotFallBack(providerResult: InventoryResult): bool =
  preReadbackResult(InventoryFailed, providerResult) == InventoryFailed
```

### Preserved data requires a nonempty before inventory and identical file digests after

The shell decodes a normalized inventory unique by domain and file
identity. The device omits the top-level cache and code-cache domains.
A release integrity export uses HMAC-SHA-256 for each relative path
and file's bytes, with one fresh nonce for the pair. Raw file names and
bytes stay with the provider. Each read uses the same method for the
same observed app, user and update window. A missing after reading,
a different method or nonce, an empty before inventory, or any lost,
changed or new file fails the comparison. Ordering of the rows does
not affect it.

```quint
type FileReadback = { domain: str, fileRef: str, fileDigest: str }
type DataReadback = { inventoryResult: InventoryResult, method: ReadbackMethod, nonce: int, rows: List[FileReadback] }
type DataVerdict = DataUnobserved | DataFailed | DataPreserved
pure def sameFiles(beforeRows: List[FileReadback], afterRows: List[FileReadback]): bool =
  beforeRows.every(row => afterRows.includes(row)) and afterRows.every(row => beforeRows.includes(row))
pure def comparableReads(beforeData: DataReadback, afterData: DataReadback): bool =
  beforeData.method == afterData.method and
    (beforeData.method == IntegrityProvider implies beforeData.nonce > 0 and beforeData.nonce == afterData.nonce)
pure def dataVerdict(beforeData: DataReadback, afterData: DataReadback): DataVerdict =
  if (beforeData.inventoryResult == InventoryUnavailable) DataUnobserved
  else if (beforeData.inventoryResult == InventoryAvailable and afterData.inventoryResult == InventoryAvailable and
      beforeData.rows.length() > 0 and comparableReads(beforeData, afterData) and sameFiles(beforeData.rows, afterData.rows))
    DataPreserved
  else DataFailed
pure val settingsFile: FileReadback = { domain: "settings", fileRef: "path-a", fileDigest: "data-a" }
pure val databaseFile: FileReadback = { domain: "databases", fileRef: "path-b", fileDigest: "data-b" }
pure val releaseData: DataReadback = { inventoryResult: InventoryAvailable, method: IntegrityProvider, nonce: 1,
  rows: List(settingsFile, databaseFile) }
pure val debugData: DataReadback = { ...releaseData, method: PrivateFileWalk, nonce: 0 }
pure val beforeDataValues = Set(releaseData, debugData, { ...releaseData, rows: List() },
  { ...releaseData, inventoryResult: InventoryUnavailable, rows: List() }, { ...releaseData, inventoryResult: InventoryFailed, rows: List() })
pure val afterDataValues = Set(releaseData, debugData, { ...releaseData, nonce: 2 }, { ...releaseData, rows: List(databaseFile, settingsFile) },
  { ...releaseData, rows: List(settingsFile) }, { ...releaseData, rows: List(settingsFile, { ...databaseFile, fileDigest: "data-c" }) },
  { ...releaseData, rows: List(settingsFile, databaseFile, { domain: ".", fileRef: "path-c", fileDigest: "data-c" }) },
  { ...releaseData, inventoryResult: InventoryUnavailable, rows: List() })
pure def lawPreservedDataHasEvidenceInBothReadbacks(beforeData: DataReadback, afterData: DataReadback): bool =
  dataVerdict(beforeData, afterData) == DataPreserved implies beforeData.inventoryResult == InventoryAvailable and
    afterData.inventoryResult == InventoryAvailable and beforeData.rows.length() > 0 and sameFiles(beforeData.rows, afterData.rows)
pure def lawReleaseComparisonUsesOneNonce(beforeData: DataReadback, afterData: DataReadback): bool =
  (dataVerdict(beforeData, afterData) == DataPreserved and beforeData.method == IntegrityProvider) implies
    beforeData.nonce > 0 and beforeData.nonce == afterData.nonce
```

### The receipt states whether data preservation was observed

A confirmed install with a successful package comparison can report
missing data evidence on an older installation. It records that
limitation. An actual data readback failure cannot pass. A reviewed
signer migration needs complete pre-install identity and a nonempty
before inventory, and its successful install receipt needs preserved
data and observed identity. Device-user and quiescence checks must still
hold for the readback window.

```quint
type InstallWindow = { installConfirmed: bool, qualifiedWindow: bool, migration: bool }
type InstallReadbackReceipt = { installReadbackPassed: bool, identityObserved: bool, dataEvidence: DataVerdict }
pure def migrationHasPreEvidence(packageRead: PackageReadback, beforeData: DataReadback): bool =
  packageRead.priorUid != "" and packageRead.priorInstallTime != "" and beforeData.inventoryResult == InventoryAvailable and beforeData.rows.length() > 0
pure def installReadback(
  window: InstallWindow, packageRead: PackageReadback, beforeData: DataReadback, afterData: DataReadback
): InstallReadbackReceipt = {
  val evidence = dataVerdict(beforeData, afterData)
  val identity = installIdentityObserved(packageRead)
  { installReadbackPassed: window.installConfirmed and window.qualifiedWindow and packageReadbackMatches(packageRead) and
      evidence != DataFailed and (window.migration implies identity and evidence == DataPreserved),
    identityObserved: window.installConfirmed and window.qualifiedWindow and identity,
    dataEvidence: if (window.installConfirmed and window.qualifiedWindow) evidence else DataUnobserved }
}
pure val knownWindow: InstallWindow = { installConfirmed: true, qualifiedWindow: true, migration: false }
pure val windowValues = Set(knownWindow, { ...knownWindow, migration: true }, { ...knownWindow, qualifiedWindow: false },
  { ...knownWindow, installConfirmed: false })
pure def lawMigrationReceiptHasIdentityAndData(window: InstallWindow, packageRead: PackageReadback, beforeData: DataReadback, afterData: DataReadback): bool = {
  val receipt = installReadback(window, packageRead, beforeData, afterData)
  (window.migration and receipt.installReadbackPassed) implies
    receipt.identityObserved and receipt.dataEvidence == DataPreserved and migrationHasPreEvidence(packageRead, beforeData)
}
pure def lawUnqualifiedWindowCannotPass(window: InstallWindow, packageRead: PackageReadback, beforeData: DataReadback, afterData: DataReadback): bool =
  not(window.installConfirmed and window.qualifiedWindow) implies not(installReadback(window, packageRead, beforeData, afterData).installReadbackPassed)
```
