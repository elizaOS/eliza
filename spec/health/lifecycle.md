# Health connector consent, sync lifecycle, and sleep alert gating

Health connectors sync biometric samples only while the owner has granted
consent and completed authorization. Revoking consent disconnects the connector
immediately and blocks health data exports. Sleep regularity windows stay
bounded between 3 and 90 days, and wake-based check-in alerts respect quiet
hours.

## Story: Sync health connectors only with owner consent and gate exports and sleep alerts safely

> As the owner, I want health connectors to sync only after I grant consent and
> authorize them, revoking consent to disconnect and block exports immediately,
> and sleep regularity and wake alerts to respect valid windows and quiet hours.

### Health data exports require granted consent, owner role, and owner-only audience

An export is permitted only when owner consent is granted, the caller holds the
owner role, and the conversation audience contains only the owner.

```quint
type HealthConsentPhase = ConsentRevoked | ConsentGranted
pure def mayExportHealthData(consent: HealthConsentPhase, isOwner: bool, ownerAudienceOnly: bool): bool =
  consent == ConsentGranted and isOwner and ownerAudienceOnly
pure def lawRevokedConsentBlocksExport(isOwner: bool, ownerAudienceOnly: bool): bool =
  not(mayExportHealthData(ConsentRevoked, isOwner, ownerAudienceOnly))
pure def lawNonOwnerNeverExports(consent: HealthConsentPhase, ownerAudienceOnly: bool): bool =
  not(mayExportHealthData(consent, false, ownerAudienceOnly))
```

### Sleep regularity windows and wake alerts stay within safe bounds

Sleep regularity calculations accept windows from 3 through 90 days inclusive.
A wake-based health alert is eligible only when estimated awake probability is
at least 60 percent and quiet hours are not active.

```quint
pure val windowDaysValues: Set[int] = Set(0, 3, 14, 90, 120)
pure val awakeProbabilityPctValues: Set[int] = Set(0, 50, 60, 90)
pure def sleepRegularityWindowValid(windowDays: int): bool =
  windowDays >= 3 and windowDays <= 90
pure def sleepAlertEligible(awakeProbabilityPct: int, quietHours: bool): bool =
  awakeProbabilityPct >= 60 and not(quietHours)
pure def lawQuietHoursSuppressAlert(awakeProbabilityPct: int): bool =
  not(sleepAlertEligible(awakeProbabilityPct, true))
```

### Connector authorization and sync transitions enforce owner consent and monotonic revisions

A connector starts disconnected with revoked consent and zero synced samples.
Authorization and sync require granted consent, disconnecting clears refresh
tokens, revoking consent disconnects immediately while preserving the historical
synced sample count, and every transition increments the revision counter.

```quint
type HealthConnectorPhase = ConnectorDisconnected | ConnectorAuthorizing | ConnectorConnected | ConnectorDegraded
type HealthConnectorState = {
  phase: HealthConnectorPhase,
  consent: HealthConsentPhase,
  syncedSamples: int,
  revision: int,
  hasRefreshToken: bool
}
pure val addedSamplesValues: Set[int] = Set(0, 1, 3)
pure val initial: HealthConnectorState = {
  phase: ConnectorDisconnected,
  consent: ConsentRevoked,
  syncedSamples: 0,
  revision: 0,
  hasRefreshToken: false
}
pure def maySyncHealthConnector(s: HealthConnectorState): bool =
  s.consent == ConsentGranted and s.phase == ConnectorConnected
pure def canGrantConsent(s: HealthConnectorState): bool =
  s.consent == ConsentRevoked
pure def grantConsent(s: HealthConnectorState): HealthConnectorState =
  { ...s, consent: ConsentGranted, revision: s.revision + 1 }
pure def canStartAuthorization(s: HealthConnectorState): bool =
  s.consent == ConsentGranted and (s.phase == ConnectorDisconnected or s.phase == ConnectorDegraded)
pure def startAuthorization(s: HealthConnectorState): HealthConnectorState =
  { ...s, phase: ConnectorAuthorizing, revision: s.revision + 1 }
pure def canCompleteAuthorization(s: HealthConnectorState, withRefresh: bool): bool =
  s.phase == ConnectorAuthorizing and s.consent == ConsentGranted
pure def completeAuthorization(s: HealthConnectorState, withRefresh: bool): HealthConnectorState =
  { ...s, phase: ConnectorConnected, hasRefreshToken: withRefresh, revision: s.revision + 1 }
pure def canRecordSync(s: HealthConnectorState, addedSamples: int): bool =
  maySyncHealthConnector(s) and addedSamples >= 0
pure def recordSync(s: HealthConnectorState, addedSamples: int): HealthConnectorState =
  { ...s, syncedSamples: s.syncedSamples + addedSamples, revision: s.revision + 1 }
pure def canMarkDegraded(s: HealthConnectorState): bool =
  s.phase == ConnectorConnected
pure def markDegraded(s: HealthConnectorState): HealthConnectorState =
  { ...s, phase: ConnectorDegraded, revision: s.revision + 1 }
pure def canDisconnectConnector(s: HealthConnectorState): bool =
  s.phase != ConnectorDisconnected
pure def disconnectConnector(s: HealthConnectorState): HealthConnectorState =
  { ...s, phase: ConnectorDisconnected, hasRefreshToken: false, revision: s.revision + 1 }
pure def canRevokeConsent(s: HealthConnectorState): bool =
  s.consent == ConsentGranted
pure def revokeConsent(s: HealthConnectorState): HealthConnectorState =
  { ...s, phase: ConnectorDisconnected, consent: ConsentRevoked, hasRefreshToken: false, revision: s.revision + 1 }
pure def alwaysConnectedRequiresConsent(s: HealthConnectorState): bool =
  s.phase == ConnectorConnected implies s.consent == ConsentGranted
pure def alwaysAuthorizingRequiresConsent(s: HealthConnectorState): bool =
  s.phase == ConnectorAuthorizing implies s.consent == ConsentGranted
pure def alwaysSyncedSamplesNonNegative(s: HealthConnectorState): bool =
  s.syncedSamples >= 0
pure def alwaysRevisionNonNegative(s: HealthConnectorState): bool =
  s.revision >= 0
pure def stepHealthRevisionMonotonic(before: HealthConnectorState, after: HealthConnectorState): bool =
  before.revision <= after.revision
pure def sometimesSyncedThenRevoked(s: HealthConnectorState): bool =
  s.phase == ConnectorDisconnected and s.consent == ConsentRevoked and s.syncedSamples > 0 and s.revision >= 5
pure val eval_witness_sometimesSyncedThenRevoked = (
  ("grantConsent"),
  ("startAuthorization"),
  ("completeAuthorization", true),
  ("recordSync", 3),
  ("revokeConsent")
)
```
