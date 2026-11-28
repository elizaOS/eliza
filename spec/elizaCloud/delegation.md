# Managed Google delegation and gateway relay

The plugin exposes owner-scoped managed Google delegation and managed gateway
relay services. Mutating Google operations require explicit per-capability
owner consent, and disconnecting immediately revokes both consent flags and
deactivates the relay without rewinding the connection epoch.

## Story: Gate managed Google delegation and gateway relay on owner consent

> As the owner, I want managed Google mutations to succeed only when I have
> consented for that capability, and disconnecting from Cloud to immediately
> disable the relay and revoke active consent.

### Managed Google mutations require explicit capability consent and active connection

Reads require an active Cloud connection. Gmail mutations require Gmail
consent, and Calendar mutations require Calendar consent. Disconnecting revokes
all consent flags and disables the managed gateway relay while advancing the
revocation counter monotonically.

```quint
type DelegationRelayState = {
  connected: bool,
  accountId: str,
  epoch: int,
  gmailConsent: bool,
  calendarConsent: bool,
  relayActive: bool,
  revokedCount: int
}
pure val initial: DelegationRelayState = {
  connected: false,
  accountId: "",
  epoch: 0,
  gmailConsent: false,
  calendarConsent: false,
  relayActive: false,
  revokedCount: 0
}
pure def mayPerformGoogleAction(s: DelegationRelayState, isMutation: bool, isGmail: bool, isCalendar: bool): bool =
  s.connected and (not(isMutation) or ((not(isGmail) or s.gmailConsent) and (not(isCalendar) or s.calendarConsent)))
pure def canConnectDelegation(s: DelegationRelayState, accountId: str, epoch: int, gmailConsent: bool, calendarConsent: bool): bool =
  accountId != "" and epoch > s.epoch
pure def connectDelegation(s: DelegationRelayState, accountId: str, epoch: int, gmailConsent: bool, calendarConsent: bool): DelegationRelayState =
  { connected: true, accountId: accountId, epoch: epoch, gmailConsent: gmailConsent, calendarConsent: calendarConsent, relayActive: false, revokedCount: s.revokedCount }
pure def canUpdateConsent(s: DelegationRelayState, gmailConsent: bool, calendarConsent: bool): bool =
  s.connected
pure def updateConsent(s: DelegationRelayState, gmailConsent: bool, calendarConsent: bool): DelegationRelayState =
  { ...s, gmailConsent: gmailConsent, calendarConsent: calendarConsent }
pure def canActivateRelay(s: DelegationRelayState): bool =
  s.connected and not(s.relayActive)
pure def activateRelay(s: DelegationRelayState): DelegationRelayState =
  { ...s, relayActive: true }
pure def canDisconnectDelegation(s: DelegationRelayState): bool =
  s.connected
pure def disconnectDelegation(s: DelegationRelayState): DelegationRelayState =
  { connected: false, accountId: "", epoch: s.epoch, gmailConsent: false, calendarConsent: false, relayActive: false, revokedCount: s.revokedCount + 1 }
pure def alwaysDisconnectedRelayInactive(s: DelegationRelayState): bool =
  not(s.connected) implies not(s.relayActive)
pure def alwaysDisconnectedHasNoConsent(s: DelegationRelayState): bool =
  not(s.connected) implies (not(s.gmailConsent) and not(s.calendarConsent))
pure def alwaysRevokedCountNonNegative(s: DelegationRelayState): bool =
  s.revokedCount >= 0
pure def stepDelegationEpochNeverRewinds(before: DelegationRelayState, after: DelegationRelayState): bool =
  before.epoch <= after.epoch
pure def stepRevokedCountMonotonic(before: DelegationRelayState, after: DelegationRelayState): bool =
  before.revokedCount <= after.revokedCount
pure def sometimesRelayActiveWithConsent(s: DelegationRelayState): bool =
  s.connected and s.relayActive and s.gmailConsent and s.calendarConsent
pure val eval_witness_sometimesRelayActiveWithConsent = (
  ("connectDelegation", "owner", 1, true, false),
  ("updateConsent", true, true),
  ("activateRelay")
)
pure val accountIdValues: Set[str] = Set("", "owner", "other")
pure val epochValues: Set[int] = Set(0, 1, 2, 3)
```
