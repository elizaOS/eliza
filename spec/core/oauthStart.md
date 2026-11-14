# OAuth initiation and durable pending ownership

`ConnectorAccountManager.startOAuth` in `connectors/account-manager.ts` generates fresh flow and state identities, writes a pending flow, then calls the provider. Callback serialization and completion are specified separately.

## Story: Start authorization only after preserving its original state

### Persistence precedes provider initiation and failed cleanup retains both errors

Unsupported providers fail before allocation. A failed initial insert never invokes the provider. A provider initiation failure attempts a failed-flow write; a throwing write returns an aggregate with both causes, while a null failed write still rethrows the original provider failure. Successful provider initiation performs an update containing URL, redirect fallback, expiry, verifier and metadata. A null successful update returns the original pending flow with URL and redirect only; it does not fabricate persisted expiry or verifier fields.

```quint
type StartPhase = StartIdle | CreatePending | ProviderStart | StartFailureWrite | StartSuccessWrite | StartReturned | StartThrown
type StartWrite = StartWritten | StartMissing | StartWriteThrew
type OAuthStart = { phase: StartPhase, originalStored: bool, providerCalled: bool, providerFailed: bool, persistenceFailed: bool, bothCauses: bool, returnedOriginal: bool, returnedProviderFields: bool }
pure val initial: OAuthStart = { phase: StartIdle, originalStored: false, providerCalled: false, providerFailed: false, persistenceFailed: false, bothCauses: false, returnedOriginal: false, returnedProviderFields: false }
pure def canBegin(s: OAuthStart): bool = s.phase == StartIdle
pure def begin(s: OAuthStart, supported: bool): OAuthStart = { ...s, phase: if (supported) CreatePending else StartThrown }
pure def canCreateResult(s: OAuthStart): bool = s.phase == CreatePending
pure def createResult(s: OAuthStart, success: bool): OAuthStart = { ...s, phase: if (success) ProviderStart else StartThrown, originalStored: success, providerCalled: success, persistenceFailed: not(success) }
pure def canProviderResult(s: OAuthStart): bool = s.phase == ProviderStart
pure def providerResult(s: OAuthStart, success: bool): OAuthStart = { ...s, phase: if (success) StartSuccessWrite else StartFailureWrite, providerFailed: not(success) }
pure def canWriteResult(s: OAuthStart): bool = s.phase == StartFailureWrite or s.phase == StartSuccessWrite
pure def writeResult(s: OAuthStart, write: StartWrite): OAuthStart = { ...s, phase: if (s.phase == StartFailureWrite or write == StartWriteThrew) StartThrown else StartReturned, persistenceFailed: write == StartWriteThrew, bothCauses: s.providerFailed and write == StartWriteThrew, returnedOriginal: s.phase == StartSuccessWrite and write == StartMissing, returnedProviderFields: s.phase == StartSuccessWrite and write == StartWritten }
pure def alwaysProviderHasOriginalState(s: OAuthStart): bool = s.providerCalled implies s.originalStored
pure def alwaysBothCausesRetainFailures(s: OAuthStart): bool = s.bothCauses implies s.providerFailed and s.persistenceFailed and s.phase == StartThrown
pure def sometimesOriginalFlowFallback(s: OAuthStart): bool = s.phase == StartReturned and s.returnedOriginal
pure def sometimesAggregatedFailures(s: OAuthStart): bool = s.bothCauses
pure val writeValues = Set(StartWritten, StartMissing, StartWriteThrew)
pure val fair_createResult = "weak"
pure val fair_providerResult = "weak"
pure val fair_writeResult = "weak"
pure def leadsToStartSettles(s: OAuthStart, later: OAuthStart): bool = s.phase != StartIdle implies later.phase == StartReturned or later.phase == StartThrown
```
