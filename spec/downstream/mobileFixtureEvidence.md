# Android fixture observation and instrumentation evidence

AlphaPhone at `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` imports these Eliza
tooling contracts from `c518127a025ab173874af9c7d304f26b25213b0d`.
`scripts/android-instrumentation.ts` owns Alpha's named class campaign and
`scripts/native-test-fixture.ts` and the isolated consumers own explicit
method campaigns. `scripts/reminder-recovery-fixture.ts` uses the shared
observer and reboot helper. `scripts/prepare-ci-emulator.ts` and
`scripts/prepare-ci-webview.ts` bind the hosted fixture tools. The existing
[fixture custody](./mobileFixtureCustody.md) owns leases and user cleanup.

## Story: Qualify an instrumentation run with the exact tests that completed

### One clean terminal verdict agrees with the expected started and completed cases

Eliza's `packages/app/scripts/lib/instrumentation-result.mjs` strictly decodes
raw `am instrument -w -r` output up to 4 MiB of JavaScript string length.
The command names a nonempty, unique class list. The decoder normalizes CRLF
and rejects failure, crash and assumption markers. Each delimited status
block needs unique fields, a requested class, a nonempty method and the
same `numtests` value as the one positive final summary. Code `1` starts
one case and code `0` finishes that exact active case. A duplicate start,
unsupported status, missing match, pending block, or status after the one
terminal code `-1` rejects. Counts of unique starts, completed cases and
the final summary agree, and the completed class set equals the requested
class set. `isolated-android-test.mjs` additionally compares the total
with `expectedTests`. When requested by method, it requires exactly one
class, one expected case and the exact `class#method` in the returned case
list. Harness-owned runner selection and dry-run keys are prohibited in
caller-provided `-e` extras. The model consumes normalized records, with
byte bounds, field parsing, receipt class-set comparison and selectors
already decoded by the boundary port. It treats EOF as a separate event so
late records cannot inherit an earlier provisional verdict.

