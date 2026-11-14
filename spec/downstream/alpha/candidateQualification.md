# Alpha release candidate campaign binding

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43`
uses `scripts/qualify-head.ts` to admit build, browser and emulator
evidence. [Browser qualification](../browserQualification.md) owns
the source and build verdict. [Fixture evidence](../mobileFixtureEvidence.md)
owns the requirements for the test records themselves.

## Story: Attribute every qualifying campaign to the APKs it actually tested

### Each campaign supplies a passing receipt and the installed app digests

Missing suite reports are missing evidence. A suite report names its
individual test records. A row containing only a test-mocks app does
not bind the release candidate. Every remaining row supplies an app
digest from a declared app role, a role-less entry or a legacy
`apkSha256` field. A missing or unreadable remaining row leaves the
suite unbound. A suite with all rows excluded is also unbound.
Resident instrumentation reads all JSON records in its campaign directory.
Each resident instrumentation record must pass and bind an installed app.

Resident CI requires its archive manifest and at least one native JSON
record carrying a passed field. Every such record must be true. The
archive contributes only standalone or launcher debug and release app
APK names. Test and helper APKs are excluded. The JSON codec supplies
the campaign kind, row classification and decoded digests. The receipt
producer supplies the observation that a digest names installed bytes.

```quint
type CampaignReceipt = { mockOnly: bool, appHashes: Set[str], passed: bool }
type CampaignReceipts = { present: bool, passed: bool, appHashes: Set[str], unbound: bool }
pure val plainReceipt: CampaignReceipt = { mockOnly: false, appHashes: Set("local"), passed: true }
pure val mockReceipt: CampaignReceipt = { mockOnly: true, appHashes: Set(), passed: true }
pure val unreadableReceipt: CampaignReceipt = { mockOnly: false, appHashes: Set(), passed: false }
pure val receiptsValues = Set(List(), List(plainReceipt), List(mockReceipt), List(unreadableReceipt), List(mockReceipt, plainReceipt), List(plainReceipt, unreadableReceipt))
pure def collectAppHashes(receipts: List[CampaignReceipt]): Set[str] =
  receipts.foldl(Set(), (hashes, row) => hashes.union(row.appHashes))
pure def suiteReceipts(present: bool, passed: bool, receipts: List[CampaignReceipt]): CampaignReceipts =
  { present: present, passed: passed, appHashes: collectAppHashes(receipts),
    unbound: receipts.every(row => row.appHashes.size() == 0) or receipts.some(row => not(row.mockOnly) and row.appHashes.size() == 0) }
pure def residentReceipts(receipts: List[CampaignReceipt]): CampaignReceipts =
  { present: receipts.length() > 0, passed: receipts.length() > 0 and receipts.every(row => row.passed),
    appHashes: collectAppHashes(receipts), unbound: receipts.some(row => row.appHashes.size() == 0) }
pure def ciReceipts(archivePresent: bool, proofsPresent: bool, appHashes: Set[str], proofVerdicts: List[bool]): CampaignReceipts =
  if (archivePresent) { present: true, passed: proofVerdicts.length() > 0 and proofVerdicts.every(pass => pass), appHashes: appHashes, unbound: false }
  else { present: proofsPresent, passed: false, appHashes: Set(), unbound: proofsPresent }
pure val appHashesValues = Set(Set(), Set("local"), Set("archive"))
pure val proofVerdictsValues = Set(List(), List(true), List(false), List(true, false))
pure def lawTestMocksDoNotBind(present: bool, passed: bool, receipts: List[CampaignReceipt]): bool =
  receipts.every(row => row.appHashes.size() == 0) implies suiteReceipts(present, passed, receipts).unbound
pure def lawMissingSuiteRowCannotBind(present: bool, passed: bool, receipts: List[CampaignReceipt]): bool =
  receipts.some(row => not(row.mockOnly) and row.appHashes.size() == 0) implies suiteReceipts(present, passed, receipts).unbound
pure def lawNativeCiRequiresArchive(proofsPresent: bool, appHashes: Set[str], proofVerdicts: List[bool]): bool =
  not(ciReceipts(false, proofsPresent, appHashes, proofVerdicts).passed)
