# Device qualification

Read-only qualification of one connected Android device against a
requirements file. Sources: `packages/os/scripts/android/device-qualify.ts`
and `device-qualify-lib.ts` on develop, and the default requirements
`android/device-requirements/treble-gsi.json` (Treble vendor interface,
vendor API 33 or newer, kernel 5.10 or newer, `arm64-v8a`, dynamic
partitions, enforcing SELinux; an unlockable bootloader in fastboot mode).
A consumer passes its own product file with `--requirements` and imports
`evaluate` and `validateRequirements` in its tests.

The shell runs the fixed commands, keeps every raw capture in the record,
parses each capture into facts, and maps each fact to an observation. This
library decides which commands a run may issue, whether a run starts, what
each requirement yields and what the verdict is. Integer readings are in the
units the shell chooses for a requirement (hundredths of a GiB for memory
and storage, so `3.7` is `370`). A pass is observation evidence only: it is
not an image boot, nor RF, acoustic, battery or user-acceptance evidence,
and the record says so.

## Story: Qualify a device read-only

> As a device maintainer, I want to check a device against my requirements
> without changing it, so that qualification can never alter, flash or
> transmit from the device it inspects.

### A run issues only allowlisted adb reads or fastboot getvar, never both

An adb run checks `get-state` and then runs only the shell reads named here,
each a fixed command string in the shell that writes nothing. A fastboot run
issues only `getvar all` and `getvar partition-type:avb_custom_key`. No
command kind exists for installs, settings, flashing or transmissions.

```quint
type ProbeMode = AdbProbe | FastbootProbe
type DeviceCommand = AdbGetState | AdbShellRead({ key: str }) | FastbootGetvar({ name: str })
pure val readOnlyCommandKeys: Set[str] = Set("getprop", "uname", "meminfo", "dfData", "wmSize", "wmDensity", "getenforce", "cameras", "audioPolicy", "mediaCodecs", "wifiCountry", "wifiStatus", "wifiDump", "chargeControl", "battery", "wlanCountryProc", "vendorFirmware", "vintfManifest", "vintfFragments", "vintfMatrix")
pure val fastbootGetvarNames: Set[str] = Set("all", "partition-type:avb_custom_key")
pure def commandAllowed(mode: ProbeMode, command: DeviceCommand): bool = match command { | AdbGetState => mode == AdbProbe | AdbShellRead(c) => mode == AdbProbe and readOnlyCommandKeys.contains(c.key) | FastbootGetvar(g) => mode == FastbootProbe and fastbootGetvarNames.contains(g.name) }
pure val commandValues = Set(AdbGetState, AdbShellRead({ key: "getprop" }), AdbShellRead({ key: "pm install" }), FastbootGetvar({ name: "all" }), FastbootGetvar({ name: "flash" }))
pure def lawNoCommandServesBothModes(command: DeviceCommand): bool = not(commandAllowed(AdbProbe, command) and commandAllowed(FastbootProbe, command))
pure def lawUnlistedShellReadIsRefused(command: DeviceCommand, mode: ProbeMode): bool = match command { | AdbShellRead(c) => not(readOnlyCommandKeys.contains(c.key)) implies not(commandAllowed(mode, command)) | _ => true }
```

### A run starts only for an explicit serial, valid requirements and a nonempty list for its mode

The serial is required so that a run never touches another device. A
requirements file has schema version 1, at least one adb requirement, and
ids unique across the adb and fastboot lists; `wellFormed` is the shell's
parse of one entry (an id of lowercase letters, digits and hyphens, a known
check, and for an identity check a supported field and a nonempty expected
value). A fastboot run needs at least one fastboot requirement. A device
that does not answer `get-state` with `device`, or does not answer
`getvar`, fails the run in the shell before any verdict.

