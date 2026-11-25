# Device test harness

The part of an Android test campaign the os package owns: the single-device
lease, the instrumentation result, the runners a test APK may declare and
the isolated test user. Sources: develop's `packages/app/scripts/lib/`
`device-lease.ts`, `instrumentation-result.mjs`, `isolated-android-test.mjs`
and `isolated-android-user.mjs`, with `artifact-inspection/android-tools.ts`
for the runner evidence. The shell is `src/image/device.vibe`, exported from
`@elizaos/os`: `acquireDeviceLease`, `readDeviceLease`, `leaseStateDirectory`,
`requireInstrumentationSuccess`, `requireInstrumentationInterruption`,
`runIsolatedAndroidTest` and `withIsolatedAndroidUser`. A consumer keeps
its own fixtures around them (hosted emulator display, WebView
provisioning, process identity and interruption timing), as
[the os index](../index.md) says.

The shell reads `aapt dump xmltree` and the text `am instrument -w -r`
prints, and parses each into the facts below; anything it cannot parse
counts as the refusing case. A pass is evidence that these tests ran on
the leased fixture, not that an image booted or a person accepted it.

## Story: Run instrumentation on a device I hold alone

> As a test author, I want every instrumentation run to happen on a device
> nobody else is using, with exactly the runners I reviewed and a result
> that cannot be mistaken for a pass, so that a green run means my tests
> passed on that device.

### A lease is active only while its holder lives within its time, or while it is marked for writes

A lease file that is missing or unparsable is never active. A parsed lease
is active while it is marked for writes, whatever else holds; otherwise
only while its time has not run out and its holder process is alive. The
reading names the first reason it is not active.

```quint
type LeaseStatus = LeaseMissing | LeaseInvalid | LeaseWriting | LeaseExpired | LeaseHolderGone | LeaseActive
type LeaseReading = { present: bool, parsed: bool, writeMarked: bool, withinTime: bool, holderAlive: bool }
pure def leaseStatusOf(lease: LeaseReading): LeaseStatus =
  if (not(lease.present)) LeaseMissing
  else if (not(lease.parsed)) LeaseInvalid
  else if (lease.writeMarked) LeaseWriting
  else if (not(lease.withinTime)) LeaseExpired
  else if (not(lease.holderAlive)) LeaseHolderGone
  else LeaseActive
pure def leaseHeld(lease: LeaseReading): bool = leaseStatusOf(lease) == LeaseActive or leaseStatusOf(lease) == LeaseWriting
pure val liveLease: LeaseReading = { present: true, parsed: true, writeMarked: false, withinTime: true, holderAlive: true }
pure val leaseValues = Set(liveLease, { ...liveLease, present: false }, { ...liveLease, parsed: false }, { ...liveLease, holderAlive: false }, { ...liveLease, withinTime: false, writeMarked: true }, { ...liveLease, withinTime: false })
pure def lawLeaseHeldOnlyByALiveTimelyHolderOrAWrite(lease: LeaseReading): bool =
  leaseHeld(lease) iff (lease.present and lease.parsed and (lease.writeMarked or (lease.withinTime and lease.holderAlive)))
```

### A lease lives in the caller's directory, else the one the environment names, in a real directory the operator owns

An explicit state directory wins. Otherwise `ELIZA_DEVICE_LEASE_DIR`
names the lease directory, else `ELIZA_STATE_DIR` names the state
directory whose `device-leases` holds them, else
`~/.local/state/eliza/device-leases`; a variable that is empty or only
spaces names nothing. The shell creates each missing directory owner-only
and syncs its parent, narrows an existing one it owns to owner-only, and
refuses a symbolic link or a directory another user owns. A new lease file
is synced before it is linked into place and its directory after.

```quint
type LeaseDirectory = ExplicitDirectory | LeaseDirectoryVariable | StateDirectoryVariable | HomeStateDirectory
pure def leaseDirectoryOf(explicitGiven: bool, leaseVariableSet: bool, stateVariableSet: bool): LeaseDirectory =
  if (explicitGiven) ExplicitDirectory else if (leaseVariableSet) LeaseDirectoryVariable else if (stateVariableSet) StateDirectoryVariable else HomeStateDirectory
pure def leaseDirectoryAdmitted(realDirectory: bool, ownedByOperator: bool): bool = realDirectory and ownedByOperator
pure def lawAnExplicitDirectoryWins(leaseVariableSet: bool, stateVariableSet: bool): bool =
  leaseDirectoryOf(true, leaseVariableSet, stateVariableSet) == ExplicitDirectory
pure def lawTheLeaseVariableOutranksTheStateVariable(stateVariableSet: bool): bool =
  leaseDirectoryOf(false, true, stateVariableSet) == LeaseDirectoryVariable
pure def lawNoLeaseInALinkOrAnotherUsersDirectory(realDirectory: bool, ownedByOperator: bool): bool =
  leaseDirectoryAdmitted(realDirectory, ownedByOperator) implies (realDirectory and ownedByOperator)
```

