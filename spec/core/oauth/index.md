# Connector OAuth

One authorization flow runs from start to its terminal result: a pending
flow is stored before the provider is asked for a URL, and a callback
consumes that pending flow before any provider exchange. Callbacks are
serialized by agent and provider across manager instances; failures release
that queue for later calls, and cross-process mutual exclusion is the
durable consume operation's responsibility. One-time PKCE verifiers are
[verifiers](./verifiers.md); the process mirror beside durable storage is
the [bridge](./bridge.md).

## Story: Start authorization only after preserving its original state

> As a connector user, I want a sign-in link only once its pending flow is
> saved, so a callback always finds the flow that started it.

### Persistence precedes provider initiation and failed cleanup retains both errors

Unsupported providers fail before allocation. A failed initial insert never
invokes the provider. A provider initiation failure attempts a failed-flow
write; a throwing write returns an aggregate with both causes, while a
missing failed row still rethrows the original provider failure. Successful
provider initiation performs an update containing URL, redirect fallback,
expiry, verifier and metadata. A missing row on that successful update
returns the original pending flow with URL and redirect only; it does not
fabricate persisted expiry or verifier fields. The flow then awaits its
callback. Once a flow has finished, the next start begins a fresh flow.

```quint
type OAuthPhase = FlowIdle | CreatePending | StartProviderPending | StartFailureWrite | StartSuccessWrite | AwaitingCallback | ConsumePending | ProviderPending | AccountPending | CompensationPending | FailureWritePending | SuccessWritePending | FlowReturned | FlowThrown
type FlowState = NoFlow | PendingState | FailedState | CompletedState | CancelledState
type FlowWrite = WriteAcknowledged | WriteMissing | WriteThrew
type OAuthFlow = { phase: OAuthPhase, originalStored: bool, startProviderCalled: bool, startProviderFailed: bool, bothCauses: bool, returnedOriginal: bool, returnedProviderFields: bool, consumed: bool, flowState: FlowState, originalFlow: FlowState, accountStored: bool, providerSucceeded: bool, compensationAttempted: bool, compensationFailed: bool, providerFailed: bool, persistenceFailed: bool, verifierPresent: bool, verifierRequired: bool, verifierReleased: bool, failurePath: bool, returnedFlow: FlowState }
pure val initial: OAuthFlow = { phase: FlowIdle, originalStored: false, startProviderCalled: false, startProviderFailed: false, bothCauses: false, returnedOriginal: false, returnedProviderFields: false, consumed: false, flowState: NoFlow, originalFlow: NoFlow, accountStored: false, providerSucceeded: false, compensationAttempted: false, compensationFailed: false, providerFailed: false, persistenceFailed: false, verifierPresent: false, verifierRequired: false, verifierReleased: false, failurePath: false, returnedFlow: NoFlow }
pure val writeValues = Set(WriteAcknowledged, WriteMissing, WriteThrew)
pure def canBegin(s: OAuthFlow): bool = s.phase == FlowIdle or s.phase == FlowReturned or s.phase == FlowThrown
pure def begin(s: OAuthFlow, supported: bool): OAuthFlow = { ...initial, phase: if (supported) CreatePending else FlowThrown }
pure def canCreateResult(s: OAuthFlow): bool = s.phase == CreatePending
pure def createResult(s: OAuthFlow, success: bool): OAuthFlow = { ...s, phase: if (success) StartProviderPending else FlowThrown, originalStored: success, startProviderCalled: success, persistenceFailed: not(success) }
pure def canStartProviderResult(s: OAuthFlow): bool = s.phase == StartProviderPending
pure def startProviderResult(s: OAuthFlow, success: bool): OAuthFlow = { ...s, phase: if (success) StartSuccessWrite else StartFailureWrite, startProviderFailed: not(success) }
pure def canWriteStart(s: OAuthFlow): bool = s.phase == StartFailureWrite or s.phase == StartSuccessWrite
pure def writeStart(s: OAuthFlow, write: FlowWrite): OAuthFlow = { ...s, phase: if (s.phase == StartFailureWrite or write == WriteThrew) FlowThrown else AwaitingCallback, persistenceFailed: write == WriteThrew, bothCauses: s.startProviderFailed and write == WriteThrew, returnedOriginal: s.phase == StartSuccessWrite and write == WriteMissing, returnedProviderFields: s.phase == StartSuccessWrite and write == WriteAcknowledged }
pure def alwaysBothCausesRetainFailures(s: OAuthFlow): bool = s.bothCauses implies s.startProviderFailed and s.persistenceFailed and s.phase == FlowThrown
pure def sometimesOriginalFlowFallback(s: OAuthFlow): bool = s.phase == AwaitingCallback and s.returnedOriginal
pure def sometimesAggregatedFailures(s: OAuthFlow): bool = s.bothCauses
pure val fair_createResult = "weak"
pure val fair_startProviderResult = "weak"
pure val fair_writeStart = "weak"
pure def leadsToStartSettles(s: OAuthFlow, later: OAuthFlow): bool = (s.phase == CreatePending or s.phase == StartProviderPending or s.phase == StartFailureWrite or s.phase == StartSuccessWrite) implies later.phase == AwaitingCallback or later.phase == FlowThrown
```