```quint
type RequirementLevel = Required | Preferred
type Requirement = { id: str, level: RequirementLevel, mode: ProbeMode, wellFormed: bool }
type RunAdmission = RunAdmitted | RefusedSerial | RefusedRequirements | RefusedNoFastbootRequirements
pure def idUnique(reqs: List[Requirement], id: str): bool = reqs.select(q => q.id == id).length() == 1
pure def hasRequirementFor(reqs: List[Requirement], mode: ProbeMode): bool = reqs.some(r => r.mode == mode)
pure def requirementsValid(schemaVersion: int, reqs: List[Requirement]): bool = schemaVersion == 1 and hasRequirementFor(reqs, AdbProbe) and reqs.every(r => r.wellFormed and idUnique(reqs, r.id))
pure def admitRun(serialWellFormed: bool, schemaVersion: int, reqs: List[Requirement], mode: ProbeMode): RunAdmission = if (not(serialWellFormed)) RefusedSerial else if (not(requirementsValid(schemaVersion, reqs))) RefusedRequirements else if (not(hasRequirementFor(reqs, mode))) RefusedNoFastbootRequirements else RunAdmitted
pure val adbTreble: Requirement = { id: "treble", level: Required, mode: AdbProbe, wellFormed: true }
pure val fastbootUnlock: Requirement = { id: "unlockable", level: Required, mode: FastbootProbe, wellFormed: true }
pure val reqsValues = Set(List(), List(adbTreble), List(adbTreble, fastbootUnlock), List(fastbootUnlock), List(adbTreble, { ...fastbootUnlock, id: "treble" }), List({ ...adbTreble, wellFormed: false }))
pure def lawAdmittedRunHasUniqueRequirementsForItsMode(serialWellFormed: bool, schemaVersion: int, reqs: List[Requirement], mode: ProbeMode): bool = admitRun(serialWellFormed, schemaVersion, reqs, mode) == RunAdmitted implies (serialWellFormed and hasRequirementFor(reqs, mode) and reqs.every(r => idUnique(reqs, r.id)))
```

## Story: Read the verdict against my requirements

> As a device maintainer, I want each requirement marked met, unmet or
> unknown and one verdict from the required ones, so that a missing reading
> is never mistaken for a pass or a failure.

### A fact that was not read makes its requirement Unknown, never Met or Unmet

Every check yields `Met`, `Unmet` or `Unknown`. A capture that failed or a
fact the parser could not find is `Unobserved`, including an empty camera,
microphone or charge-control reading; a boolean property is `Unobserved`
only when the property dump itself was not read. Threshold checks compare
a reading with the requirement's minimum, and raising the minimum never
turns an unmet reading into a met one.

```quint
type CheckOutcome = Met | Unmet | Unknown
type Observation = Unobserved | Observed({ satisfied: bool })
type Reading = NotRead | ReadValue({ value: int })
pure def outcomeOf(observation: Observation): CheckOutcome = match observation { | Unobserved => Unknown | Observed(o) => if (o.satisfied) Met else Unmet }
pure def atLeast(reading: Reading, minimum: int): Observation = match reading { | NotRead => Unobserved | ReadValue(r) => Observed({ satisfied: r.value >= minimum }) }
pure val readingValues = Set(NotRead, ReadValue({ value: 2 }), ReadValue({ value: 33 }), ReadValue({ value: 370 }))
pure def lawUnreadIsUnknownOnly(reading: Reading, minimum: int): bool = (outcomeOf(atLeast(reading, minimum)) == Unknown) iff (reading == NotRead)
pure def lawRaisingTheMinimumNeverMeetsMore(reading: Reading, low: int, high: int): bool = (low <= high and outcomeOf(atLeast(reading, high)) == Met) implies outcomeOf(atLeast(reading, low)) == Met
```

### A vendor API level written as YYYYMM counts as its Android SDK level

From Android 15 the vendor API level is a year and month (`202404` is
SDK 35, `202504` is SDK 36); the month does not change the level. A value
below `200000` is already an SDK level.

```quint
pure def normalizeVendorApiLevel(level: int): int = if (level < 200000) level else 35 + (level / 100 - 2024)
pure def vendorApiAtLeast(reading: Reading, minimum: int): Observation = match reading { | NotRead => Unobserved | ReadValue(r) => Observed({ satisfied: normalizeVendorApiLevel(r.value) >= minimum }) }
pure val yearValues = Set(2024, 2025, 2030)
pure val monthValues = Set(1, 4, 12)
pure def lawVendorApiMonthMapsToRelease(year: int, month: int): bool = (year >= 2024 and year <= 9999 and month >= 1 and month <= 12) implies normalizeVendorApiLevel(year * 100 + month) == 35 + year - 2024
```

