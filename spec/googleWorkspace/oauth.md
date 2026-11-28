# Google Workspace OAuth connection lifecycle

## Story: Connect, refresh, and disconnect a Google Workspace account without leaving stale grants active

> As an owner, I can start an OAuth connection, complete it with the returned state and scopes, refresh expired access tokens, and disconnect the account so that stale epochs can never authorize requests.

### An OAuth connection advances its epoch on every lifecycle change and authorizes only the current connected epoch

Phase transitions (`startOAuth`, `completeOAuth`, `cancelOAuth`, failed `refreshAccess`, and `disconnect`) advance `epoch` monotonically and clear any previous active grant when leaving `Connected`, while token expiry (`expireAccess`) and successful refresh (`refreshAccess(true)`) preserve the current `activeEpoch`. Authorization (`connectionAuthorizes`) succeeds only when the connection is `Connected` with `accessValid`, `seenEpoch == activeEpoch`, and `0 < requiredMask <= scopeMask`, so any stale epoch is always refused.

```quint
type ConnectionPhase = Disconnected | PendingOAuth | Connected

type WorkspaceConnection = {
  phase: ConnectionPhase,
  epoch: int,
  pendingState: int,
  activeEpoch: int,
  hasRefreshToken: bool,
  scopeMask: int,
  accessValid: bool,
}

pure val initial: WorkspaceConnection = {
  phase: Disconnected,
  epoch: 0,
  pendingState: 0,
  activeEpoch: 0,
  hasRefreshToken: false,
  scopeMask: 0,
  accessValid: false,
}

pure def canStartOAuth(s: WorkspaceConnection, stateNonce: int): bool =
  s.phase != PendingOAuth and stateNonce > 0

pure def startOAuth(s: WorkspaceConnection, stateNonce: int): WorkspaceConnection = {
  phase: PendingOAuth,
  epoch: s.epoch + 1,
  pendingState: stateNonce,
  activeEpoch: 0,
  hasRefreshToken: false,
  scopeMask: 0,
  accessValid: false,
}

pure def canCompleteOAuth(s: WorkspaceConnection, stateNonce: int, hasRefresh: bool, scopes: int): bool =
  s.phase == PendingOAuth and stateNonce == s.pendingState and scopes > 0

pure def completeOAuth(s: WorkspaceConnection, stateNonce: int, hasRefresh: bool, scopes: int): WorkspaceConnection = {
  phase: Connected,
  epoch: s.epoch + 1,
  pendingState: 0,
  activeEpoch: s.epoch + 1,
  hasRefreshToken: hasRefresh,
  scopeMask: scopes,
  accessValid: true,
}

pure def canCancelOAuth(s: WorkspaceConnection): bool =
  s.phase == PendingOAuth

pure def cancelOAuth(s: WorkspaceConnection): WorkspaceConnection = {
  phase: Disconnected,
  epoch: s.epoch + 1,
  pendingState: 0,
  activeEpoch: 0,
  hasRefreshToken: false,
  scopeMask: 0,
  accessValid: false,
}

pure def canExpireAccess(s: WorkspaceConnection): bool =
  s.phase == Connected and s.accessValid

pure def expireAccess(s: WorkspaceConnection): WorkspaceConnection = {
  ...s,
  accessValid: false,
}

pure def canRefreshAccess(s: WorkspaceConnection, succeeded: bool): bool =
  s.phase == Connected and not(s.accessValid) and s.hasRefreshToken

pure def refreshAccess(s: WorkspaceConnection, succeeded: bool): WorkspaceConnection =
  if (succeeded) { ...s, accessValid: true }
  else {
    phase: Disconnected,
    epoch: s.epoch + 1,
    pendingState: 0,
    activeEpoch: 0,
    hasRefreshToken: false,
    scopeMask: 0,
    accessValid: false,
  }

pure def canDisconnect(s: WorkspaceConnection): bool =
  s.phase == Connected

pure def disconnect(s: WorkspaceConnection): WorkspaceConnection = {
  phase: Disconnected,
  epoch: s.epoch + 1,
  pendingState: 0,
  activeEpoch: 0,
  hasRefreshToken: false,
  scopeMask: 0,
  accessValid: false,
}

pure def alwaysConnectedHasActiveEpoch(s: WorkspaceConnection): bool =
  s.phase == Connected implies (s.activeEpoch == s.epoch and s.activeEpoch > 0 and s.scopeMask > 0)

pure def alwaysDisconnectedHasNoActiveGrant(s: WorkspaceConnection): bool =
  s.phase != Connected implies (not(s.accessValid) and s.activeEpoch == 0 and s.scopeMask == 0)

pure def alwaysPendingHasStateNonce(s: WorkspaceConnection): bool =
  (s.phase == PendingOAuth) == (s.pendingState > 0)

pure def alwaysEpochNonnegative(s: WorkspaceConnection): bool =
  s.epoch >= 0 and s.activeEpoch >= 0 and s.activeEpoch <= s.epoch

pure def stepEpochMonotonic(before: WorkspaceConnection, after: WorkspaceConnection): bool =
  after.epoch >= before.epoch

pure def stepDisconnectBumpsEpoch(before: WorkspaceConnection, via: str, after: WorkspaceConnection): bool =
  (via == "disconnect") implies (after.epoch > before.epoch and after.phase == Disconnected)

pure def connectionAuthorizes(s: WorkspaceConnection, seenEpoch: int, requiredMask: int): bool =
  s.phase == Connected and s.accessValid and seenEpoch == s.activeEpoch and requiredMask > 0 and requiredMask <= s.scopeMask

pure def lawStaleEpochNeverAuthorized(s: WorkspaceConnection, seenEpoch: int, requiredMask: int): bool =
  seenEpoch != s.activeEpoch implies not(connectionAuthorizes(s, seenEpoch, requiredMask))

pure def sometimesConnected(s: WorkspaceConnection): bool =
  s.phase == Connected and s.accessValid

pure def sometimesExpiredAndRefreshed(s: WorkspaceConnection): bool =
  s.phase == Connected and s.hasRefreshToken and not(s.accessValid)

pure def sometimesDisconnectedAfterUse(s: WorkspaceConnection): bool =
  s.phase == Disconnected and s.epoch >= 3

pure val stateNonceValues = Set(0, 1, 2)
pure val scopesValues = Set(0, 1, 3, 7)
pure val seenEpochValues = Set(0, 1, 2, 3)
pure val requiredMaskValues = Set(0, 1, 3)
```
