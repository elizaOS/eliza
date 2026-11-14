# Connector OAuth completion and compensation

Source `connectors/account-manager.ts` serializes complete OAuth callbacks by agent and provider across manager instances. Consumption precedes provider exchange. The process queue covers provider verification, account persistence, optional compensation and terminal flow update; failures release the queue for later calls. Cross-process mutual exclusion is the durable consume operation's responsibility.

## Story: Complete one authorization without reusing a consumed state

As a connector user, I want callback errors and persistence failures to preserve their actual writeResult and keep credential ownership with the originating flow.

### A callback consumes a pending unexpired flow before provider work

An unknown, expired or previously consumed flow is rejected. Provider-reported OAuth errors and missing post-restart PKCE secrets update the flow to failed and return that flow. Missing provider callback support throws after consumption. Provider exchange begins only after those checks. Start failure similarly attempts a failed-flow update and preserves both failures if that write throws.

```quint
type OAuthPhase = OAuthIdle | ConsumePending | ProviderPending | AccountPending | CompensationPending | FailureWritePending | SuccessWritePending | OAuthReturned | OAuthThrown
type FlowState = NoFlow | PendingState | FailedState | CompletedState | CancelledState
type WriteOutcome = WriteAcknowledged | WriteMissing | WriteThrew
type OAuthCompletion = { phase: OAuthPhase, consumed: bool, flowState: FlowState, originalFlow: FlowState, accountStored: bool, providerSucceeded: bool, compensationAttempted: bool, compensationFailed: bool, providerFailed: bool, persistenceFailed: bool, verifierPresent: bool, verifierRequired: bool, verifierReleased: bool, failurePath: bool, returnedFlow: FlowState }
pure val initial: OAuthCompletion = { phase: OAuthIdle, consumed: false, flowState: NoFlow, originalFlow: NoFlow, accountStored: false, providerSucceeded: false, compensationAttempted: false, compensationFailed: false, providerFailed: false, persistenceFailed: false, verifierPresent: false, verifierRequired: false, verifierReleased: false, failurePath: false, returnedFlow: NoFlow }
pure def canBeginCallback(s: OAuthCompletion): bool = s.phase == OAuthIdle
pure def beginCallback(s: OAuthCompletion, verifierPresent: bool, verifierRequired: bool): OAuthCompletion = { ...s, phase: ConsumePending, verifierPresent: verifierPresent, verifierRequired: verifierRequired }
pure def canConsume(s: OAuthCompletion): bool = s.phase == ConsumePending
pure def consume(s: OAuthCompletion, pendingAndUnexpired: bool, inputError: bool, providerInstalled: bool): OAuthCompletion = { ...s, consumed: pendingAndUnexpired, flowState: if (pendingAndUnexpired) PendingState else NoFlow, originalFlow: if (pendingAndUnexpired) PendingState else NoFlow, phase: if (not(pendingAndUnexpired)) OAuthThrown else if (inputError or (s.verifierRequired and not(s.verifierPresent))) FailureWritePending else if (not(providerInstalled)) OAuthThrown else ProviderPending, failurePath: pendingAndUnexpired and (inputError or (s.verifierRequired and not(s.verifierPresent))) }
pure def canProviderResult(s: OAuthCompletion): bool = s.phase == ProviderPending
pure def providerResult(s: OAuthCompletion, success: bool, hasAccount: bool): OAuthCompletion = { ...s, providerSucceeded: success, providerFailed: not(success), phase: if (not(success)) FailureWritePending else if (hasAccount) AccountPending else SuccessWritePending, failurePath: not(success) }
pure def canAccountResult(s: OAuthCompletion): bool = s.phase == AccountPending
pure def accountResult(s: OAuthCompletion, success: bool): OAuthCompletion = { ...s, accountStored: success, persistenceFailed: not(success), phase: if (success) SuccessWritePending else CompensationPending, failurePath: not(success) }
pure def canCompensate(s: OAuthCompletion): bool = s.phase == CompensationPending
pure def compensate(s: OAuthCompletion, supported: bool, success: bool): OAuthCompletion = { ...s, compensationAttempted: supported, compensationFailed: supported and not(success), phase: FailureWritePending }
pure def alwaysProviderAfterConsumption(s: OAuthCompletion): bool = (s.phase == ProviderPending or s.providerSucceeded or s.providerFailed or s.accountStored) implies s.consumed
pure def alwaysStoredAccountRequiresProvider(s: OAuthCompletion): bool = s.accountStored implies s.providerSucceeded
pure def alwaysCompensationFollowsFailedAccountWrite(s: OAuthCompletion): bool = s.compensationAttempted implies s.providerSucceeded and s.persistenceFailed and not(s.accountStored)
```