### A test APK declares exactly the reviewed runners, each aimed at the app under test

The reviewed runners are the run's runner and the additional runners the
caller names, all distinct. Each `instrumentation` element directly under
the test APK's `manifest` is one declaration. The APK is admitted only when
every declaration names a reviewed runner and targets the app's package,
and every reviewed runner is declared exactly once.

```quint
type RunnerDeclaration = { name: str, targetPackage: str }
pure def runnersAdmitted(declared: List[RunnerDeclaration], reviewed: Set[str], app: str): bool =
  declared.every(d => d.targetPackage == app and reviewed.contains(d.name))
    and reviewed.forall(n => declared.select(d => d.name == n).length() == 1)
pure val junitRunner: RunnerDeclaration = { name: "androidx.test.runner.AndroidJUnitRunner", targetPackage: "ai.example.app" }
pure val declaredValues = Set(List(), List(junitRunner), List(junitRunner, { ...junitRunner, name: "ai.example.app.ProcessRunner" }), List(junitRunner, junitRunner), List({ ...junitRunner, targetPackage: "ai.example.other" }))
pure val reviewedValues = Set(Set("androidx.test.runner.AndroidJUnitRunner"), Set("androidx.test.runner.AndroidJUnitRunner", "ai.example.app.ProcessRunner"))
pure val appValues = Set("ai.example.app")
pure val extraValues = Set(junitRunner, { ...junitRunner, name: "ai.example.app.Unreviewed" })
pure def lawAdmittedRunnersTargetTheApp(declared: List[RunnerDeclaration], reviewed: Set[str], app: str): bool =
  runnersAdmitted(declared, reviewed, app) implies (declared.length() == reviewed.size() and declared.every(d => d.targetPackage == app))
pure def lawAnUnreviewedRunnerRefuses(declared: List[RunnerDeclaration], reviewed: Set[str], app: str, extra: RunnerDeclaration): bool =
  not(reviewed.contains(extra.name)) implies not(runnersAdmitted(declared.append(extra), reviewed, app))
```

### A run passes only when every requested class completes its advertised tests with no failure, skip or crash

The shell parses the output into status blocks and terminal lines. A pass
needs no failure, crash or skipped-assumption marker, exactly one terminal
code and it `-1`, exactly one `OK (n tests)` summary with `n` above zero,
each status block of a requested class advertising `n`, every started test
finishing once without overlap, `n` starts and `n` finishes, every
requested class covered, and no status after the terminal code.

```quint
type InstrumentationReading = { marked: bool, terminalCodes: List[int], summaries: List[int], advertisedMatch: bool, starts: int, finishes: int, overlapping: bool, classesCovered: bool, statusAfterEnd: bool }
pure def instrumentationPassed(reading: InstrumentationReading): bool =
  val advertisedCount = reading.summaries.nthOr(0, 0)
  not(reading.marked) and reading.terminalCodes == List(-1) and reading.summaries.length() == 1
    and advertisedCount > 0 and reading.advertisedMatch and not(reading.overlapping)
    and reading.starts == advertisedCount and reading.finishes == advertisedCount
    and reading.classesCovered and not(reading.statusAfterEnd)
pure val cleanRun: InstrumentationReading = { marked: false, terminalCodes: List(-1), summaries: List(2), advertisedMatch: true, starts: 2, finishes: 2, overlapping: false, classesCovered: true, statusAfterEnd: false }
pure val readingValues = Set(cleanRun, { ...cleanRun, marked: true }, { ...cleanRun, finishes: 1 }, { ...cleanRun, terminalCodes: List(-1, -1) }, { ...cleanRun, summaries: List(0), starts: 0, finishes: 0 })
pure def lawAPassFinishesEveryAdvertisedTest(reading: InstrumentationReading): bool =
  instrumentationPassed(reading) implies (reading.starts > 0 and reading.starts == reading.finishes and not(reading.marked))
```