```quint
type EvidencePhase = EvidenceUnbound | EvidenceReading | EvidenceAccepted | EvidenceRejected
type RecordCode = CaseStart | CasePass | CaseOther
type ResultRecord = { selector: str, requestedClass: bool, fieldsUnique: bool, advertised: int, code: RecordCode }
type TerminalRecord = { code: int, summaries: int, terminals: int, count: int, allClassesCovered: bool, cleanOutput: bool, fieldsClosed: bool }
type Instrumentation = { phase: EvidencePhase, expected: int, exactMethod: str, activeCase: str, started: int, completed: int,
  seen: str -> bool, broken: bool, terminal: bool, reported: bool }
pure val initial: Instrumentation = { phase: EvidenceUnbound, expected: 0, exactMethod: "", activeCase: "", started: 0, completed: 0,
  seen: Map(), broken: false, terminal: false, reported: false }
pure def canSelectCases(s: Instrumentation, expected: int, exactMethod: str, selectionValid: bool): bool =
  s.phase == EvidenceUnbound and selectionValid and expected > 0 and (exactMethod == "" or expected == 1)
pure def selectCases(s: Instrumentation, expected: int, exactMethod: str, selectionValid: bool): Instrumentation =
  { ...initial, phase: EvidenceReading, expected: expected, exactMethod: exactMethod }
pure def admissibleRecord(s: Instrumentation, record: ResultRecord): bool =
  not(s.broken or s.terminal) and record.requestedClass and record.fieldsUnique and record.selector != "" and record.advertised == s.expected and
  (s.exactMethod == "" or record.selector == s.exactMethod)
pure def canReadCase(s: Instrumentation): bool = s.phase == EvidenceReading
pure def readCase(s: Instrumentation, record: ResultRecord): Instrumentation =
  if (not(admissibleRecord(s, record))) { ...s, broken: true }
  else if (record.code == CaseStart and s.activeCase == "" and s.started < s.expected and not(s.seen.getOr(record.selector, false)))
    { ...s, activeCase: record.selector, started: s.started + 1, seen: s.seen.put(record.selector, true) }
  else if (record.code == CasePass and record.selector == s.activeCase and s.completed < s.started)
    { ...s, activeCase: "", completed: s.completed + 1 }
  else { ...s, broken: true }
pure def canReadTerminal(s: Instrumentation): bool = s.phase == EvidenceReading
pure def readTerminal(s: Instrumentation, terminalRecord: TerminalRecord): Instrumentation =
  if (s.terminal) { ...s, broken: true }
  else { ...s, terminal: true, reported: terminalRecord.code == -1 and terminalRecord.summaries == 1 and terminalRecord.terminals == 1 and
    terminalRecord.count == s.expected and terminalRecord.allClassesCovered and terminalRecord.cleanOutput and terminalRecord.fieldsClosed }
pure def canSealRun(s: Instrumentation): bool = s.phase == EvidenceReading
pure def sealRun(s: Instrumentation): Instrumentation = { ...s,
  phase: if (not(s.broken) and s.terminal and s.reported and s.activeCase == "" and s.completed == s.expected and s.started == s.expected)
    EvidenceAccepted else EvidenceRejected }
pure val expectedValues = Set(1, 2)
pure val exactMethodValues = Set("a#one", "")
pure val recordValues = Set(
  { selector: "a#one", requestedClass: true, fieldsUnique: true, advertised: 1, code: CaseStart },
  { selector: "a#one", requestedClass: true, fieldsUnique: true, advertised: 1, code: CasePass },
  { selector: "a#one", requestedClass: true, fieldsUnique: false, advertised: 1, code: CaseOther },
  { selector: "x#other", requestedClass: false, fieldsUnique: true, advertised: 1, code: CaseStart },
  { selector: "a#one", requestedClass: true, fieldsUnique: true, advertised: 2, code: CaseStart },
  { selector: "a#one", requestedClass: true, fieldsUnique: true, advertised: 2, code: CasePass },
  { selector: "b#two", requestedClass: true, fieldsUnique: true, advertised: 2, code: CaseStart },
  { selector: "b#two", requestedClass: true, fieldsUnique: true, advertised: 2, code: CasePass }
)
pure val terminalRecordValues = Set(
  { code: -1, summaries: 1, terminals: 1, count: 1, allClassesCovered: true, cleanOutput: true, fieldsClosed: true },
  { code: -1, summaries: 1, terminals: 1, count: 2, allClassesCovered: true, cleanOutput: true, fieldsClosed: true },
  { code: 0, summaries: 0, terminals: 1, count: 1, allClassesCovered: false, cleanOutput: false, fieldsClosed: true }
)
pure val weight_selectCases = 6
pure val weight_readCase = 18
pure val weight_readTerminal = 7
pure val weight_sealRun = 5
pure def alwaysCompletionCannotExceedStarts(s: Instrumentation): bool = s.completed >= 0 and s.completed <= s.started and s.started <= s.expected
pure def alwaysSuccessOwnsCompleteRun(s: Instrumentation): bool =
  (s.phase == EvidenceAccepted) implies not(s.broken) and s.terminal and s.reported and s.started == s.expected and s.completed == s.expected and s.activeCase == ""
pure def stepPassedEvidenceIsFinal(before: Instrumentation, after: Instrumentation): bool = before.phase == EvidenceAccepted implies after.phase == EvidenceAccepted
pure def stepLateCaseInvalidates(before: Instrumentation, via: str, after: Instrumentation): bool =
  (via == "readCase" and before.terminal) implies after.broken
pure def sometimesExactFixturePasses(s: Instrumentation): bool = s.phase == EvidenceAccepted and s.exactMethod != ""
pure def sometimesInvalidFixtureRejected(s: Instrumentation): bool = s.phase == EvidenceRejected and s.broken
```

### Isolated class reporting and dry-run enumeration have distinct evidence contracts

