# Optional file log sinks

The source is `ensureFileLog`, `openLogFilePrivate`,
`writeLogEntryToFile`, `logPrompt` and chat logging in
`packages/core/src/logger.ts` at
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. File logging is optional,
initializes on first use and reports failures without failing the agent.
Redaction and formatting occur before these sinks receive their bytes.

## Story: Open optional log files lazily and close their descriptors

As an operator, I can enable file logging through the host setting. Silent
logging and an absent or disabled file setting suppress initialization.
The three sinks are opened sequentially in append mode with creation mode
0600 and a best-effort permission repair. The process exit handler is
installed after all three descriptors open successfully.

### A single initialization attempt opens output prompt and chat sinks in order

The rewrite closes every descriptor acquired by an unsuccessful
initialization before disabling the sinks. This is an internal resource
cleanup correction. The baseline retained those descriptors until process
termination. Both paths expose the same unsuccessful initialization result.
The future Effect acquisition scope must exercise failure at each of the
three open operations and verify that every earlier acquisition is released.
A failed close retains descriptor ownership in an explicit cleanup-failure
state until retry or process exit. That state cannot enable file writes.

```quint
type FilePhase = Pending | Opening | Active | ClosingFailure | CleanupFailed | Disabled | Exited
type LogFiles = { phase: FilePhase, outputOpen: bool, promptOpen: bool, chatOpen: bool, exitHandler: bool, initializationFailed: bool, outputWarnings: int, outputWarned: bool, writes: int, promptCounter: int }
pure val initial: LogFiles = { phase: Pending, outputOpen: false, promptOpen: false, chatOpen: false, exitHandler: false, initializationFailed: false, outputWarnings: 0, outputWarned: false, writes: 0, promptCounter: 0 }
pure def canInitialize(s: LogFiles, silent: bool, fileEnabled: bool): bool = s.phase == Pending
pure def initialize(s: LogFiles, silent: bool, fileEnabled: bool): LogFiles = { ...s, phase: if (silent or not(fileEnabled)) Disabled else Opening }
pure def canOpenNext(s: LogFiles, succeeded: bool): bool = s.phase == Opening
pure def openNext(s: LogFiles, succeeded: bool): LogFiles =
  if (not(succeeded)) { ...s, phase: ClosingFailure, initializationFailed: true }
  else if (not(s.outputOpen)) { ...s, outputOpen: true }
  else if (not(s.promptOpen)) { ...s, promptOpen: true }
  else { ...s, chatOpen: true, exitHandler: true, phase: Active }
pure def canWriteOutput(s: LogFiles, succeeded: bool): bool = s.phase == Active and s.outputOpen
pure def writeOutput(s: LogFiles, succeeded: bool): LogFiles = { ...s, writes: s.writes + (if (succeeded) 1 else 0), outputWarnings: s.outputWarnings + (if (not(succeeded) and not(s.outputWarned)) 1 else 0), outputWarned: s.outputWarned or not(succeeded) }
pure def canWritePrompt(s: LogFiles): bool = s.phase == Active and s.promptOpen
pure def writePrompt(s: LogFiles): LogFiles = { ...s, promptCounter: s.promptCounter + 1 }
pure def canCloseFailedAcquisition(s: LogFiles, closed: bool): bool = s.phase == ClosingFailure and (s.outputOpen or s.promptOpen or s.chatOpen)
pure def closeFailedAcquisition(s: LogFiles, closed: bool): LogFiles =
  if (not(closed)) { ...s, phase: CleanupFailed }
  else if (s.chatOpen) { ...s, chatOpen: false }
  else if (s.promptOpen) { ...s, promptOpen: false }
  else { ...s, outputOpen: false }
pure def canRetryFailedCleanup(s: LogFiles): bool = s.phase == CleanupFailed
pure def retryFailedCleanup(s: LogFiles): LogFiles = { ...s, phase: ClosingFailure }
pure def canFinishFailedAcquisition(s: LogFiles): bool = s.phase == ClosingFailure and not(s.outputOpen or s.promptOpen or s.chatOpen)
pure def finishFailedAcquisition(s: LogFiles): LogFiles = { ...s, phase: Disabled }
pure def exitProcess(s: LogFiles): LogFiles = { ...s, phase: Exited, outputOpen: false, promptOpen: false, chatOpen: false }
pure def alwaysActiveFilesAreComplete(s: LogFiles): bool = s.phase == Active implies s.outputOpen and s.promptOpen and s.chatOpen and s.exitHandler
pure def alwaysDescriptorsOpenInOrder(s: LogFiles): bool = (s.chatOpen implies s.promptOpen) and (s.promptOpen implies s.outputOpen)
pure def alwaysWarnsOnce(s: LogFiles): bool = s.outputWarnings >= 0 and s.outputWarnings <= 1 and (s.outputWarned == (s.outputWarnings == 1))
pure def alwaysExitClosesDescriptors(s: LogFiles): bool = s.phase == Exited implies not(s.outputOpen) and not(s.promptOpen) and not(s.chatOpen)
pure def alwaysFailedAcquisitionCannotBecomeActive(s: LogFiles): bool = s.initializationFailed implies (s.phase == ClosingFailure or s.phase == CleanupFailed or s.phase == Disabled or s.phase == Exited)
pure def alwaysDisabledHasNoDescriptors(s: LogFiles): bool = s.phase == Disabled implies not(s.outputOpen) and not(s.promptOpen) and not(s.chatOpen)
pure def alwaysCountersNonnegative(s: LogFiles): bool = s.writes >= 0 and s.promptCounter >= 0
pure def sometimesActiveSinks(s: LogFiles): bool = s.phase == Active
pure def sometimesPartialOpenFailure(s: LogFiles): bool = s.phase == Disabled and s.initializationFailed and not(s.exitHandler)
pure def sometimesCleanupFailureRetainsOwnership(s: LogFiles): bool = s.phase == CleanupFailed and (s.outputOpen or s.promptOpen or s.chatOpen)
pure def sometimesRepeatedWriteFailureWarnedOnce(s: LogFiles): bool = s.outputWarned and s.outputWarnings == 1
```

### Pending initialization owns no descriptor

Discovered by the proof: an uninitialized state with an already-open
descriptor could disable logging while leaking it. The constructor owns
no resources until the first successful open.

```quint
pure def alwaysPendingHasNoDescriptors(s: LogFiles): bool = s.phase == Pending implies not(s.outputOpen) and not(s.promptOpen) and not(s.chatOpen) and not(s.exitHandler)
```