## Story: Complete one authorization without reusing a consumed state

> As a connector user, I want callback errors and persistence failures to
> preserve their actual outcome and keep credential ownership with the
> originating flow.

### A callback consumes a pending unexpired flow before provider work

A callback arrives for a flow whose start returned it. An unknown, expired
or previously consumed flow is rejected. Provider-reported OAuth errors and
missing post-restart PKCE secrets attempt to mark the flow failed. The call
returns the updated flow when storage supplies it, or the consumed flow when
the update returns no row. A throwing update propagates. Missing provider
callback support throws after consumption. Provider exchange begins only
after those checks.

```quint
pure def canBeginCallback(s: OAuthFlow): bool = s.phase == AwaitingCallback
pure def beginCallback(s: OAuthFlow, verifierPresent: bool, verifierRequired: bool): OAuthFlow = { ...s, phase: ConsumePending, verifierPresent: verifierPresent, verifierRequired: verifierRequired }
pure def canConsume(s: OAuthFlow): bool = s.phase == ConsumePending
pure def consume(s: OAuthFlow, pendingAndUnexpired: bool, inputError: bool, providerInstalled: bool): OAuthFlow = {
  val found = pendingAndUnexpired and s.originalStored
  val rejected = inputError or (s.verifierRequired and not(s.verifierPresent))
  { ...s, consumed: found, flowState: if (found) PendingState else NoFlow, originalFlow: if (found) PendingState else NoFlow, phase: if (not(found)) FlowThrown else if (rejected) FailureWritePending else if (not(providerInstalled)) FlowThrown else ProviderPending, failurePath: found and rejected }
}
pure def canProviderResult(s: OAuthFlow): bool = s.phase == ProviderPending
pure def providerResult(s: OAuthFlow, success: bool, hasAccount: bool): OAuthFlow = { ...s, providerSucceeded: success, providerFailed: not(success), phase: if (not(success)) FailureWritePending else if (hasAccount) AccountPending else SuccessWritePending, failurePath: not(success) }
pure def canAccountResult(s: OAuthFlow): bool = s.phase == AccountPending
pure def accountResult(s: OAuthFlow, success: bool): OAuthFlow = { ...s, accountStored: success, persistenceFailed: not(success), phase: if (success) SuccessWritePending else CompensationPending, failurePath: not(success) }
pure def canCompensate(s: OAuthFlow): bool = s.phase == CompensationPending
pure def compensate(s: OAuthFlow, supported: bool, success: bool): OAuthFlow = { ...s, compensationAttempted: supported, compensationFailed: supported and not(success), phase: FailureWritePending }
pure def alwaysStoredAccountRequiresProvider(s: OAuthFlow): bool = s.accountStored implies s.providerSucceeded
pure def alwaysCompensationFollowsFailedAccountWrite(s: OAuthFlow): bool = s.compensationAttempted implies s.providerSucceeded and s.persistenceFailed and not(s.accountStored)
```

### A provider is called only after the durable state it depends on

The start's provider call follows the stored pending flow, and the
callback's provider exchange follows consumption of that flow.

```quint
pure def alwaysProviderFollowsDurableState(s: OAuthFlow): bool =
  (s.startProviderCalled implies s.originalStored) and
  ((s.phase == ProviderPending or s.providerSucceeded or s.providerFailed or s.accountStored) implies s.consumed and s.originalStored)
```

### Each pending step of a flow carries only the outcomes that led to it

From the start of a flow until its provider exchange answers, the flow
has no provider outcome, no stored account and no compensation attempt.
While the account write or the compensation is pending, the exchange has
succeeded, no account is stored and no compensation was attempted;
compensation is pending only after the account write failed. A pending
success write follows no compensation attempt.