Alpha's `scripts/instrumentation-result.ts` per-class reader accepts up to
16 MiB of JavaScript string length. It preserves independently completed
classes when another class fails. `-3` can stand for a JUnit ignored method
without a start. An assumption `-4` requires its matching start. Either is
reported as skipped work. Status-only diagnostics with no class and method
leave test counts unchanged. Duplicate or overlapping lifecycle records,
unmatched completions, a class unfinished at exit, or a failed run fail
that class. A class with no records is missing. A class whose only results
were skips is skipped. One passing method plus allowed skips can qualify a
class-level pass. Named classes first use `-e log true`; an empty listing is
retried once and the result is retained. The listing is an inventory.
A phased class requires each configured method phase to pass in order,
with the app data retained between those phases. Missing or skipped phases
fail the class and stop later phases.

The pinned per-class reader checks terminal presence and success code but
does not require a positive summary or reject records after the terminal.
Alpha's runner projects class results even for a single-method phase.
The strict parser and exact method/total checks above are required to claim
method-qualified evidence. This preserves the existing per-class diagnostic
projection while preventing a passed diagnostic row from substituting for
an exact-method receipt. Alpha's `results.json` is newly created and binds
the full commit and hashes, roles and variants of installed APKs. Its
overall result requires a nonempty list of passed classes, proven HOME
restoration plus cold resume when it changed HOME, and owner restoration
plus removal for each disposable user it created. Such runner records carry
the emulator evidence label `E`. Physical development and Cuttlefish
campaign reports carry their own configured evidence and pinned device
identity; neither inherits physical release or user acceptance from a
fixture instrumentation outcome.

```quint
type ClassStatus = ClassPassed | ClassFailed | ClassMissing | ClassSkipped
type ClassFacts = { started: int, passed: int, failed: int, ignored: int, ignoredWithoutStart: int, malformed: bool, activeAtExit: bool, runFailure: bool }
type ReceiptFacts = { fullCommit: bool, boundApks: bool, nonemptyClasses: bool, allPassed: bool, homeChanged: bool, homeRestored: bool,
  coldHomeResumed: bool, secondaryCleanupProven: bool }
pure def classStatus(facts: ClassFacts): ClassStatus =
  if (facts.started == 0 and facts.ignored == 0) ClassMissing
  else if (facts.malformed or facts.activeAtExit or facts.runFailure or facts.failed > 0 or
    facts.started + facts.ignoredWithoutStart != facts.passed + facts.failed + facts.ignored) ClassFailed
  else if (facts.passed == 0) ClassSkipped else ClassPassed
pure def qualifiesClassReceipt(receipt: ReceiptFacts): bool =
  receipt.fullCommit and receipt.boundApks and receipt.nonemptyClasses and receipt.allPassed and receipt.secondaryCleanupProven and
  (not(receipt.homeChanged) or (receipt.homeRestored and receipt.coldHomeResumed))
pure def qualifiesMethod(s: Instrumentation, method: str): bool = s.phase == EvidenceAccepted and method != "" and s.exactMethod == method
pure val factsValues = Set(
  { started: 0, passed: 0, failed: 0, ignored: 0, ignoredWithoutStart: 0, malformed: false, activeAtExit: false, runFailure: false },
  { started: 0, passed: 0, failed: 0, ignored: 1, ignoredWithoutStart: 1, malformed: false, activeAtExit: false, runFailure: false },
  { started: 2, passed: 1, failed: 0, ignored: 1, ignoredWithoutStart: 0, malformed: false, activeAtExit: false, runFailure: false },
  { started: 1, passed: 1, failed: 0, ignored: 0, ignoredWithoutStart: 0, malformed: true, activeAtExit: false, runFailure: false },
  { started: 1, passed: 0, failed: 0, ignored: 0, ignoredWithoutStart: 0, malformed: false, activeAtExit: true, runFailure: true }
)
pure val receiptValues = Set(
  { fullCommit: true, boundApks: true, nonemptyClasses: true, allPassed: true, homeChanged: false, homeRestored: false, coldHomeResumed: false, secondaryCleanupProven: true },
  { fullCommit: true, boundApks: true, nonemptyClasses: true, allPassed: true, homeChanged: true, homeRestored: true, coldHomeResumed: true, secondaryCleanupProven: true },
  { fullCommit: true, boundApks: true, nonemptyClasses: true, allPassed: true, homeChanged: true, homeRestored: false, coldHomeResumed: true, secondaryCleanupProven: true },
  { fullCommit: true, boundApks: false, nonemptyClasses: true, allPassed: true, homeChanged: false, homeRestored: false, coldHomeResumed: false, secondaryCleanupProven: false }
)
pure def lawSkipAndIncompleteNeverPass(facts: ClassFacts): bool =
  (facts.passed == 0 or facts.malformed or facts.activeAtExit or facts.runFailure) implies classStatus(facts) != ClassPassed
pure def lawClassEvidenceRequiresApksAndCleanup(receipt: ReceiptFacts): bool =
  qualifiesClassReceipt(receipt) implies receipt.boundApks and receipt.secondaryCleanupProven and (receipt.homeChanged implies receipt.homeRestored and receipt.coldHomeResumed)
pure def lawMethodNeedsExactReceipt(s: Instrumentation, method: str): bool = qualifiesMethod(s, method) implies s.phase == EvidenceAccepted and s.exactMethod == method and method != ""
```

