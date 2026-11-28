# Optional file log sinks

File logging is optional, initializes on first use and reports failures
without failing the agent. Redaction and formatting occur before these
sinks receive their bytes. The in-memory sink of [logging](./index.md)
runs beside them.

## Story: Open optional log files lazily and close their descriptors

> As an operator, I want optional log files that open on first use and
> unwind every acquired descriptor when opening fails.

I can enable file logging through the host setting. Silent
logging and an absent or disabled file setting suppress initialization.
The three sinks are opened sequentially in append mode with creation mode
0600 and a best-effort permission repair. The process exit handler is
installed after all three descriptors open successfully.

### A single initialization attempt opens output, prompt and chat sinks in order

An unsuccessful initialization attempts one close for each acquired descriptor
in reverse acquisition order before permanently disabling file writes. A close
error does not prove that its numeric descriptor still names the acquired
resource. Each attempt consumes that logger-owned handle, including when the
native release is uncertain; the remaining earlier handles still receive their
own close attempt. No retired descriptor number is retried or used for writes.
`ClosingUncertain` records a failed close while the remaining handles unwind.
After the unwind, `CleanupFailed` retains only the uncertain-release receipt,
with no logger-owned descriptor available for reuse. It remains terminal until
process exit. Actual native liveness after an error is not claimed.

```quint
type FilePhase = Pending | Opening | Active | ClosingFailure | ClosingUncertain | CleanupFailed | Disabled | Exited
type LogFiles = { phase: FilePhase, outputOwned: bool, promptOwned: bool, chatOwned: bool, exitHandler: bool, initializationFailed: bool, outputWarnings: int, outputWarned: bool, writes: int, promptCounter: int }
pure val initial: LogFiles = { phase: Pending, outputOwned: false, promptOwned: false, chatOwned: false, exitHandler: false, initializationFailed: false, outputWarnings: 0, outputWarned: false, writes: 0, promptCounter: 0 }
pure def canInitialize(s: LogFiles, silent: bool, fileEnabled: bool): bool = s.phase == Pending
pure def initialize(s: LogFiles, silent: bool, fileEnabled: bool): LogFiles = { ...s, phase: if (silent or not(fileEnabled)) Disabled else Opening }
pure def canOpenNext(s: LogFiles, succeeded: bool): bool = s.phase == Opening
pure def openNext(s: LogFiles, succeeded: bool): LogFiles =
  if (not(succeeded)) { ...s, phase: ClosingFailure, initializationFailed: true }
  else if (not(s.outputOwned)) { ...s, outputOwned: true }
  else if (not(s.promptOwned)) { ...s, promptOwned: true }
  else { ...s, chatOwned: true, exitHandler: true, phase: Active }
pure def canWriteOutput(s: LogFiles, succeeded: bool): bool = s.phase == Active and s.outputOwned
pure def writeOutput(s: LogFiles, succeeded: bool): LogFiles = { ...s, writes: s.writes + (if (succeeded) 1 else 0), outputWarnings: s.outputWarnings + (if (not(succeeded) and not(s.outputWarned)) 1 else 0), outputWarned: s.outputWarned or not(succeeded) }
pure def canWritePrompt(s: LogFiles): bool = s.phase == Active and s.promptOwned
pure def writePrompt(s: LogFiles): LogFiles = { ...s, promptCounter: s.promptCounter + 1 }
pure def canCloseFailedAcquisition(s: LogFiles, acknowledged: bool): bool = (s.phase == ClosingFailure or s.phase == ClosingUncertain) and (s.outputOwned or s.promptOwned or s.chatOwned)
pure def closeFailedAcquisition(s: LogFiles, acknowledged: bool): LogFiles = {
  val remaining = if (s.chatOwned) { ...s, chatOwned: false } else if (s.promptOwned) { ...s, promptOwned: false } else { ...s, outputOwned: false }
  { ...remaining, phase: if (not(acknowledged)) ClosingUncertain else s.phase }
}
pure def canFinishFailedAcquisition(s: LogFiles): bool = (s.phase == ClosingFailure or s.phase == ClosingUncertain) and not(s.outputOwned or s.promptOwned or s.chatOwned)
pure def finishFailedAcquisition(s: LogFiles): LogFiles = { ...s, phase: if (s.phase == ClosingUncertain) CleanupFailed else Disabled }
pure def exitProcess(s: LogFiles): LogFiles = { ...s, phase: Exited, outputOwned: false, promptOwned: false, chatOwned: false }
pure def alwaysActiveFilesAreComplete(s: LogFiles): bool = s.phase == Active implies s.outputOwned and s.promptOwned and s.chatOwned and s.exitHandler
pure def alwaysDescriptorsOwnedInOrder(s: LogFiles): bool = (s.chatOwned implies s.promptOwned) and (s.promptOwned implies s.outputOwned)
pure def alwaysWarnsOnce(s: LogFiles): bool = s.outputWarnings >= 0 and s.outputWarnings <= 1 and (s.outputWarned == (s.outputWarnings == 1))
pure def alwaysExitReleasesOwnership(s: LogFiles): bool = s.phase == Exited implies not(s.outputOwned) and not(s.promptOwned) and not(s.chatOwned)
pure def alwaysFailedAcquisitionCannotBecomeActive(s: LogFiles): bool = s.initializationFailed implies (s.phase == ClosingFailure or s.phase == ClosingUncertain or s.phase == CleanupFailed or s.phase == Disabled or s.phase == Exited)
pure def alwaysDisabledHasNoOwnership(s: LogFiles): bool = s.phase == Disabled implies not(s.outputOwned) and not(s.promptOwned) and not(s.chatOwned)
pure def alwaysCleanupFailureHasNoOwnership(s: LogFiles): bool = s.phase == CleanupFailed implies not(s.outputOwned or s.promptOwned or s.chatOwned)
pure def alwaysCountersNonnegative(s: LogFiles): bool = s.writes >= 0 and s.promptCounter >= 0
pure def sometimesActiveSinks(s: LogFiles): bool = s.phase == Active
pure def sometimesPartialOpenFailure(s: LogFiles): bool = s.phase == Disabled and s.initializationFailed and not(s.exitHandler)
pure def sometimesCleanupFailureRecordsUncertainRelease(s: LogFiles): bool = s.phase == CleanupFailed and not(s.outputOwned or s.promptOwned or s.chatOwned)
pure def sometimesRepeatedWriteFailureWarnedOnce(s: LogFiles): bool = s.outputWarned and s.outputWarnings == 1
```

### Pending initialization owns no descriptor

An uninitialized state with an already-open
descriptor could disable logging while leaking it. The constructor owns
no resources until the first successful open.

```quint
pure def alwaysPendingHasNoOwnership(s: LogFiles): bool = s.phase == Pending implies not(s.outputOwned) and not(s.promptOwned) and not(s.chatOwned) and not(s.exitHandler)
```
