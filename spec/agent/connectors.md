# Connector accounts on the agent

Connector plugins keep their OAuth tokens through the agent's credential store,
`packages/agent/src/services/connector-credential-store.ts`, under a vault
reference that connector account storage points to, and the connector health
monitor in `packages/agent/src/api/connector-health.ts` reports their status.
The [core connector accounts](../core/connectorAccounts.md) own the account
lifecycle; this spec owns the agent's two promises around it: a connection is
reported successful only once its credential is durable, and health reflects
the runtime that is running now.

## Story: Connect an account that survives a restart, and see its real health

> As a user, when the agent says my account is connected, its credential is
> saved durably and is still there after a restart. When the agent restarts in
> place, the health I see is the health of the connectors running now, not of
> the stopped runtime.

### A connection reports success only after its credential is durable

Writing a credential goes to an encrypted vault that survives restarts. When
no master key is available the write fails closed instead of keeping the
token in memory. The account's vault reference points only to a credential
that was written, and success is reported only then. Disconnecting removes
both.

```quint
type ConnectReport = NotReported | ReportedConnected | ReportedFailed
type ConnectorState = { writing: bool, credentialSaved: bool, vaultRef: bool, report: ConnectReport, runtime: int, checkRuntime: int, statusRuntime: int }
pure val initial: ConnectorState = { writing: false, credentialSaved: false, vaultRef: false, report: NotReported, runtime: 0, checkRuntime: -1, statusRuntime: -1 }
pure def canBeginConnect(c: ConnectorState): bool = not(c.writing)
pure def beginConnect(c: ConnectorState): ConnectorState = { ...c, writing: true }
pure def canFinishWrite(c: ConnectorState, durable: bool, masterKey: bool): bool = c.writing
pure def finishWrite(c: ConnectorState, durable: bool, masterKey: bool): ConnectorState =
  if (durable and masterKey) { ...c, writing: false, credentialSaved: true, vaultRef: true, report: ReportedConnected }
  else { ...c, writing: false, report: ReportedFailed }
pure def canDisconnect(c: ConnectorState): bool = c.credentialSaved and not(c.writing)
pure def disconnect(c: ConnectorState): ConnectorState = { ...c, credentialSaved: false, vaultRef: false, report: NotReported }
pure def alwaysConnectedMeansDurable(c: ConnectorState): bool = c.report == ReportedConnected implies (c.credentialSaved and c.vaultRef)
pure def alwaysReferenceHasItsCredential(c: ConnectorState): bool = c.vaultRef implies c.credentialSaved
pure def sometimesConnected(c: ConnectorState): bool = c.report == ReportedConnected
pure def sometimesFailedClosed(c: ConnectorState): bool = c.report == ReportedFailed and not(c.credentialSaved)
```

### Health reads follow a runtime swap

An in-place restart swaps the runtime: the monitor points at the new runtime,
drops the statuses it had and abandons the check in flight, which may still
finish later. A check records statuses only if the runtime it started on is
still the current one; an abandoned check finishes without recording.

```quint
pure def swapRuntime(c: ConnectorState): ConnectorState = { ...c, runtime: c.runtime + 1, statusRuntime: -1 }
pure def canStartCheck(c: ConnectorState): bool = c.checkRuntime != c.runtime
pure def startCheck(c: ConnectorState): ConnectorState = { ...c, checkRuntime: c.runtime }
pure def canFinishCheck(c: ConnectorState): bool = c.checkRuntime != -1
pure def finishCheck(c: ConnectorState): ConnectorState =
  { ...c, checkRuntime: -1, statusRuntime: if (c.checkRuntime == c.runtime) c.runtime else c.statusRuntime }
pure def alwaysHealthDescribesTheCurrentRuntime(c: ConnectorState): bool = c.statusRuntime == -1 or c.statusRuntime == c.runtime
pure def sometimesHealthAfterSwap(c: ConnectorState): bool = c.runtime > 0 and c.statusRuntime == c.runtime
```