### A supervised interruption requires its own receipt and a later recovery phase

`isolated-android-test.mjs` allows one active phase of a unique name. An
interruption follows successful setup in the active owned variant, with
one selected method, and requires resolution of any earlier interruption.
The supervisor binds a fresh harness nonce to a bounded marker, matching
user, APK bytes, process identity and exclusive package UID, then checks
custody again before the single user-scoped force-stop. The instrumented
process must still be live at dispatch. The break receipt requires zero
remaining processes of that UID and current custody. The interruption
decoder requires the exact start, one advertised test, no completed case,
one terminal code `0` and one expected `shortMsg=Process crashed.` marker.
It rejects success summaries, extra case states and terminal ambiguity.
Only a later ordinary phase that passes before cleanup resolves the pending
recovery. Cleanup can run without satisfying the recovery requirement.
The outer fixture fails if it reaches finalization with recovery pending.

```quint
type InterruptionFacts = { setupPassed: bool, phaseExclusive: bool, activeOwnedVariant: bool, recoveredPrior: bool, oneMethod: bool,
  leaseAndApksMatch: bool, markerAndProcessMatch: bool, exclusiveUid: bool, liveAtEffect: bool, noUidProcessesAfter: bool, interruptedOutputMatches: bool }
pure def mayInterrupt(proof: InterruptionFacts): bool =
  proof.setupPassed and proof.phaseExclusive and proof.activeOwnedVariant and proof.recoveredPrior and proof.oneMethod and
  proof.leaseAndApksMatch and proof.markerAndProcessMatch and proof.exclusiveUid and proof.liveAtEffect
pure def confirmsInterruption(proof: InterruptionFacts): bool = mayInterrupt(proof) and proof.noUidProcessesAfter and proof.interruptedOutputMatches
pure def qualifiesRecovery(pending: bool, cleanup: bool, ordinaryPass: bool): bool = pending and not(cleanup) and ordinaryPass
pure val proofValues = Set(
  { setupPassed: true, phaseExclusive: true, activeOwnedVariant: true, recoveredPrior: true, oneMethod: true, leaseAndApksMatch: true, markerAndProcessMatch: true, exclusiveUid: true, liveAtEffect: true, noUidProcessesAfter: true, interruptedOutputMatches: true },
  { setupPassed: true, phaseExclusive: true, activeOwnedVariant: true, recoveredPrior: true, oneMethod: true, leaseAndApksMatch: true, markerAndProcessMatch: false, exclusiveUid: true, liveAtEffect: true, noUidProcessesAfter: true, interruptedOutputMatches: true },
  { setupPassed: true, phaseExclusive: true, activeOwnedVariant: true, recoveredPrior: true, oneMethod: true, leaseAndApksMatch: true, markerAndProcessMatch: true, exclusiveUid: true, liveAtEffect: false, noUidProcessesAfter: true, interruptedOutputMatches: true },
  { setupPassed: true, phaseExclusive: true, activeOwnedVariant: true, recoveredPrior: true, oneMethod: true, leaseAndApksMatch: true, markerAndProcessMatch: true, exclusiveUid: true, liveAtEffect: true, noUidProcessesAfter: false, interruptedOutputMatches: false }
)
pure def lawInterruptionNeedsSupervisionAndTerminal(proof: InterruptionFacts): bool =
  confirmsInterruption(proof) implies proof.markerAndProcessMatch and proof.exclusiveUid and proof.liveAtEffect and proof.noUidProcessesAfter and proof.interruptedOutputMatches
pure def lawCleanupCannotRecoverInterruption(pending: bool, ordinaryPass: bool): bool = not(qualifiesRecovery(pending, true, ordinaryPass))
```

