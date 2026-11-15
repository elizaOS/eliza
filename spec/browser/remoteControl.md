# Browser remote control

The agent drives a browser it does not host: the browser surface mounted in
the device's app, and a browser on a device the owner paired with a hosted
agent. Both run a command only against the tab and grant it was bound to,
and neither turns an unverified outcome into success. The browser package's
`native-client-command.ts` parses history commands for a mounted surface;
`remote-control/browser-controller.ts` dispatches commands to a paired
device through Cloud. [Request grounding](./requestGrounding.md) decides
which destination a message may open; [arbitration](./arbitration.md)
decides which local browser peer receives a task operation.

## Story: Go back, forward or reload only on the tab the turn observed

> As the person, I want "go back" to act on the page I was looking at when I
> asked, and to do nothing if that page has since changed.

### A history command carries the observed tab and revision, and the renderer refuses a changed page

A history command (back, forward or reload) copies the tab and its revision
from the turn's client observation, but only when the observation is a
browser view that is not sensitive, selects a browser tab, has a revision,
and both identifiers fit their token bounds. The mounted renderer refuses a
command whose observed tab or revision no longer matches its current tab
and document. A command with no observation runs on the current tab.

```quint
type TabSelection = { tabId: str, revision: str }
type TurnObservation = { present: bool, sensitive: bool, browserView: bool, browserTab: bool, hasRevision: bool, tokensValid: bool, observedTab: str, observedRevision: str }
pure val noSelection: TabSelection = { tabId: "", revision: "" }
pure def observedSelection(observation: TurnObservation, historyCommand: bool): TabSelection =
  if (historyCommand and observation.present and not(observation.sensitive) and observation.browserView and observation.browserTab and observation.hasRevision and observation.tokensValid)
    { tabId: observation.observedTab, revision: observation.observedRevision }
  else noSelection
pure def rendererRunsHistory(selection: TabSelection, currentTab: str, currentRevision: str): bool =
  selection == noSelection or (selection.tabId == currentTab and selection.revision == currentRevision)
pure def lawChangedPageRefusesHistory(selection: TabSelection, currentTab: str, currentRevision: str): bool =
  (selection != noSelection and (selection.tabId != currentTab or selection.revision != currentRevision)) implies not(rendererRunsHistory(selection, currentTab, currentRevision))
pure def lawSensitiveObservationBindsNoTab(observation: TurnObservation, historyCommand: bool): bool =
  observation.sensitive implies observedSelection(observation, historyCommand) == noSelection
pure val seenTab: TurnObservation = { present: true, sensitive: false, browserView: true, browserTab: true, hasRevision: true, tokensValid: true, observedTab: "tab-a", observedRevision: "r1" }
pure val observationValues = Set(seenTab, { ...seenTab, sensitive: true }, { ...seenTab, hasRevision: false }, { ...seenTab, browserView: false }, { ...seenTab, tokensValid: false })
pure val selectionValues = Set(noSelection, { tabId: "tab-a", revision: "r1" }, { tabId: "tab-a", revision: "r2" })
pure val currentTabValues = Set("tab-a", "tab-b")
pure val currentRevisionValues = Set("r1", "r2")
```

## Story: Run a command on the paired device browser and report only a verified result

> As the owner, I want my hosted agent to use the browser on the device I
> paired only while that pairing stands, and to tell me a command worked only
> when the device's signed result says so.

### A command is sent once, under the current grant, and never replayed

Commands run one at a time. A command is dispatched only while the device is
paired, under the grant revision the target was registered with, and only
when no earlier command's enqueue is still unresolved. Dispatch records the
command as pending, enqueues it, and then persists the enqueue receipt; if
that receipt cannot be persisted, the pending record stays and blocks the
next command until it is recovered. A command, once sent, is never sent
again: a failed, ambiguous, expired, cancelled or unresolved command ends
unverified.

