# Alpha's native Password Manager boundary

Alpha's Settings and browser adapters consume the pinned
`plugins/plugin-native-passwords/src/{client,bindings,definitions,transfer}.ts`
from the vendor checkout. `MainActivity` registers the live Passwords
plugin. The separate import/export bridge is loaded only in a test-mocks
build with that native plugin. The development vault requires both the dev
build and browser development profile. This differs from Grace's release
password feature gate. The historical Alpha `CredentialVault`,
`CredentialVaultReadback`, and `PasswordProviderDialog` Quint models inform
this renderer and native capability boundary.

## Story: Edit or fill saved credentials without exposing them to the agent

### An unlocked foreground page owns a temporary typed secret and observes only native metadata

Only a native unlock receipt for the live foreground visit can make the
vault usable. Listing returns only schema-validated entry summaries.
Opening a password page pauses agent observation. Typed secret data may
reside only in the current form's memory and must clear on success, lock,
expiry, background and leave. Expiry may retain nonsecret editor metadata
while hiding it until a fresh unlock. The model records custody presence
and does not represent the secret value. The native bridge keeps stored
passwords and never returns them to the renderer. Any reply with secret
fields is refused before metadata publication. Native storage,
secret-byte erasure, bridge payload validation and cross-origin DOM
attestation remain adapter refinements.

```quint
type VaultUi = { active: bool, foreground: bool, locked: bool, epoch: int, draft: bool, typed: bool, metadata: bool, damaged: bool, resetEpoch: int, reviewedOrigin: str, filled: bool }
pure val initial: VaultUi = { active: false, foreground: true, locked: true, epoch: 1, draft: false, typed: false, metadata: false, damaged: false, resetEpoch: 0, reviewedOrigin: "", filled: false }
pure def canOpenVault(s: VaultUi): bool = not(s.active) and s.foreground
pure def openVault(s: VaultUi): VaultUi = { ...s, active: true, epoch: s.epoch + 1 }
pure def canObserveUnlock(s: VaultUi, ticket: int): bool = s.active and s.foreground and s.locked and not(s.damaged) and s.epoch == ticket
pure def observeUnlock(s: VaultUi, ticket: int, nativeUnlocked: bool): VaultUi = { ...s, locked: not(nativeUnlocked) }
pure def healthy(s: VaultUi): bool = s.active and s.foreground and not(s.locked or s.damaged)
pure def canObserveMetadata(s: VaultUi, ticket: int): bool = healthy(s) and s.epoch == ticket
pure def observeMetadata(s: VaultUi, ticket: int, validShape: bool, secretFields: bool): VaultUi = { ...s, metadata: validShape and not(secretFields) }
pure def canEditPassword(s: VaultUi): bool = healthy(s)
pure def editPassword(s: VaultUi, typed: bool): VaultUi = { ...s, draft: true, typed: typed }
pure def canSaved(s: VaultUi, ticket: int): bool = healthy(s) and s.draft and s.epoch == ticket
pure def saved(s: VaultUi, ticket: int): VaultUi = { ...s, draft: false, typed: false }
pure def clearAccess(keepDraft: bool, s: VaultUi): VaultUi =
  { ...s, locked: true, epoch: s.epoch + 1, draft: s.draft and keepDraft, typed: false,
    metadata: false, reviewedOrigin: "", filled: false, resetEpoch: 0 }
pure def canExpireUnlock(s: VaultUi): bool = s.active and not(s.locked)
pure def expireUnlock(s: VaultUi): VaultUi = clearAccess(true, s)
pure def canLockVault(s: VaultUi): bool = s.active and not(s.locked)
pure def lockVault(s: VaultUi): VaultUi = clearAccess(false, s)
pure def canLeaveVault(s: VaultUi): bool = s.active
pure def leaveVault(s: VaultUi): VaultUi = { ...clearAccess(false, s), active: false, damaged: false }
pure def canBackground(s: VaultUi): bool = s.foreground
pure def background(s: VaultUi): VaultUi = { ...clearAccess(false, s), active: false, foreground: false, damaged: false }
pure def canFocus(s: VaultUi): bool = not(s.foreground)
pure def focus(s: VaultUi): VaultUi = { ...s, foreground: true }
pure def agentObservationAllowed(s: VaultUi): bool = not(s.active)
pure def alwaysSecretOwnsVisit(s: VaultUi): bool = s.typed implies healthy(s) and s.draft
pure def alwaysMetadataNeedsNativeAccess(s: VaultUi): bool = s.metadata implies healthy(s)
pure def alwaysActiveIsForeground(s: VaultUi): bool = s.active implies s.foreground
pure def sometimesKeepsExpiredMetadataDraft(s: VaultUi): bool = s.draft and s.locked and not(s.typed)
pure def lawVaultPageSuspendsAgent(s: VaultUi): bool = s.active implies not(agentObservationAllowed(s))
pure val ticketValues = Set(1, 2, 3, 4, 5, 6)
```