## Story: Observe a fixture without changing the state being measured

### Read-only Android evidence binds the exact package, user and requested key

Eliza's `android-fixture-observation.mjs` accepts an explicit positive
fixture user, validated package and relative preference filename without
path traversal. It uses the bounded runner, `run-as --user` and a complete
Android SharedPreferences `<map>` frame. An absent string yields `null`.
Duplicate matching strings, nested markup, unsupported entities or illegal
numeric character references reject. Text entity decoding is limited to
the five XML names and admitted scalar characters. Package stop evidence
comes from exactly one `Packages:` section, its exact package header and
one exact user row with a single `stopped=true|false`. A similar package,
current owner row or a package query row cannot qualify it. Notification
evidence uses the node's numeric user, exact package, signed Android
notification ID and a nonempty tag without separator characters. The
listed key must contain its numeric UID field. These reads never launch
the app or start instrumentation, which could cancel an alarm.

```quint
type StopObservation = StopUnknown | PackageRunning | PackageStopped
type StopFacts = { user: int, completePackagesSection: bool, packageMatches: bool, userMatches: bool, stateUnique: bool, stopped: bool }
type NotificationFacts = { userMatches: bool, packageMatches: bool, notificationIdMatches: bool, tagMatches: bool, uidFieldPresent: bool }
type PreferenceFacts = { mapComplete: bool, selectorValid: bool, unique: bool, matching: bool, stringValid: bool }
type PreferenceOutcome = PreferenceUnknown | PreferenceAbsent | PreferencePresent
pure def packageStopStatus(observed: StopFacts): StopObservation =
  if (observed.user <= 0 or not(observed.completePackagesSection and observed.packageMatches and observed.userMatches and observed.stateUnique)) StopUnknown
  else if (observed.stopped) PackageStopped else PackageRunning
pure def admitsNotification(observedKey: NotificationFacts): bool =
  observedKey.userMatches and observedKey.packageMatches and observedKey.notificationIdMatches and observedKey.tagMatches and observedKey.uidFieldPresent
pure def preferenceStringStatus(preference: PreferenceFacts): PreferenceOutcome =
  if (not(preference.mapComplete and preference.selectorValid and preference.unique)) PreferenceUnknown
  else if (not(preference.matching)) PreferenceAbsent else if (preference.stringValid) PreferencePresent else PreferenceUnknown
pure val observedValues = Set(
  { user: 10, completePackagesSection: true, packageMatches: true, userMatches: true, stateUnique: true, stopped: false },
  { user: 10, completePackagesSection: true, packageMatches: true, userMatches: true, stateUnique: true, stopped: true },
  { user: 10, completePackagesSection: false, packageMatches: true, userMatches: true, stateUnique: true, stopped: false },
  { user: 10, completePackagesSection: true, packageMatches: true, userMatches: false, stateUnique: true, stopped: false }
)
pure val observedKeyValues = Set(
  { userMatches: true, packageMatches: true, notificationIdMatches: true, tagMatches: true, uidFieldPresent: true },
  { userMatches: false, packageMatches: true, notificationIdMatches: true, tagMatches: true, uidFieldPresent: true },
  { userMatches: true, packageMatches: true, notificationIdMatches: true, tagMatches: true, uidFieldPresent: false }
)
pure val preferenceValues = Set(
  { mapComplete: true, selectorValid: true, unique: true, matching: true, stringValid: true },
  { mapComplete: true, selectorValid: true, unique: true, matching: false, stringValid: false },
  { mapComplete: false, selectorValid: true, unique: true, matching: true, stringValid: true },
  { mapComplete: true, selectorValid: true, unique: false, matching: true, stringValid: true }
)
pure def lawUnknownStopStateDoesNotProveRunning(observed: StopFacts): bool =
  (not(observed.completePackagesSection and observed.packageMatches and observed.userMatches and observed.stateUnique) or observed.user <= 0) implies packageStopStatus(observed) == StopUnknown
pure def lawReceiptRequiresExactNotificationKey(observedKey: NotificationFacts): bool = admitsNotification(observedKey) implies observedKey.userMatches and observedKey.packageMatches and observedKey.notificationIdMatches and observedKey.tagMatches and observedKey.uidFieldPresent
pure def lawPartialPreferencesCannotProvePresence(preference: PreferenceFacts): bool = not(preference.mapComplete) implies preferenceStringStatus(preference) == PreferenceUnknown
```

