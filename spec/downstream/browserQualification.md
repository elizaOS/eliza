# Required browser execution and qualification

AlphaPhone `scripts/qualify-head.ts` consumes
`packages/scripts/check-required-playwright-results.ts` at
`c518127a025ab173874af9c7d304f26b25213b0d`. The shared report reader
classifies executions. The consumer's source and build verdict requires
stricter results from each engine. The
[downstream compatibility gate](./index.md) also requires native and
provider evidence for the same packed candidate.

## Story: Qualify the pinned source and build from browser executions

### The report proves passing terminal attempts in every required file

Require a nonempty list of required paths, an empty runner error list,
and structurally valid suites. Each spec contains at least one test.
Nested suites keep the outer file identity. Normalize each backslash
to a slash in the observed and required paths. The JSON decoder
supplies suite structure and inherited file identity to the fold.
Each test expects a pass, reports an expected or flaky outcome, and
ends with a passing attempt. Empty selections and missing required
files fail admission. Recompute counts and require equality with the
four stats fields, including zero unexpected and skipped. The result
retains a passing retry as flaky. Earlier attempt statuses do not
replace the final attempt.

```quint
type BrowserOutcome = BrowserExpected | BrowserFlaky | BrowserOther
type BrowserTest = { file: str, hasFile: bool, expectsPass: bool, outcome: BrowserOutcome, terminalPass: bool }
type BrowserTally = { valid: bool, expected: int, flaky: int, files: Set[str] }
type BrowserReport = { suitesValid: bool, errorsEmpty: bool, tests: List[BrowserTest], expected: int, flaky: int, unexpected: int, skipped: int }
pure def admitsBrowserTest(row: BrowserTest): bool =
  row.hasFile and row.expectsPass and row.outcome != BrowserOther and row.terminalPass
pure def countBrowserRow(tally: BrowserTally, row: BrowserTest): BrowserTally =
  { valid: tally.valid and admitsBrowserTest(row),
    expected: tally.expected + (if (row.outcome == BrowserExpected) 1 else 0),
    flaky: tally.flaky + (if (row.outcome == BrowserFlaky) 1 else 0),
    files: tally.files.union(Set(row.file)) }
pure val emptyBrowserTally: BrowserTally = { valid: true, expected: 0, flaky: 0, files: Set() }
pure def browserTally(rows: List[BrowserTest]): BrowserTally = rows.foldl(emptyBrowserTally, countBrowserRow)
pure def acceptsBrowserTally(report: BrowserReport, required: Set[str], tally: BrowserTally): bool =
  required.size() > 0 and report.suitesValid and report.errorsEmpty and tally.valid and tally.expected + tally.flaky > 0 and
  report.expected == tally.expected and report.flaky == tally.flaky and report.unexpected == 0 and report.skipped == 0 and
  required.subseteq(tally.files)
pure def admitsBrowserReport(report: BrowserReport, required: Set[str]): bool =
  acceptsBrowserTally(report, required, browserTally(report.tests))
pure val expectedBrowserTest: BrowserTest = { file: "storage.spec.ts", hasFile: true, expectsPass: true, outcome: BrowserExpected, terminalPass: true }
pure val passingBrowserReport: BrowserReport = { suitesValid: true, errorsEmpty: true, tests: List(expectedBrowserTest), expected: 1, flaky: 0, unexpected: 0, skipped: 0 }
pure val reportValues = Set(passingBrowserReport, { ...passingBrowserReport, expected: 0 },
  { ...passingBrowserReport, tests: List(), expected: 0 },
  { ...passingBrowserReport, tests: List({ ...expectedBrowserTest, outcome: BrowserFlaky }), expected: 0, flaky: 1 },
  { ...passingBrowserReport, tests: List({ ...expectedBrowserTest, terminalPass: false }) })
pure val requiredValues = Set(Set(), Set("storage.spec.ts"), Set("other.spec.ts"))
pure val rowValues = Set(expectedBrowserTest, { ...expectedBrowserTest, outcome: BrowserFlaky }, { ...expectedBrowserTest, terminalPass: false })
pure def lawFileSelectionIsMandatory(report: BrowserReport, required: Set[str]): bool =
  admitsBrowserReport(report, required) implies required.subseteq(browserTally(report.tests).files) and required.size() > 0
pure def lawBrowserStatsMatchActualExecutions(report: BrowserReport, required: Set[str]): bool =
  admitsBrowserReport(report, required) implies
    report.expected == browserTally(report.tests).expected and report.flaky == browserTally(report.tests).flaky and
    report.unexpected == 0 and report.skipped == 0 and report.expected + report.flaky > 0
pure def lawRunnerCannotDeclareFailedAttemptPassing(row: BrowserTest): bool =
  admitsBrowserTest(row) implies row.terminalPass and row.expectsPass and row.hasFile
```

