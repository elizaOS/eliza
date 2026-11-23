# Native passwords

The [Android vault](../os/android/passwords/vault.md), [Autofill policy](../os/android/passwords/autofill.md) and [protected browser sign-in](../os/index.md) govern custody. The bridge is a metadata and native-dialog interface. The shell holds its native secrets.

## Story: Manage saved passwords without revealing them to the application renderer

> As the owner, I want the local vault to report entries and outcomes while password entry, selection, copy and fills remain in the native interface.

### The renderer can observe only public vault status and owner-authorized metadata

Sensitive native operations require app ownership and a fresh unlock. A reveal or copy additionally needs Android's own affordance. A secret value never appears in the public schema.

```quint
type VaultAction = VaultStatus | ListVaultMetadata | OpenVaultEditor | RemoveVaultEntry | ResetVault | OpenNativeReveal | OpenNativeCopy | OpenAutofillSettings
type VaultAuthority = { appOwner: bool, freshUnlock: bool, nativeAffordance: bool, expectedRevisionMatches: bool }
type VaultPayload = PublicVaultStatus | PublicVaultMetadata | VaultReceipt | PlaintextPassword
pure def mayUseVault(authority: VaultAuthority, operation: VaultAction): bool =
  authority.appOwner and
  (operation == VaultStatus or operation == OpenAutofillSettings or
   (authority.freshUnlock and
    (operation != RemoveVaultEntry or authority.expectedRevisionMatches) and
    ((operation != OpenNativeReveal and operation != OpenNativeCopy) or authority.nativeAffordance)))
pure def mayReturnVaultPayload(payload: VaultPayload): bool = payload != PlaintextPassword
pure def lawPublicVaultCannotReturnPlaintext(payload: VaultPayload): bool =
  mayReturnVaultPayload(payload) implies payload != PlaintextPassword
pure def lawNativeRevealNeedsAffordance(authority: VaultAuthority): bool =
  mayUseVault(authority, OpenNativeReveal) implies authority.freshUnlock and authority.nativeAffordance
pure val authorityValues = Set(
  { appOwner: true, freshUnlock: true, nativeAffordance: true, expectedRevisionMatches: true },
  { appOwner: true, freshUnlock: true, nativeAffordance: false, expectedRevisionMatches: true },
  { appOwner: true, freshUnlock: false, nativeAffordance: true, expectedRevisionMatches: false })
```