### Reboot evidence proves a changed boot and the same fixture user's unlocked return

`android-fixture-reboot.mjs` requires a live exact lease owned by the
current process with the long-lived TTL, an explicit owned emulator and
its expected AVD, and the same positive foreground fixture user before
reboot. It reads a UUID boot ID, requests reboot once, waits for the
transport and requires a changed UUID plus `sys.boot_completed=1`. It
rechecks the AVD, starts and switches to the captured user, wakes and
dismisses the test keyguard, and requires that same user to be foreground
and `RUNNING_UNLOCKED`. The waiting phases share one bounded deadline
after transport returns, with 120,000 ms and 500 ms default budget and poll
interval. Cancellation and transport failure do not qualify. No target app
or instrumentation is launched. Package stop status, reminder revisions,
and exact notification receipts remain separate campaign observations.

```quint
type RebootEntry = { leased: bool, ownedEmulator: bool, expectedAvd: bool, user: int, foreground: int, bootId: str }
type RebootReturn = { bootId: str, bootComplete: bool, expectedAvd: bool, foreground: int, unlocked: bool, withinDeadline: bool }
pure def mayReboot(entry: RebootEntry): bool =
  entry.leased and entry.ownedEmulator and entry.expectedAvd and entry.user > 0 and entry.user == entry.foreground and entry.bootId != ""
pure def qualifiesReboot(entry: RebootEntry, returned: RebootReturn): bool =
  mayReboot(entry) and returned.bootId != "" and returned.bootId != entry.bootId and returned.bootComplete and returned.expectedAvd and
  returned.foreground == entry.user and returned.unlocked and returned.withinDeadline
pure val entryValues = Set(
  { leased: true, ownedEmulator: true, expectedAvd: true, user: 10, foreground: 10, bootId: "before" },
  { leased: true, ownedEmulator: true, expectedAvd: true, user: 0, foreground: 0, bootId: "before" },
  { leased: false, ownedEmulator: true, expectedAvd: true, user: 10, foreground: 10, bootId: "before" }
)
pure val returnedValues = Set(
  { bootId: "after", bootComplete: true, expectedAvd: true, foreground: 10, unlocked: true, withinDeadline: true },
  { bootId: "before", bootComplete: true, expectedAvd: true, foreground: 10, unlocked: true, withinDeadline: true },
  { bootId: "after", bootComplete: true, expectedAvd: true, foreground: 11, unlocked: true, withinDeadline: true },
  { bootId: "after", bootComplete: true, expectedAvd: true, foreground: 10, unlocked: false, withinDeadline: true }
)
pure def lawRebootReceiptNeedsNewBootAndSameUser(entry: RebootEntry, returned: RebootReturn): bool =
  qualifiesReboot(entry, returned) implies returned.bootId != entry.bootId and returned.foreground == entry.user and returned.unlocked
```

## Story: Admit only a qualified hosted emulator and preserve the kind of evidence it produced