### An interruption is one started test ended by a process crash, and is never a pass

A run the caller interrupted on purpose counts as interrupted only when it
selected one class and method, printed no failure, skip or `OK` summary,
exactly one status code and it `1` (started) for that class and method with
one advertised test and no terminal line before it, then no further status,
exactly one terminal code `0` with exactly one `Process crashed.` result,
and nothing after the terminal code.

```quint
type InterruptionReading = { marked: bool, statusCodes: List[int], identityMatches: bool, advertised: int, terminalBeforeStart: bool, statusAfterStart: bool, terminalCodes: List[int], crashResults: int, linesAfterEnd: bool }
pure def interruptionProven(crash: InterruptionReading): bool =
  not(crash.marked) and crash.statusCodes == List(1) and crash.identityMatches and crash.advertised == 1
    and not(crash.terminalBeforeStart) and not(crash.statusAfterStart) and crash.terminalCodes == List(0)
    and crash.crashResults == 1 and not(crash.linesAfterEnd)
pure val crashedStart: InterruptionReading = { marked: false, statusCodes: List(1), identityMatches: true, advertised: 1, terminalBeforeStart: false, statusAfterStart: false, terminalCodes: List(0), crashResults: 1, linesAfterEnd: false }
pure val crashValues = Set(crashedStart, { ...crashedStart, statusCodes: List(1, 0) }, { ...crashedStart, crashResults: 0 }, { ...crashedStart, terminalCodes: List(-1) }, { ...crashedStart, marked: true })
pure def lawInterruptionNeverFinishesATest(crash: InterruptionReading): bool =
  interruptionProven(crash) implies (not(crash.statusCodes.includes(0)) and not(crash.terminalCodes.includes(-1)))
```

## Story: Run a test in a fresh Android user that is removed afterwards

> As a test author, I want a scenario to run in a new secondary user on my
> leased emulator and the owner restored afterwards, so that its data
> never leaks into the owner's and a user I could not prove clean is kept
> for me to inspect instead of being destroyed.

### A test user is created only on a leased emulator with the owner in the foreground

The caller holds the emulator's lease for the whole run, in this process,
unchanged and active; the selected emulator is the AVD the caller names;
user 0 is in the foreground. The new user is entered only when Android
reports it created, it starts, the named Home package resolves for it, it
becomes the foreground user and its Home is resumed in it, each within the
caller's deadlines.

```quint
type UserAdmission = { emulatorSerial: bool, callerLeaseHeld: bool, avdMatches: bool, ownerForeground: bool }
pure def userRunAdmitted(admission: UserAdmission): bool =
  admission.emulatorSerial and admission.callerLeaseHeld and admission.avdMatches and admission.ownerForeground
pure val heldEmulator: UserAdmission = { emulatorSerial: true, callerLeaseHeld: true, avdMatches: true, ownerForeground: true }
pure val admissionValues = Set(heldEmulator, { ...heldEmulator, callerLeaseHeld: false }, { ...heldEmulator, ownerForeground: false }, { ...heldEmulator, emulatorSerial: false })
pure def lawNoUserWithoutTheLease(admission: UserAdmission): bool = userRunAdmitted(admission) implies admission.callerLeaseHeld
```

### The owner is restored first, and the test user is removed only when the run proved its packages clean

Afterwards the shell switches back to user 0 and waits for its activity to
resume. It removes the test user only when the owner was restored and
either the run never entered the user or the run reported its packages
cleaned and nothing deferred; otherwise it keeps the user, records why and
fails the run. A removal is done only when the user stopped, Android
reports the removal and the user list no longer shows it.

```quint
type UserCleanup = RemoveTestUser | KeepTestUser
pure def userCleanup(ownerRestored: bool, entered: bool, runCleaned: bool, runDeferred: bool): UserCleanup =
  if (ownerRestored and (not(entered) or (runCleaned and not(runDeferred)))) RemoveTestUser else KeepTestUser
pure def lawAnUnprovedRunKeepsItsUser(ownerRestored: bool, entered: bool, runCleaned: bool, runDeferred: bool): bool =
  (entered and (not(runCleaned) or runDeferred)) implies userCleanup(ownerRestored, entered, runCleaned, runDeferred) == KeepTestUser
pure def lawNoRemovalBeforeTheOwnerIsBack(entered: bool, runCleaned: bool, runDeferred: bool): bool =
  userCleanup(false, entered, runCleaned, runDeferred) == KeepTestUser
```