```

### Resident CI may bind its named archive while local campaigns stay local

The candidate decoder keeps only lowercase 64-hex digests in each
candidate set. A present campaign is mismatched if it lacks a binding,
names no app digests, or names a digest outside its assigned set.
Assignment uses the local build for every campaign except resident CI
with an explicitly supplied archive. A matched campaign is passed
or failed according to its receipt. The campaign set is complete
when it is nonempty and every required campaign passes. Alpha's
profile names emulator instrumentation, emulator browser reading,
resident instrumentation and resident Android CI. Alpha requires
the source and build verdict plus all four for candidate qualification.
Results identify which artifact set each
campaign used. Physical-device acceptance and release distribution
have their own evidence.

```quint
type CampaignKind = EmulatorCampaign | ResidentInstrumentation | ResidentCi
type CampaignStatus = CampaignMissing | CampaignMismatched | CampaignFailed | CampaignPassed
type AlphaCampaignSet = { instrumentation: CampaignStatus, browserReading: CampaignStatus, residentInstrumentation: CampaignStatus, residentAndroid: CampaignStatus }
pure def candidateHashSet(kind: CampaignKind, archiveNamed: bool, local: Set[str], archive: Set[str]): Set[str] =
  if (kind == ResidentCi and archiveNamed) archive else local
pure def campaignStatus(kind: CampaignKind, evidence: CampaignReceipts, archiveNamed: bool, local: Set[str], archive: Set[str]): CampaignStatus =
  if (not(evidence.present)) CampaignMissing
  else if (evidence.unbound or evidence.appHashes.size() == 0 or not(evidence.appHashes.subseteq(candidateHashSet(kind, archiveNamed, local, archive)))) CampaignMismatched
  else if (evidence.passed) CampaignPassed else CampaignFailed
pure def candidateQualified(sourceQualified: bool, campaigns: List[CampaignStatus]): bool =
  sourceQualified and campaigns.length() > 0 and campaigns.every(status => status == CampaignPassed)
pure def alphaCandidateQualified(sourceQualified: bool, requiredCampaigns: AlphaCampaignSet): bool =
  candidateQualified(sourceQualified, List(requiredCampaigns.instrumentation, requiredCampaigns.browserReading,
    requiredCampaigns.residentInstrumentation, requiredCampaigns.residentAndroid))
pure val boundLocal: CampaignReceipts = { present: true, passed: true, appHashes: Set("local"), unbound: false }
pure val boundArchive: CampaignReceipts = { ...boundLocal, appHashes: Set("archive") }
pure val evidenceValues = Set(boundLocal, boundArchive, { ...boundLocal, unbound: true }, { ...boundLocal, appHashes: Set() }, { ...boundLocal, passed: false }, { ...boundLocal, present: false })
pure val localValues = Set(Set(), Set("local"), Set("archive"), Set("local", "archive"))
pure val archiveValues = localValues
pure val campaignsValues = Set(List(), List(CampaignPassed), List(CampaignPassed, CampaignFailed), List(CampaignPassed, CampaignMismatched), List(CampaignPassed, CampaignMissing))
pure val completeCampaigns: AlphaCampaignSet = { instrumentation: CampaignPassed, browserReading: CampaignPassed, residentInstrumentation: CampaignPassed, residentAndroid: CampaignPassed }
pure val requiredCampaignsValues = Set(completeCampaigns, { ...completeCampaigns, browserReading: CampaignMismatched }, { ...completeCampaigns, residentAndroid: CampaignMissing })
pure def lawArchiveNeverChangesNonCiBinding(kind: CampaignKind, local: Set[str], archive: Set[str]): bool =
  kind != ResidentCi implies candidateHashSet(kind, true, local, archive).subseteq(local) and local.subseteq(candidateHashSet(kind, true, local, archive))
pure def lawUnboundCampaignCannotPass(kind: CampaignKind, evidence: CampaignReceipts, archiveNamed: bool, local: Set[str], archive: Set[str]): bool =
  evidence.unbound implies campaignStatus(kind, evidence, archiveNamed, local, archive) != CampaignPassed
pure def lawPresentForeignDigestCannotPass(kind: CampaignKind, evidence: CampaignReceipts, archiveNamed: bool, local: Set[str], archive: Set[str]): bool =
  (evidence.present and not(evidence.appHashes.subseteq(candidateHashSet(kind, archiveNamed, local, archive)))) implies
    campaignStatus(kind, evidence, archiveNamed, local, archive) == CampaignMismatched
pure def lawCandidateRequiresAllCampaigns(sourceQualified: bool, campaigns: List[CampaignStatus]): bool =
  candidateQualified(sourceQualified, campaigns) implies sourceQualified and campaigns.length() > 0 and campaigns.every(status => status == CampaignPassed)
pure def lawAlphaCandidateRequiresBrowserReading(sourceQualified: bool, requiredCampaigns: AlphaCampaignSet): bool =
  alphaCandidateQualified(sourceQualified, requiredCampaigns) implies requiredCampaigns.browserReading == CampaignPassed
```