### Every required engine passes cleanly on the current source and build

Alpha starts new runs and requires evidence from Chromium, Firefox and
WebKit. The per-engine storage gate requires a passed command, a
positive safe count of expected tests, and zero failed, skipped, flaky
or separately recorded failures. A flaky retry can be a valid shared
report and still disqualify the Alpha candidate's source and build
verdict. The verdict also checks a clean tree, exact Eliza pin, source
verification, a test-mocks-disabled APK build, production bundle audit,
the full Chromium suite and the production-surface project. Native
campaign receipts are separate inputs to release qualification.

```quint
type EngineExecution = { passed: bool, expected: int, flaky: int, unexpected: int, skipped: int, emptyFailures: bool }
type BrowserQualification = { cleanTree: bool, exactUpstreamPin: bool, sourceVerified: bool, apkBuilt: bool, testMocksOff: bool, productionBundleAudited: bool, chromium: EngineExecution, firefox: EngineExecution, webkit: EngineExecution, fullChromium: bool, productionSurface: bool }
pure def cleanEngine(execution: EngineExecution): bool =
  execution.passed and execution.expected > 0 and execution.expected <= 9007199254740991 and execution.flaky == 0 and
  execution.unexpected == 0 and execution.skipped == 0 and execution.emptyFailures
pure def sourceAndBuildQualified(evidence: BrowserQualification): bool =
  evidence.cleanTree and evidence.exactUpstreamPin and evidence.sourceVerified and evidence.apkBuilt and evidence.testMocksOff and
  evidence.productionBundleAudited and cleanEngine(evidence.chromium) and cleanEngine(evidence.firefox) and cleanEngine(evidence.webkit) and
  evidence.fullChromium and evidence.productionSurface
pure val passingEngine: EngineExecution = { passed: true, expected: 1, flaky: 0, unexpected: 0, skipped: 0, emptyFailures: true }
pure val passingBrowserQualification: BrowserQualification = { cleanTree: true, exactUpstreamPin: true, sourceVerified: true, apkBuilt: true, testMocksOff: true, productionBundleAudited: true, chromium: passingEngine, firefox: passingEngine, webkit: passingEngine, fullChromium: true, productionSurface: true }
pure val evidenceValues = Set(passingBrowserQualification, { ...passingBrowserQualification, testMocksOff: false },
  { ...passingBrowserQualification, webkit: { ...passingEngine, flaky: 1 } }, { ...passingBrowserQualification, exactUpstreamPin: false })
pure def lawFlakyEngineDoesNotQualify(evidence: BrowserQualification): bool =
  sourceAndBuildQualified(evidence) implies evidence.chromium.flaky == 0 and evidence.firefox.flaky == 0 and evidence.webkit.flaky == 0
pure def lawQualifiedBuildRequiresProductionProof(evidence: BrowserQualification): bool =
  sourceAndBuildQualified(evidence) implies evidence.testMocksOff and evidence.exactUpstreamPin and evidence.productionBundleAudited and evidence.productionSurface
```
