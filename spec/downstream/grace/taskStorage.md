# Native task storage custody

Grace opens an account-scoped task database through
`packages/host/native-host/task-sqlcipher.mjs`. It uses separate derived
database and file keys from `task-storage-sealing.mjs` under the `grace`
namespace. Task evidence and the outcome journal use different authenticated
purposes. The broker and Grace's account custody code own key creation,
deletion and data migration. Core conversation storage has a separate
lifetime and uses in-memory PGlite on the tablet.

## Story: Refuse task storage when encrypted custody cannot be verified

### Android admission requires the accepted driver, private path, key and owner

The SQLCipher provider verifies the native library identity and architecture.
It admits a canonical private path and holds the database lease while
obtaining a 32-byte key and opening the handle. It wipes temporary key bytes
and releases the lease on completion or failure. The gateway verifies the
exact returned connection against the exact path when encryption is
required. Loss of account custody prevents queries and effective responses
from already prepared statements. SQL, cryptography, and native handles
remain outside the model, and their checked results enter through these
admission facts.

```quint
type StorageFacts = { acceptedLibrary: bool, canonicalPrivatePath: bool, leaseHeld: bool, keyPresent: bool, ownerCurrent: bool, nativeOpened: bool, providerAttested: bool }
type CustodyPhase = StorageClosed | StorageReady | StorageUnavailable
type TaskStore = { ownerEpoch: int, handleEpoch: int, phase: CustodyPhase }
pure val closedStorage: CustodyPhase = StorageClosed
pure val readyStorage: CustodyPhase = StorageReady
pure val unavailableStorage: CustodyPhase = StorageUnavailable
pure val initial: TaskStore = { ownerEpoch: 1, handleEpoch: 0, phase: closedStorage }
pure def admitStorage(facts: StorageFacts): bool =
  facts.acceptedLibrary and facts.canonicalPrivatePath and facts.leaseHeld and
  facts.keyPresent and facts.ownerCurrent and facts.nativeOpened and facts.providerAttested
pure def canOpenStorage(s: TaskStore): bool = s.phase != readyStorage
pure def openStorage(s: TaskStore, facts: StorageFacts): TaskStore =
  if (admitStorage(facts)) { ...s, handleEpoch: s.ownerEpoch, phase: readyStorage }
  else { ...s, phase: unavailableStorage }
pure def loseCustody(s: TaskStore): TaskStore =
  { ...s, ownerEpoch: s.ownerEpoch + 1, phase: closedStorage }
pure def closeStorage(s: TaskStore): TaskStore = { ...s, phase: closedStorage }
pure def permitsQuery(s: TaskStore, queryEpoch: int, ownerCurrent: bool): bool =
  s.phase == readyStorage and s.ownerEpoch == queryEpoch and s.handleEpoch == queryEpoch and ownerCurrent
pure def alwaysReadyConnectionBelongsToCurrentEpoch(s: TaskStore): bool =
  s.phase == readyStorage implies s.handleEpoch == s.ownerEpoch
pure def stepOpenRequiresVerification(before: TaskStore, via: str, after: TaskStore): bool =
  via == "openStorage" and after.phase == readyStorage implies after.handleEpoch == before.ownerEpoch
pure def lawUnverifiedStorageCannotOpen(facts: StorageFacts): bool = not(facts.providerAttested) implies not(admitStorage(facts))
pure def lawAbsentCustodyRejectsQuery(s: TaskStore, queryEpoch: int): bool = not(permitsQuery(s, queryEpoch, false))
pure def lawEarlierEpochRejectsQuery(s: TaskStore, queryEpoch: int): bool =
  queryEpoch != s.ownerEpoch implies not(permitsQuery(s, queryEpoch, true))
pure def sometimesEncryptedStoreOpens(s: TaskStore): bool = s.phase == readyStorage
pure def sometimesAdmissionFails(s: TaskStore): bool = s.phase == unavailableStorage
pure val completeFacts: StorageFacts = { acceptedLibrary: true, canonicalPrivatePath: true, leaseHeld: true, keyPresent: true, ownerCurrent: true, nativeOpened: true, providerAttested: true }
pure val factsValues = Set(completeFacts, { ...completeFacts, keyPresent: false },
  { ...completeFacts, providerAttested: false }, { ...completeFacts, ownerCurrent: false })
pure val sValues = Set(initial, { ...initial, handleEpoch: 1, phase: readyStorage })
pure val queryEpochValues = Set(0, 1, 2)
```

## Story: Reopen sealed evidence without exposing it across stores

### A sealed payload is restricted to its account key, namespace and purpose

The source's HKDF labels distinguish the database and file keys. File sealing
uses an authenticated namespace prefix and purpose, with fresh nonce and
authentication tag. The model gives the cryptographic verifier's result an
explicit input and states which decoded records a caller can consume. Native
code must verify the authenticated bytes, enforce private filesystem
permissions and wipe key material. A failed verification is an explicit
storage error.

```quint
type StoragePurpose = OutcomeJournal | TaskEvidence | WebsiteEvidence
type SealedHeader = { keyId: str, namespace: str, purpose: StoragePurpose, authenticated: bool }
pure def permitsOpen(header: SealedHeader, keyId: str, namespace: str, purpose: StoragePurpose, ownerCurrent: bool): bool =
  ownerCurrent and header.authenticated and header.keyId == keyId and
  header.namespace == namespace and header.purpose == purpose
pure def lawAnotherPurposeCannotOpen(header: SealedHeader, keyId: str, namespace: str, purpose: StoragePurpose): bool =
  header.purpose != purpose implies not(permitsOpen(header, keyId, namespace, purpose, true))
pure def lawUnverifiedCiphertextCannotOpen(header: SealedHeader, keyId: str, namespace: str, purpose: StoragePurpose): bool =
  not(header.authenticated) implies not(permitsOpen(header, keyId, namespace, purpose, true))
pure def lawForeignAccountKeyCannotOpen(header: SealedHeader, keyId: str, namespace: str, purpose: StoragePurpose): bool =
  header.keyId != keyId implies not(permitsOpen(header, keyId, namespace, purpose, true))
pure val headerValues = Set(
  { keyId: "slotA", namespace: "grace", purpose: OutcomeJournal, authenticated: true },
  { keyId: "slotA", namespace: "grace", purpose: TaskEvidence, authenticated: true },
  { keyId: "slotA", namespace: "grace", purpose: TaskEvidence, authenticated: false })
pure val keyIdValues = Set("slotA", "slotB")
pure val namespaceValues = Set("grace", "other")
```