### Terminal persistence and verifier cleanup preserve separate writeResults

A provider exchange failure throws after recording a non-null failed row; a missing or throwing failure-state update aggregates provider and persistence failures. Account persistence failure invokes optional compensation and then attempts a failed update before throwing. A successful exchange performs its terminal update after account persistence, and a throwing success update preserves the stored account. The current source returns the original pending flow when that success update returns null; this observable fallback is retained explicitly here. Successful terminal row updates may carry a provider-selected flow status. Verifier cleanup runs in the provider completion finally block, including failures; pre-provider exits rely on the storage terminal cleanup path.

```quint
pure def canWriteFailure(s: OAuthCompletion): bool = s.phase == FailureWritePending
pure def writeFailure(s: OAuthCompletion, writeResult: WriteOutcome): OAuthCompletion = { ...s, flowState: if (writeResult == WriteAcknowledged) FailedState else s.flowState, persistenceFailed: s.persistenceFailed or writeResult != WriteAcknowledged, phase: if (s.providerFailed or s.persistenceFailed or writeResult == WriteThrew) OAuthThrown else OAuthReturned, returnedFlow: if (writeResult == WriteAcknowledged) FailedState else s.originalFlow, verifierReleased: s.verifierReleased or s.providerFailed or s.providerSucceeded }
pure def canWriteSuccess(s: OAuthCompletion): bool = s.phase == SuccessWritePending
pure def writeSuccess(s: OAuthCompletion, writeResult: WriteOutcome, selectedStatus: FlowState): OAuthCompletion = { ...s, flowState: if (writeResult == WriteAcknowledged) selectedStatus else s.flowState, returnedFlow: if (writeResult == WriteAcknowledged) selectedStatus else s.originalFlow, persistenceFailed: writeResult != WriteAcknowledged, phase: if (writeResult == WriteThrew) OAuthThrown else OAuthReturned, verifierReleased: true }
pure def alwaysProviderTerminalReleasesVerifier(s: OAuthCompletion): bool = (s.phase == OAuthReturned or s.phase == OAuthThrown) and (s.providerSucceeded or s.providerFailed) implies s.verifierReleased
pure def sometimesAccountSurvivesTerminalWriteFailure(s: OAuthCompletion): bool = s.accountStored and s.phase == OAuthThrown and s.persistenceFailed
pure def sometimesProviderFailureRecorded(s: OAuthCompletion): bool = s.providerFailed and s.flowState == FailedState and s.phase == OAuthThrown
pure def sometimesNullUpdateReturnsPendingFlow(s: OAuthCompletion): bool = s.providerSucceeded and s.phase == OAuthReturned and s.returnedFlow == PendingState and s.persistenceFailed
pure val writeResultValues = Set(WriteAcknowledged, WriteMissing, WriteThrew)
pure val fair_consume = "weak"
pure val fair_providerResult = "weak"
pure val fair_accountResult = "weak"
pure val fair_compensate = "weak"
pure val fair_writeFailure = "weak"
pure val fair_writeSuccess = "weak"
pure def leadsToCallbackSettles(s: OAuthCompletion, later: OAuthCompletion): bool = s.phase != OAuthIdle implies later.phase == OAuthReturned or later.phase == OAuthThrown
```