### Display readiness needs two consecutive positive readbacks after fresh admission

`hosted-fixture/ci-emulator-display.mjs` permits GitHub-hosted Actions on
`emulator-5554` AVD `test`, emulator kernel, `userdebug` or `eng`, and
user zero as the only installed user and foreground user. Initial display
preparation requires no third-party app. The known unbound keyguard boot
sentinel can be waited out. An otherwise malformed policy read refuses.
An unsecured bound observation is rechecked immediately before the
one lock policy write; the write needs a recognized old policy and exact
readback. No credential clearing is permitted. The display readiness
claim needs two successive read-only observations that are bound, ready,
unsecured, awake, on, unlocked and input-unrestricted. A secure or missing
condition resets the consecutive count. Mutable preparation and readiness
share the 30-attempt budget. `ci-emulator-diagnostics.mjs` collects only
read-only bounded diagnostics with a 15-second aggregate, at most two
seconds per read, 65,536 characters for power/policy and 1,024 for system
properties. Missing or truncated evidence is labelled. A diagnostic
failure leaves the admission result authoritative.

```quint
type HostedFixture = { githubActions: bool, githubHosted: bool, serialExact: bool, avdExact: bool, emulatorKernel: bool, debugImage: bool,
  onlyOwnerExists: bool, ownerForeground: bool, noThirdParty: bool }
type DisplayFacts = { ready: bool, malformed: bool, unsecured: bool, awake: bool, on: bool, unlocked: bool, unrestricted: bool }
pure def hostedFixture(identity: HostedFixture): bool = identity.githubActions and identity.githubHosted and identity.serialExact and identity.avdExact and
  identity.emulatorKernel and identity.debugImage and identity.onlyOwnerExists and identity.ownerForeground
pure def mayWriteFixturePolicy(identity: HostedFixture, beforeWrite: DisplayFacts, priorKnown: bool): bool =
  hostedFixture(identity) and identity.noThirdParty and beforeWrite.ready and not(beforeWrite.malformed) and beforeWrite.unsecured and priorKnown
pure def goodDisplay(display: DisplayFacts): bool =
  display.ready and not(display.malformed) and display.unsecured and display.awake and display.on and display.unlocked and display.unrestricted
pure def qualifiesDisplay(identity: HostedFixture, previous: DisplayFacts, latest: DisplayFacts, withinBudget: bool): bool =
  hostedFixture(identity) and withinBudget and goodDisplay(previous) and goodDisplay(latest)
pure val identityValues = Set(
  { githubActions: true, githubHosted: true, serialExact: true, avdExact: true, emulatorKernel: true, debugImage: true, onlyOwnerExists: true, ownerForeground: true, noThirdParty: true },
  { githubActions: true, githubHosted: false, serialExact: true, avdExact: true, emulatorKernel: true, debugImage: true, onlyOwnerExists: true, ownerForeground: true, noThirdParty: true },
  { githubActions: true, githubHosted: true, serialExact: true, avdExact: true, emulatorKernel: true, debugImage: true, onlyOwnerExists: true, ownerForeground: true, noThirdParty: false }
)
pure val previousValues = Set(
  { ready: true, malformed: false, unsecured: true, awake: true, on: true, unlocked: true, unrestricted: true },
  { ready: true, malformed: false, unsecured: false, awake: true, on: true, unlocked: true, unrestricted: true },
  { ready: true, malformed: false, unsecured: true, awake: false, on: false, unlocked: true, unrestricted: true },
  { ready: false, malformed: true, unsecured: false, awake: false, on: false, unlocked: false, unrestricted: false }
)
pure val latestValues = previousValues
pure val beforeWriteValues = previousValues
pure def lawDisplayNeedsTwoQualifiedReads(identity: HostedFixture, previous: DisplayFacts, latest: DisplayFacts, withinBudget: bool): bool =
  qualifiesDisplay(identity, previous, latest, withinBudget) implies goodDisplay(previous) and goodDisplay(latest) and withinBudget
pure def lawPolicyWriteRequiresFreshUnsecuredFixture(identity: HostedFixture, beforeWrite: DisplayFacts, priorKnown: bool): bool =
  mayWriteFixturePolicy(identity, beforeWrite, priorKnown) implies identity.noThirdParty and beforeWrite.unsecured and not(beforeWrite.malformed)
```