### A device qualifies only when every required requirement is Met

Any required `Unmet` gives `Disqualified`, whatever else is unknown;
otherwise any required `Unknown` gives `Incomplete`. A preferred
requirement never changes the verdict: each one not `Met` is a warning. The
shell reports the verdicts as `pass`, `fail` and `incomplete`.

```quint
type RequirementResult = { id: str, level: RequirementLevel, checkOutcome: CheckOutcome }
type Verdict = Qualified | Disqualified | Incomplete
pure def requiredWith(results: List[RequirementResult], wanted: CheckOutcome): bool = results.some(r => r.level == Required and r.checkOutcome == wanted)
pure def verdictOf(results: List[RequirementResult]): Verdict = if (requiredWith(results, Unmet)) Disqualified else if (requiredWith(results, Unknown)) Incomplete else Qualified
pure def warningsOf(results: List[RequirementResult]): List[str] = results.select(r => r.level == Preferred and r.checkOutcome != Met).listMap(r => r.id)
pure val requiredMet: RequirementResult = { id: "treble", level: Required, checkOutcome: Met }
pure val extraValues = Set(requiredMet, { ...requiredMet, checkOutcome: Unmet }, { ...requiredMet, checkOutcome: Unknown }, { id: "ab-updates", level: Preferred, checkOutcome: Unmet }, { id: "ab-updates", level: Preferred, checkOutcome: Unknown })
pure val resultsValues = Set(List(), List(requiredMet), List(requiredMet, { ...requiredMet, id: "abi", checkOutcome: Unknown }), List({ ...requiredMet, checkOutcome: Unmet }, { ...requiredMet, id: "abi", checkOutcome: Unknown }), List({ id: "ab-updates", level: Preferred, checkOutcome: Unmet }))
pure def lawQualifiedIffEveryRequiredMet(results: List[RequirementResult]): bool = (verdictOf(results) == Qualified) iff results.every(r => r.level == Preferred or r.checkOutcome == Met)
pure def lawUnmetOutranksUnknown(results: List[RequirementResult], extra: RequirementResult): bool = (extra.level == Required and extra.checkOutcome == Unmet) implies verdictOf(results.append(extra)) == Disqualified
pure def lawPreferredNeverDecides(results: List[RequirementResult], extra: RequirementResult): bool = extra.level == Preferred implies verdictOf(results.append(extra)) == verdictOf(results)
pure def lawRequiredNeverWarns(results: List[RequirementResult], extra: RequirementResult): bool = extra.level == Required implies warningsOf(results.append(extra)) == warningsOf(results)
```

### An emulator capture is never device evidence

The record labels its evidence: an emulator capture (`ro.kernel.qemu` or
`ro.boot.qemu` is `1`) is emulator observation in either mode, a fastboot
capture is bootloader observation, and only an adb capture of real hardware
is device observation.

```quint
type EvidenceLevel = EmulatorObservation | DeviceObservation | BootloaderObservation
type Qualification = { verdict: Verdict, evidence: EvidenceLevel, warnings: List[str] }
pure def evidenceOf(emulator: bool, mode: ProbeMode): EvidenceLevel = if (emulator) EmulatorObservation else if (mode == FastbootProbe) BootloaderObservation else DeviceObservation
pure def qualificationOf(results: List[RequirementResult], emulator: bool, mode: ProbeMode): Qualification = { verdict: verdictOf(results), evidence: evidenceOf(emulator, mode), warnings: warningsOf(results) }
pure def lawDeviceEvidenceIsRealHardwareOverAdb(results: List[RequirementResult], emulator: bool, mode: ProbeMode): bool = qualificationOf(results, emulator, mode).evidence == DeviceObservation iff (not(emulator) and mode == AdbProbe)
```