### Fill and damaged-vault reset need fresh review and exact authority

Browser fill needs a verified isolated target, the live selected origin,
and an explicit review for that origin. Changing target or locking retires
fill approval. A damaged vault cannot reveal prior contents. Reset needs a
freshly confirmed native authentication result after the owner reviewed
the reset for the same live visit. Lock, background, a new refresh or
owner retirement retires a pending reset. No browser mock or transfer
build flag can authorize a production native effect.

```quint
pure def canReviewOrigin(s: VaultUi, origin: str): bool = healthy(s) and origin != ""
pure def reviewOrigin(s: VaultUi, origin: str): VaultUi = { ...s, reviewedOrigin: origin, filled: false }
pure def canFill(s: VaultUi, origin: str, verifiedField: bool): bool = healthy(s) and origin != "" and origin == s.reviewedOrigin and verifiedField
pure def fill(s: VaultUi, origin: str, verifiedField: bool): VaultUi = { ...s, filled: true, typed: false }
pure def targetChanges(s: VaultUi): VaultUi = { ...s, reviewedOrigin: "", filled: false }
pure def canInvalidateKey(s: VaultUi): bool = s.active and not(s.damaged)
pure def invalidateKey(s: VaultUi): VaultUi = { ...clearAccess(false, s), damaged: true }
pure def canReviewReset(s: VaultUi): bool = s.active and s.foreground and s.damaged
pure def reviewReset(s: VaultUi): VaultUi = { ...s, resetEpoch: s.epoch }
pure def canResetVault(s: VaultUi, ticket: int, nativeAuthenticated: bool): bool =
  s.active and s.foreground and s.damaged and s.resetEpoch > 0 and s.resetEpoch == s.epoch and s.epoch == ticket and nativeAuthenticated
pure def resetVault(s: VaultUi, ticket: int, nativeAuthenticated: bool): VaultUi = { ...clearAccess(false, s), damaged: false }
pure def refresh(s: VaultUi): VaultUi = { ...s, epoch: s.epoch + 1, resetEpoch: 0 }
pure def transfersAvailable(nativeAndroid: bool, testMocks: bool, pluginPresent: bool): bool = nativeAndroid and testMocks and pluginPresent
pure def lawTransferCannotReachProduction(nativeAndroid: bool, testMocks: bool, pluginPresent: bool): bool = not(testMocks) implies not(transfersAvailable(nativeAndroid, testMocks, pluginPresent))
pure def alwaysFillHasExactReview(s: VaultUi): bool = s.filled implies healthy(s) and s.reviewedOrigin != ""
pure def alwaysResetReviewHasMatchingEpoch(s: VaultUi): bool = s.resetEpoch == 0 or (s.resetEpoch == s.epoch and s.active and s.foreground and s.damaged)
pure def alwaysEpochPositive(s: VaultUi): bool = s.epoch > 0
pure def stepResetRequiresCurrentReview(before: VaultUi, via: str, after: VaultUi): bool = via == "resetVault" implies before.damaged and before.resetEpoch == before.epoch and not(after.damaged) and after.locked
pure def sometimesFillsReviewedField(s: VaultUi): bool = s.filled
pure def sometimesDamagedVaultHasReview(s: VaultUi): bool = s.damaged and s.resetEpoch > 0
pure val originValues = Set("", "https://one.test", "https://two.test")
```
