# Computer use sessions

This area defines the formal rules for desktop, browser, sandbox, and mobile computer-use automation:

- [Sessions](./sessions.md) — session lifecycle, leases, epoch isolation, and observation freshness
- [Approvals](./approvals.md) — approval modes (`full_control`, `smart_approve`, `approve_all`, `off`) and pending approval queue
- [Observation](./observation.md) — dHash change detection, image attachment policy, pixel budgets, coordinate bounds, and bounded history
- [Batching](./batching.md) — multi-step action sequences that reduce LLM round-trips while preserving stop-on-error semantics

## Story: Control an authorized computer session

> As the owner, I can inspect and control a session I selected. A request for a previously closed session cannot affect the current computer or browser tab.

### A command is scoped to one session generation, surface and authorized operation

The shell binds the device, browser or approved remote connector to a session. It validates the initiating principal, screenshot and clipboard access, tab identifiers, and the requested operation before dispatching it to the bound host. The caller supplies the session generation and surface it expects; the shell never fills them in from the session itself.

```quint
type ComputerSurface = LocalDesktop | BrowserSurface | MobileDevice | RemoteDesktop
type ComputerOperation = ReadScreen | ClickTarget | TypeText | WindowControl | ClipboardRead | ClipboardWrite | FileRead | FileWrite | TerminalExecute | BrowserControl | AppControl
type ComputerSession = { sessionId: str, ownerId: str, sessionEpoch: int, surface: ComputerSurface, operations: Set[ComputerOperation], open: bool }
type ComputerCommand = { callerId: str, forSession: str, expectedEpoch: int, forSurface: ComputerSurface, operation: ComputerOperation }
pure def computerCommandAllowed(session: ComputerSession, command: ComputerCommand): bool =
  session.open and session.sessionId != "" and session.ownerId != "" and session.sessionId == command.forSession and
  session.ownerId == command.callerId and session.sessionEpoch == command.expectedEpoch and
  session.surface == command.forSurface and session.operations.contains(command.operation)
pure def lawClosedSessionRefusesCommands(session: ComputerSession, command: ComputerCommand): bool =
  not(session.open) implies not(computerCommandAllowed(session, command))
pure def lawGenerationMismatchRefusesCommands(session: ComputerSession, command: ComputerCommand): bool =
  session.sessionEpoch != command.expectedEpoch implies not(computerCommandAllowed(session, command))
```

### A session grants only the operations its bound target can carry out, and each command is its own operation

Reading or writing files, running terminal commands, driving a browser and acting on an application are distinct operations, never a screen click. A session on the host grants every operation. A session on any other target (sandbox, browser, remote guest) grants none, and cannot be created, until the host registers an executor and a frame provider for that target kind; it never falls through to the host's own desktop or shell. Terminal execution, file deletion and browser script execution are destructive; file and terminal reads are read-only; the other commands mutate. Before asking for approval, the shell refuses a terminal command that matches its dangerous-command filter, a file path on its deny-list, and passes child processes an environment stripped of credentials.

```quint
pure val allOperations: Set[ComputerOperation] = Set(ReadScreen, ClickTarget, TypeText, WindowControl, ClipboardRead, ClipboardWrite, FileRead, FileWrite, TerminalExecute, BrowserControl, AppControl)
pure def grantedOperations(isHostTarget: bool, targetBound: bool): Set[ComputerOperation] =
  if (isHostTarget or targetBound) allOperations else Set()
pure def maySessionCarry(isHostTarget: bool, targetBound: bool, operation: ComputerOperation): bool =
  grantedOperations(isHostTarget, targetBound).contains(operation)
pure def lawUnboundTargetCarriesNothing(operation: ComputerOperation): bool =
  not(maySessionCarry(false, false, operation))
```

### A pending operation accepts only the observation for its own identifier and session generation

The remote or local shell authenticates the observation source. Cancelled or stale operations leave the latest observed session state untouched.

```quint
type OperationObservation = { observedSession: str, observedEpoch: int, operationId: str }
pure def acceptsComputerObservation(session: ComputerSession, currentOperation: str, observation: OperationObservation): bool =
  session.open and currentOperation != "" and observation.operationId == currentOperation and
  observation.observedSession == session.sessionId and observation.observedEpoch == session.sessionEpoch
pure def lawStaleOperationCannotProduceObservation(session: ComputerSession, currentOperation: str, observation: OperationObservation): bool =
  observation.operationId != currentOperation implies not(acceptsComputerObservation(session, currentOperation, observation))
pure val sessionValues = Set({ sessionId: "desk-1", ownerId: "owner", sessionEpoch: 2, surface: LocalDesktop, operations: Set(ReadScreen, ClickTarget), open: true }, { sessionId: "desk-1", ownerId: "owner", sessionEpoch: 3, surface: BrowserSurface, operations: Set(ReadScreen), open: false })
pure val commandValues = Set({ callerId: "owner", forSession: "desk-1", expectedEpoch: 2, forSurface: LocalDesktop, operation: ReadScreen }, { callerId: "other", forSession: "desk-1", expectedEpoch: 1, forSurface: RemoteDesktop, operation: ClipboardRead })
pure val observationValues = Set({ observedSession: "desk-1", observedEpoch: 2, operationId: "capture-1" }, { observedSession: "desk-1", observedEpoch: 1, operationId: "old" })
```
