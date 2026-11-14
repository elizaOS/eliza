# Bill panel source selection and guidance requests

The renderer reuses `BillDecisionClient`, `BillSourceClient` and
`BillSourceLinkClient` from pinned
`plugins/plugin-personal-assistant/native-host/bill-client.ts`.
The task ID and request generation determine which asynchronous results
can publish. Transport and browser opening remain host effects. The
`readBillDecision` and `readBillSourceOffer` decoders validate the full
wire objects according to the [bill response contract](./billWire.md).

## Story: Ask the host for current source state after a failed selection

### Selection sends the shown offer identity and never retries an uncertain POST

The client refuses an expired, missing or incompatible offer. It passes
the exact offer ID, candidate ID and expected revision from its visible
offer to the host. An uncertain selection may have committed. A current
selection failure clears the offer, so another selection requires an
explicit search of authoritative state. Starting a new task clears the
previous task's offer. A result for a previous task generation cannot
change this panel. The external selection store separately handles
exact replay and authorization.

```quint
type SourceClientPhase = SourceInactive | SourceIdle | SearchingSources | SelectingSource
type SourceError = NoSourceError | SearchError | SelectionError
type SourceReply = DecodedOffer | SelectedReply | InvalidSourceReply
type SourceClient = { generation: int, selectionPhase: SourceClientPhase, offerShown: bool, selectionKnown: bool, sourceError: SourceError }
pure val inactiveClient: SourceClientPhase = SourceInactive
pure val idleClient: SourceClientPhase = SourceIdle
pure val searchClient: SourceClientPhase = SearchingSources
pure val selectClient: SourceClientPhase = SelectingSource
pure val noSourceError: SourceError = NoSourceError
pure val searchError: SourceError = SearchError
pure val selectionError: SourceError = SelectionError
pure val initial: SourceClient = { generation: 0, selectionPhase: inactiveClient, offerShown: false, selectionKnown: false, sourceError: noSourceError }

pure def startSourcePanel(c: SourceClient): SourceClient =
  { ...initial, generation: c.generation + 1, selectionPhase: idleClient }
pure def closeSourcePanel(c: SourceClient): SourceClient =
  { ...c, generation: c.generation + 1, selectionPhase: inactiveClient }
pure def canSearchSources(c: SourceClient): bool = c.selectionPhase == idleClient
pure def searchSources(c: SourceClient): SourceClient =
  { ...c, generation: c.generation + 1, selectionPhase: searchClient, selectionKnown: false, sourceError: noSourceError }
pure def canChooseSource(c: SourceClient, visibleOfferMatches: bool): bool =
  c.selectionPhase == idleClient and c.offerShown and visibleOfferMatches
pure def chooseSource(c: SourceClient, visibleOfferMatches: bool): SourceClient =
  { ...c, generation: c.generation + 1, selectionPhase: selectClient, selectionKnown: false, sourceError: noSourceError }
pure def canFinishSourceRequest(c: SourceClient, ticket: int): bool =
  c.generation == ticket and (c.selectionPhase == searchClient or c.selectionPhase == selectClient)
pure def finishSourceRequest(c: SourceClient, ticket: int, reply: SourceReply): SourceClient =
  if (reply == SelectedReply) {
    ...c, selectionPhase: idleClient, offerShown: false, selectionKnown: true, sourceError: noSourceError
  } else if (c.selectionPhase == searchClient and reply == DecodedOffer) {
    ...c, selectionPhase: idleClient, offerShown: true, selectionKnown: false, sourceError: noSourceError
  } else if (c.selectionPhase == selectClient) {
    ...c, selectionPhase: idleClient, offerShown: false, selectionKnown: false, sourceError: selectionError
  } else {
    ...c, selectionPhase: idleClient, selectionKnown: false, sourceError: searchError
  }
pure def alwaysSelectedSourceHasNoOffer(c: SourceClient): bool =
  c.selectionKnown implies not(c.offerShown)
pure def alwaysFailedSelectionClearedOffer(c: SourceClient): bool =
  c.sourceError == selectionError implies not(c.offerShown)
pure def sometimesSelectionNeedsFreshSearch(c: SourceClient): bool = c.sourceError == selectionError
pure def sometimesSourceSelectionKnown(c: SourceClient): bool = c.selectionKnown
pure val ticketValues = Set(0, 1, 2, 3, 4, 5)
```

## Story: Keep a question from racing a browser refresh

### A foreground action waits for the current check and question to settle

A `BillDecisionClient` background GET does not make the panel pending.
A foreground action begins its own ticket, waits for any background
request for the same task, then waits for the current question. The
person can release the question without sending the waiting action.
When released to send, the same ticket and task still have to be current.
A response error preserves the last decision. It becomes a save error
only while the previous decision has pending receipt storage.

The timer expires guidance locally even if renewal fails. It rechecks
while a guide is available, every 15 seconds or five seconds before
expiry when earlier. Closed, superseded or held panels cannot publish a
new background read. A source browser link likewise is opened only in
the current active, single-flight panel, after decoding a Gmail link
for the selected thread. A late completion of that open causes no
renderer callback.

```quint
type GuidanceFacts = { taskCurrent: bool, backgroundPending: bool, questionHeld: bool, questionDiscarded: bool }
type GuidanceDispatch = DispatchCurrent | WaitBackground | WaitQuestion | DiscardRequest
pure def guidanceDispatch(facts: GuidanceFacts): GuidanceDispatch =
  if (not(facts.taskCurrent) or facts.questionDiscarded) DiscardRequest
  else if (facts.backgroundPending) WaitBackground
  else if (facts.questionHeld) WaitQuestion
  else DispatchCurrent
pure def renewalDelay(hasExpiry: bool, millisUntilExpiry: int): int =
  if (not(hasExpiry)) 15000
  else if (millisUntilExpiry > 5000)
    (if (millisUntilExpiry - 5000 < 15000) millisUntilExpiry - 5000 else 15000)
  else if (millisUntilExpiry < 1000) 1000
  else millisUntilExpiry
pure def lawCommitWaitsForQuestion(facts: GuidanceFacts): bool =
  facts.questionHeld implies guidanceDispatch(facts) != DispatchCurrent
pure def lawDispatchRequiresCurrentReadyPanel(facts: GuidanceFacts): bool =
  guidanceDispatch(facts) == DispatchCurrent implies
  facts.taskCurrent and not(facts.questionDiscarded or facts.backgroundPending or facts.questionHeld)
pure def lawGuidanceDelayWithinRecheckBound(hasExpiry: bool, millisUntilExpiry: int): bool =
  renewalDelay(hasExpiry, millisUntilExpiry) > 0 and renewalDelay(hasExpiry, millisUntilExpiry) <= 15000
pure val readyGuide: GuidanceFacts = { taskCurrent: true, backgroundPending: false, questionHeld: false, questionDiscarded: false }
pure val factsValues = Set(readyGuide, { ...readyGuide, taskCurrent: false },
  { ...readyGuide, questionHeld: true }, { ...readyGuide, questionDiscarded: true },
  { ...readyGuide, backgroundPending: true })
pure val millisUntilExpiryValues = Set(-1, 0, 1000, 5000, 5001, 10000, 20000, 80000)
```