```quint
type RemotePhase = RemoteIdle | RemoteEnqueuing | RemoteEnqueued | RemoteStarted | RemoteSucceeded | RemoteNotVerified | RemoteRefused
type RemoteStatus = StatusCompleted | StatusFailed | StatusAmbiguous | StatusExpired | StatusCancelled | StatusUnresolved
type RemoteBrowser = { paired: bool, grantRevision: int, phase: RemotePhase, commandId: int, sends: int, commandGrant: int, pendingEnqueue: bool, startVerified: bool, resultVerified: bool }
pure val initial: RemoteBrowser = { paired: false, grantRevision: 0, phase: RemoteIdle, commandId: 0, sends: 0, commandGrant: 0, pendingEnqueue: false, startVerified: false, resultVerified: false }
pure def remoteInFlight(phase: RemotePhase): bool = phase == RemoteEnqueuing or phase == RemoteEnqueued or phase == RemoteStarted
pure def canPairDevice(r: RemoteBrowser, revision: int): bool = revision > r.grantRevision
pure def pairDevice(r: RemoteBrowser, revision: int): RemoteBrowser = { ...r, paired: true, grantRevision: revision }
pure def canRevokeDevice(r: RemoteBrowser): bool = r.paired
pure def revokeDevice(r: RemoteBrowser): RemoteBrowser = { ...r, paired: false }
pure def canDispatchCommand(r: RemoteBrowser): bool = not(remoteInFlight(r.phase))
pure def dispatchCommand(r: RemoteBrowser, revision: int): RemoteBrowser =
  if (not(r.paired) or revision != r.grantRevision or r.pendingEnqueue) { ...r, phase: RemoteRefused }
  else { ...r, phase: RemoteEnqueuing, commandId: r.commandId + 1, sends: r.sends + 1, commandGrant: revision, pendingEnqueue: true, startVerified: false, resultVerified: false }
pure def canAcknowledgeEnqueue(r: RemoteBrowser): bool = r.phase == RemoteEnqueuing
pure def acknowledgeEnqueue(r: RemoteBrowser, persisted: bool): RemoteBrowser =
  if (persisted) { ...r, phase: RemoteEnqueued, pendingEnqueue: false } else { ...r, phase: RemoteNotVerified }
pure def canRecoverPendingEnqueue(r: RemoteBrowser): bool = r.pendingEnqueue and not(remoteInFlight(r.phase))
pure def recoverPendingEnqueue(r: RemoteBrowser): RemoteBrowser = { ...r, pendingEnqueue: false }
pure val revisionValues = Set(1, 2)
pure def alwaysEachCommandSentOnce(r: RemoteBrowser): bool = r.sends == r.commandId and r.commandId >= 0
pure def alwaysEnqueuingIsPending(r: RemoteBrowser): bool = r.phase == RemoteEnqueuing implies r.pendingEnqueue and r.commandId > 0
pure def stepDispatchUsesCurrentGrant(before: RemoteBrowser, after: RemoteBrowser): bool =
  after.sends > before.sends implies before.paired and after.commandGrant == before.grantRevision and not(before.pendingEnqueue) and not(remoteInFlight(before.phase))
pure def sometimesUnresolvedEnqueueBlocksNext(r: RemoteBrowser): bool = r.phase == RemoteRefused and r.pendingEnqueue and r.paired
pure def sometimesRevokedGrantRefuses(r: RemoteBrowser): bool = r.phase == RemoteRefused and not(r.paired) and r.grantRevision > 0
```

### Only a verified completed result is success

A start receipt is opened and verified before the command counts as started;
a reported start that cannot be verified ends the command unverified. A
result counts as success only when its signed envelope opens for this
command, reports completion, carries status 200 and a body that parses.
Every other outcome is reported as a failure, never as success.

```quint
pure def canObserveStart(r: RemoteBrowser): bool = r.phase == RemoteEnqueued
pure def observeStart(r: RemoteBrowser, verified: bool): RemoteBrowser =
  if (verified) { ...r, phase: RemoteStarted, startVerified: true } else { ...r, phase: RemoteNotVerified }
pure def canObserveResult(r: RemoteBrowser): bool = r.phase == RemoteEnqueued or r.phase == RemoteStarted
pure def observeResult(r: RemoteBrowser, reported: RemoteStatus, envelopeVerified: bool, httpOk: bool, bodyParsed: bool): RemoteBrowser =
  if (reported == StatusCompleted and envelopeVerified and httpOk and bodyParsed) { ...r, phase: RemoteSucceeded, resultVerified: true }
  else { ...r, phase: RemoteNotVerified }
pure def alwaysSuccessIsVerified(r: RemoteBrowser): bool = r.phase == RemoteSucceeded implies r.resultVerified and r.commandId > 0
pure def stepSuccessNeedsCompletedResult(before: RemoteBrowser, via: str, after: RemoteBrowser): bool =
  (after.phase == RemoteSucceeded and before.phase != RemoteSucceeded) implies via == "observeResult" and remoteInFlight(before.phase)
pure def sometimesVerifiedSuccess(r: RemoteBrowser): bool = r.phase == RemoteSucceeded and r.startVerified
pure def sometimesStartedButUnverified(r: RemoteBrowser): bool = r.phase == RemoteNotVerified and r.startVerified
```