```quint
pure def alwaysProviderOutcomeFollowsTheExchange(s: OAuthFlow): bool =
  ((s.phase == CreatePending or s.phase == StartProviderPending or s.phase == StartFailureWrite or s.phase == StartSuccessWrite or s.phase == AwaitingCallback or s.phase == ConsumePending or s.phase == ProviderPending) implies
    not(s.providerSucceeded or s.providerFailed or s.accountStored or s.compensationAttempted)) and
  ((s.phase == AccountPending or s.phase == CompensationPending) implies (s.providerSucceeded and not(s.accountStored) and not(s.compensationAttempted))) and
  (s.phase == CompensationPending implies s.persistenceFailed) and
  (s.phase == SuccessWritePending implies not(s.compensationAttempted))
```

### A stored account exists only from the success write onward

An account is stored only while the success write is pending or after the
flow has returned or thrown: the account write precedes the terminal
success update, and a failed account write stores nothing.

```quint
pure def alwaysStoredAccountOnlyAtSuccessWriteOrEnd(s: OAuthFlow): bool =
  s.accountStored implies (s.phase == SuccessWritePending or s.phase == FlowReturned or s.phase == FlowThrown)
```

### Compensation is followed only by the failure write and a throw

Once compensation is attempted, the flow is waiting for the failure write
or has thrown: compensation never leads to the success write or a returned
result.

```quint
pure def alwaysCompensationEndsInFailureWrite(s: OAuthFlow): bool =
  s.compensationAttempted implies (s.phase == FailureWritePending or s.phase == FlowThrown)
```

### Terminal persistence and verifier cleanup preserve separate outcomes

A provider exchange failure throws after recording a non-null failed row; a
missing or throwing failure-state update aggregates provider and persistence
failures. Account persistence failure invokes optional compensation and then
attempts a failed update before throwing. A successful exchange performs its
terminal update after account persistence, and a throwing success update
preserves the stored account. A missing row on that success update returns
the original pending flow. Successful terminal row updates may carry a
provider-selected flow status. Verifier cleanup runs when the provider
exchange finishes, including failures; pre-provider exits rely on the
storage terminal cleanup path.

```quint
pure def canWriteFailure(s: OAuthFlow): bool = s.phase == FailureWritePending
pure def writeFailure(s: OAuthFlow, write: FlowWrite): OAuthFlow = { ...s, flowState: if (write == WriteAcknowledged) FailedState else s.flowState, persistenceFailed: s.persistenceFailed or write != WriteAcknowledged, phase: if (s.providerFailed or s.persistenceFailed or write == WriteThrew) FlowThrown else FlowReturned, returnedFlow: if (write == WriteAcknowledged) FailedState else s.originalFlow, verifierReleased: s.verifierReleased or s.providerFailed or s.providerSucceeded }
pure def canWriteSuccess(s: OAuthFlow): bool = s.phase == SuccessWritePending
pure def writeSuccess(s: OAuthFlow, write: FlowWrite, selectedStatus: FlowState): OAuthFlow = { ...s, flowState: if (write == WriteAcknowledged) selectedStatus else s.flowState, returnedFlow: if (write == WriteAcknowledged) selectedStatus else s.originalFlow, persistenceFailed: write != WriteAcknowledged, phase: if (write == WriteThrew) FlowThrown else FlowReturned, verifierReleased: true }
pure def alwaysProviderTerminalReleasesVerifier(s: OAuthFlow): bool = (s.phase == FlowReturned or s.phase == FlowThrown) and (s.providerSucceeded or s.providerFailed) implies s.verifierReleased
pure def sometimesAccountSurvivesTerminalWriteFailure(s: OAuthFlow): bool = s.accountStored and s.phase == FlowThrown and s.persistenceFailed
pure def sometimesProviderFailureRecorded(s: OAuthFlow): bool = s.providerFailed and s.flowState == FailedState and s.phase == FlowThrown
pure def sometimesNullUpdateReturnsPendingFlow(s: OAuthFlow): bool = s.providerSucceeded and s.phase == FlowReturned and s.returnedFlow == PendingState and s.persistenceFailed
pure val fair_consume = "weak"
pure val fair_providerResult = "weak"
pure val fair_accountResult = "weak"
pure val fair_compensate = "weak"
pure val fair_writeFailure = "weak"
pure val fair_writeSuccess = "weak"
pure def leadsToCallbackSettles(s: OAuthFlow, later: OAuthFlow): bool = (s.phase == ConsumePending or s.phase == ProviderPending or s.phase == AccountPending or s.phase == CompensationPending or s.phase == FailureWritePending or s.phase == SuccessWritePending) implies later.phase == FlowReturned or later.phase == FlowThrown
```