### Hosted WebView provisioning retains fixture provenance and defers runtime qualification

Alpha's `prepare-ci-webview.ts` requires the explicit `api35-default-x86_64`
fixture acknowledgment. The pinned `hosted-fixture/webview-provider.mjs`
admits that image's API, ABI and flavor, stock package path/version,
expected package inventory and no active instrumentation. An adb exit 255
with partial process output is an unavailable observation and only that
unsignalled status qualifies for the two bounded retries with renewed
identity checks. App existence exclusions include `ai.alphacompute.`.
The artifact manifest pins archive bytes, extracted APK bytes, package,
certificate, version and native ABI. Bootconfig, property and sysfs
readbacks bind the fixture's exact boot devices and preexisting alias.
Mutation and verification use that authenticated disposable fixture. The
provider transaction requires the exact installed provider, fresh framework
and same kernel boot on restart, verified backing storage, no remaining
app ANR, display admission and network readiness. A kernel change during
framework restart, unsafe scratch or missing provider readback fails.
`PROVISIONED_RUNTIME_QUALIFICATION_PENDING` is a provisioning receipt.
An actual instrumentation run still establishes the runtime capability.

Alpha resolves Java and Android SDK through Eliza's
`packages/app/scripts/mobile/toolchain.ts`; it requires Java major at least
21 and selects Android SDK build-tools `36.0.0`. Gradle and dependency
checksum pins for package assembly remain with the build spec. This unit
does not model the privileged, fixture-specific disk or remount commands.

```quint
type WebViewEvidence = { acknowledged: bool, identityAndInventory: bool, pinnedBootDevices: bool, stockIdentity: bool, artifactExact: bool,
  providerReadbackExact: bool, frameworkRenewedSameBoot: bool, backingVerified: bool, noAppAnr: bool, displayReady: bool, networkReady: bool }
pure def admitsProviderFixture(provider: WebViewEvidence): bool = provider.acknowledged and provider.identityAndInventory and provider.pinnedBootDevices and provider.stockIdentity
pure def recordsProviderProvisioned(provider: WebViewEvidence): bool = admitsProviderFixture(provider) and provider.artifactExact and provider.providerReadbackExact and
  provider.frameworkRenewedSameBoot and provider.backingVerified and provider.noAppAnr and provider.displayReady and provider.networkReady
pure def qualifiesProviderRuntime(provider: WebViewEvidence, strictRunPassed: bool): bool = recordsProviderProvisioned(provider) and strictRunPassed
pure val providerValues = Set(
  { acknowledged: true, identityAndInventory: true, pinnedBootDevices: true, stockIdentity: true, artifactExact: true, providerReadbackExact: true, frameworkRenewedSameBoot: true,
    backingVerified: true, noAppAnr: true, displayReady: true, networkReady: true },
  { acknowledged: true, identityAndInventory: true, pinnedBootDevices: true, stockIdentity: true, artifactExact: true, providerReadbackExact: false, frameworkRenewedSameBoot: true,
    backingVerified: true, noAppAnr: true, displayReady: true, networkReady: true },
  { acknowledged: true, identityAndInventory: false, pinnedBootDevices: true, stockIdentity: true, artifactExact: true, providerReadbackExact: true, frameworkRenewedSameBoot: false,
    backingVerified: true, noAppAnr: true, displayReady: true, networkReady: true }
)
pure def lawProviderNeedsSeparateRuntimeEvidence(provider: WebViewEvidence): bool = not(qualifiesProviderRuntime(provider, false))
pure def lawProvisionedProviderHasAllReadbacks(provider: WebViewEvidence): bool = recordsProviderProvisioned(provider) implies
  provider.providerReadbackExact and provider.frameworkRenewedSameBoot and provider.backingVerified and provider.displayReady and provider.networkReady
```
