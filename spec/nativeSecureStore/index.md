# Native secure store

The platform bridges use the Apple Keychain or Android Keystore. The [Android secure store](../os/android/secureStore.md) owns Android slot writes and readback, and [device credential custody](../os/signIn/credential.md) governs when a credential is usable. This package exposes the cross-platform app boundary.

## Story: Read or change an app credential only on my device

> As the device owner, I want credentials kept in an app-only, nonsynchronizing native store, with storage failures distinct from an absent value.

### Only fixed account slots under device-only app custody admit access

Chrome or another unsupported host returns unavailable. No plaintext credential belongs to model state, transport logging, status results or generic application storage. A receipt records only the result class.

```quint
type SecureAccount = DeviceAuthAccount | StewardAccount | PendingCloudAccount | ActiveServerAccount | AgentProfilesAccount
type SecureBackend = AppleKeychain | AndroidKeystore | NoSecureBackend
type SecureAccessibility = AppleAfterFirstUnlock | AndroidCredentialEncrypted | AccessUnavailable
type StoreStatus = { backend: SecureBackend, accessibility: SecureAccessibility, appOnly: bool, synchronized: bool }
type StoreOutcome = StoreRead | StoreWritten | StoreRemoved | StoreAbsent | StoreDenied | StoreUnavailable | StoreInvalid | StoreNativeFailure
pure def availableStore(status: StoreStatus): bool =
  status.appOnly and not(status.synchronized) and
  ((status.backend == AppleKeychain and status.accessibility == AppleAfterFirstUnlock) or
   (status.backend == AndroidKeystore and status.accessibility == AndroidCredentialEncrypted))
pure def appStoreOperation(status: StoreStatus, slot: SecureAccount, nativeOutcome: StoreOutcome): StoreOutcome =
  if (availableStore(status)) nativeOutcome else StoreUnavailable
pure def lawUnavailableStoreIsNeverAbsent(status: StoreStatus, slot: SecureAccount, nativeOutcome: StoreOutcome): bool =
  not(availableStore(status)) implies appStoreOperation(status, slot, nativeOutcome) == StoreUnavailable
pure def lawSynchronizingStoreIsUnavailable(status: StoreStatus): bool =
  status.synchronized implies not(availableStore(status))
pure val statusValues = Set(
  { backend: AppleKeychain, accessibility: AppleAfterFirstUnlock, appOnly: true, synchronized: false },
  { backend: AndroidKeystore, accessibility: AndroidCredentialEncrypted, appOnly: true, synchronized: false },
  { backend: AppleKeychain, accessibility: AppleAfterFirstUnlock, appOnly: true, synchronized: true },
  { backend: NoSecureBackend, accessibility: AccessUnavailable, appOnly: false, synchronized: false })
```
