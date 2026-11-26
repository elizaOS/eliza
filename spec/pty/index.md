# Interactive terminals

Session lifecycle, access gates, spawn policy, capacity, and output bounds are specified in [Session store, access and spawn policy](./policy.md).

## Story: Open and close an owner-bound terminal session

> As the owner, I can attach to my interactive process, send input or resize it, and close it. Output from a previous process does not appear in a replacement session.

### A terminal binds one owner and one process generation

The shell obtains owner access at the local route, applies the configured command and directory policy, and spawns the actual PTY. It sends process observations with the exact terminal identifier and generation. Credentials and inherited process configuration are not included in the owner snapshot.

```quint
type TerminalPhase = TerminalClosed | TerminalStarting | TerminalOpen | TerminalClosing
type TerminalSession = { terminalPhase: TerminalPhase, terminalOwner: str, terminalId: str, terminalEpoch: int }
pure val initial: TerminalSession = { terminalPhase: TerminalClosed, terminalOwner: "", terminalId: "", terminalEpoch: 0 }
pure val ownerIdValues = Set("owner", "other")
pure val terminalKeyValues = Set("term-a", "term-b")
pure val epochValues = Set(1, 2)
pure def canOpenTerminal(s: TerminalSession, ownerId: str, terminalKey: str, by: str): bool =
  s.terminalPhase == TerminalClosed and ownerId != "" and terminalKey != "" and by == ownerId
pure def openTerminal(s: TerminalSession, ownerId: str, terminalKey: str, by: str): TerminalSession =
  { terminalPhase: TerminalStarting, terminalOwner: ownerId, terminalId: terminalKey, terminalEpoch: s.terminalEpoch + 1 }
pure def matchesProcess(s: TerminalSession, terminalKey: str, epoch: int): bool = s.terminalId == terminalKey and s.terminalEpoch == epoch
pure def canAcknowledgeTerminal(s: TerminalSession, terminalKey: str, epoch: int, by: str): bool =
  s.terminalPhase == TerminalStarting and by == "pty" and matchesProcess(s, terminalKey, epoch)
pure def acknowledgeTerminal(s: TerminalSession, terminalKey: str, epoch: int, started: bool, by: str): TerminalSession =
  { ...s, terminalPhase: if (started) TerminalOpen else TerminalClosed }
pure def terminalAcceptsInput(s: TerminalSession, terminalKey: str, epoch: int, ownerId: str): bool =
  s.terminalPhase == TerminalOpen and s.terminalOwner == ownerId and matchesProcess(s, terminalKey, epoch)
pure def lawReplacedTerminalRejectsInput(s: TerminalSession, terminalKey: str, epoch: int, ownerId: str): bool =
  epoch != s.terminalEpoch implies not(terminalAcceptsInput(s, terminalKey, epoch, ownerId))
```

### Closing stops the terminal from accepting input and keeps the same process identity until exit

```quint
pure def canCloseTerminal(s: TerminalSession, terminalKey: str, epoch: int, by: str): bool =
  terminalAcceptsInput(s, terminalKey, epoch, by) or
  (s.terminalPhase == TerminalStarting and by == s.terminalOwner and matchesProcess(s, terminalKey, epoch))
pure def closeTerminal(s: TerminalSession, terminalKey: str, epoch: int, by: str): TerminalSession =
  { ...s, terminalPhase: TerminalClosing }
pure def canObserveTerminalExit(s: TerminalSession, terminalKey: str, epoch: int, by: str): bool =
  s.terminalPhase != TerminalClosed and by == "pty" and matchesProcess(s, terminalKey, epoch)
pure def observeTerminalExit(s: TerminalSession, terminalKey: str, epoch: int, by: str): TerminalSession =
  { ...s, terminalPhase: TerminalClosed }
pure def stepTerminalEpochNeverDecreases(before: TerminalSession, after: TerminalSession): bool = after.terminalEpoch >= before.terminalEpoch
pure def sometimesTerminalOpened(s: TerminalSession): bool = s.terminalPhase == TerminalOpen
pure val eval_witness_sometimesTerminalOpened = (("openTerminal", "owner", "term-a", "owner"), ("acknowledgeTerminal", "term-a", 1, true, "pty"))
pure val sValues = Set(initial, { terminalPhase: TerminalOpen, terminalOwner: "owner", terminalId: "term-a", terminalEpoch: 1 })
pure val byValues = Set("owner", "other", "pty")
```
