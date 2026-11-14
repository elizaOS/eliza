# Pairing admission across senders

This model migrates the admission portion of `quint/PairingAdmission.qnt` and `services/pairing.ts`. One runtime serializes the read/check/write sequence across its requests. The pending limit applies independently to each channel. External writers remain an adapter concurrency boundary.

## Story: Admit pending pairing requests without evicting existing senders

As an owner, I want repeated requests to retain their original code and new senders to be rejected when my pending queue is full.

### Only one read-check-write admission occupies the runtime at once

A request row belongs to the exact agent/channel/sender tuple. Existing live rows update last-seen and supplied metadata without renewing creation time. New rows use fresh request ids and codes. Failed reads, CSPRNG generation or writes release the admission queue and preserve the caller's error. Expired rows are ineligible before their best-effort deletion completes.

```quint
type PairingScope = { agent: str, channel: str, sender: str }
type PendingRow = { scope: PairingScope, live: bool }
type AdmissionPhase = AdmissionIdle | AdmissionReading | AdmissionCreating | AdmissionUpdating | AdmissionRejecting
type AdmissionResult = AdmissionNone | AdmissionAccepted | AdmissionFailed | AdmissionFull
type PairingAdmission = { configured: bool, rows: List[PendingRow], phase: AdmissionPhase, active: PairingScope, observedCount: int, maximum: int, resultKind: AdmissionResult, created: bool }
pure val emptyScope: PairingScope = { agent: "", channel: "", sender: "" }
pure val initial: PairingAdmission = { configured: false, rows: List(), phase: AdmissionIdle, active: emptyScope, observedCount: 0, maximum: 3, resultKind: AdmissionNone, created: false }
pure def liveCount(s: PairingAdmission, scope: PairingScope): int = s.rows.select(row => row.live and row.scope.agent == scope.agent and row.scope.channel == scope.channel).length()
pure def canConfigure(s: PairingAdmission): bool = not(s.configured)
pure def configure(s: PairingAdmission, maximum: int): PairingAdmission = { ...s, configured: true, maximum: maximum }
pure def canEnterAdmission(s: PairingAdmission): bool = s.configured and s.phase == AdmissionIdle
pure def enterAdmission(s: PairingAdmission, scope: PairingScope): PairingAdmission = { ...s, phase: AdmissionReading, active: scope, resultKind: AdmissionNone, created: false }
pure def canReadPending(s: PairingAdmission): bool = s.phase == AdmissionReading
pure def readPending(s: PairingAdmission): PairingAdmission = { ...s, observedCount: liveCount(s, s.active), phase: if (s.rows.some(row => row.scope == s.active and row.live)) AdmissionUpdating else if (liveCount(s, s.active) >= s.maximum) AdmissionRejecting else AdmissionCreating }
pure def canWritePending(s: PairingAdmission): bool = s.phase == AdmissionCreating or s.phase == AdmissionUpdating
pure def writePending(s: PairingAdmission, success: bool): PairingAdmission = { ...s, rows: if (success and s.phase == AdmissionCreating) s.rows.select(row => row.scope != s.active).append({ scope: s.active, live: true }) else s.rows, phase: AdmissionIdle, resultKind: if (success) AdmissionAccepted else AdmissionFailed, created: success and s.phase == AdmissionCreating }
pure def canRejectFull(s: PairingAdmission): bool = s.phase == AdmissionRejecting
pure def rejectFull(s: PairingAdmission): PairingAdmission = { ...s, phase: AdmissionIdle, resultKind: AdmissionFull }
pure def canReadFailed(s: PairingAdmission): bool = s.phase == AdmissionReading
pure def readFailed(s: PairingAdmission): PairingAdmission = { ...s, phase: AdmissionIdle, resultKind: AdmissionFailed }
pure def expireSender(s: PairingAdmission, scope: PairingScope): PairingAdmission = { ...s, rows: s.rows.listMap(row => if (row.scope == scope) { ...row, live: false } else row) }
pure def cleanupSender(s: PairingAdmission, scope: PairingScope): PairingAdmission = { ...s, rows: s.rows.select(row => row.scope != scope or row.live) }
pure def alwaysUniquePendingScope(s: PairingAdmission): bool = s.rows.every(row => s.rows.select(other => row.scope == other.scope).length() == 1)
pure def alwaysCreatingCountCannotIncrease(s: PairingAdmission): bool = s.phase == AdmissionCreating implies liveCount(s, s.active) <= s.observedCount
pure def alwaysCreationUsesObservedCapacity(s: PairingAdmission): bool = s.phase == AdmissionCreating implies s.observedCount < s.maximum
pure def stepUpdateCannotRenewExpiredRow(before: PairingAdmission, via: str, after: PairingAdmission): bool = via == "writePending" and before.phase == AdmissionUpdating implies before.rows == after.rows
pure def stepNewRowHasFreeCapacity(before: PairingAdmission, via: str, after: PairingAdmission): bool = via == "writePending" and after.created implies liveCount(before, before.active) < before.maximum
pure def sometimesQueueFull(s: PairingAdmission): bool = s.resultKind == AdmissionFull
pure def sometimesFailedWrite(s: PairingAdmission): bool = s.resultKind == AdmissionFailed
pure val scopeValues = Set({ agent: "a1", channel: "chat", sender: "one" }, { agent: "a1", channel: "chat", sender: "two" }, { agent: "a1", channel: "mail", sender: "one" })
pure val maximumValues = Set(0, 1, 2, 3)
pure val fair_readPending = "weak"
pure val fair_writePending = "weak"
pure val fair_rejectFull = "weak"
pure def leadsToAdmissionReleased(s: PairingAdmission, later: PairingAdmission): bool = s.phase != AdmissionIdle implies later.phase == AdmissionIdle
```
