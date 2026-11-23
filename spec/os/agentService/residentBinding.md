# Resident owner and inference binding

## Story: Keep my local agent running before and between service sign-ins

> As the installed device's owner, I want my local agent to start from
> the device's private storage even when I cannot use Cloud inference,
> and to keep the same local records when I sign in again.

### The resident launch needs its own readable vault, even without inference

A consumer may opt in to a resident without an inference credential.
Its native host resolves a durable owner and vault before making a
launch document. The vault includes its sealed key and the persisted
principal, agent and embedding preference. A missing or unreadable
vault refuses the launch. The owner identity and vault do not come from
the Cloud session, renderer or launch token. A consumer that requires
an inference credential retains its existing launch rule.

```quint
type ServiceAccount = { origin: int, subject: int, organization: int }
type ResidentBinding = { owner: int, vault: int, linked: ServiceAccount }
type InferenceKey = NoInferenceKey | VerifiedInferenceKey({ account: ServiceAccount, version: int }) | VerifiedOwnerKey({ keyOwner: int, version: int })
type ResidentBackend = NoInference | CloudInference({ account: ServiceAccount, version: int }) | OwnerInference({ keyOwner: int, version: int })
type ResidentAdmission = RefuseResidentStorage | RefuseMissingCredential | StartResident({ owner: int, vault: int, backend: ResidentBackend })
pure val noServiceAccount: ServiceAccount = { origin: 0, subject: 0, organization: 0 }
pure def knownAccount(account: ServiceAccount): bool = account.origin > 0 and account.subject > 0 and account.organization > 0
pure def residentBackend(binding: ResidentBinding, key: InferenceKey): ResidentBackend =
  match key {
    | VerifiedInferenceKey(k) =>
        if (knownAccount(k.account) and k.account == binding.linked and k.version > 0)
          CloudInference({ account: k.account, version: k.version })
        else NoInference
    | VerifiedOwnerKey(k) =>
        if (binding.owner > 0 and k.keyOwner == binding.owner and k.version > 0)
          OwnerInference({ keyOwner: k.keyOwner, version: k.version })
        else NoInference
    | NoInferenceKey => NoInference
  }
pure def residentAdmission(allowResident: bool, storageReady: bool, binding: ResidentBinding, key: InferenceKey): ResidentAdmission = {
  val backend = residentBackend(binding, key)
  if (not(storageReady) or binding.owner <= 0 or binding.vault <= 0) RefuseResidentStorage
  else if (not(allowResident) and backend == NoInference) RefuseMissingCredential
  else StartResident({ owner: binding.owner, vault: binding.vault, backend: backend })
}
pure val primaryAccount: ServiceAccount = { origin: 1, subject: 1, organization: 1 }
pure val otherOrg: ServiceAccount = { ...primaryAccount, organization: 2 }
pure val accountValues = Set(noServiceAccount, primaryAccount, otherOrg, { ...primaryAccount, origin: 2 }, { ...primaryAccount, subject: 2 })
pure val installed: ResidentBinding = { owner: 1, vault: 1, linked: primaryAccount }
pure val bindingValues = Set(installed, { ...installed, linked: noServiceAccount }, { ...installed, vault: 0 })
pure val keyValues = Set(NoInferenceKey, VerifiedInferenceKey({ account: primaryAccount, version: 1 }),
  VerifiedInferenceKey({ account: primaryAccount, version: 2 }), VerifiedInferenceKey({ account: otherOrg, version: 2 }),
  VerifiedOwnerKey({ keyOwner: 1, version: 1 }), VerifiedOwnerKey({ keyOwner: 2, version: 1 }))
pure def lawStorageFailureNeverStarts(allowResident: bool, binding: ResidentBinding, key: InferenceKey): bool =
  residentAdmission(allowResident, false, binding, key) == RefuseResidentStorage
pure def lawOfflineLaunchKeepsTheResident(binding: ResidentBinding): bool =
  (binding.owner > 0 and binding.vault > 0) implies
    residentAdmission(true, true, binding, NoInferenceKey) == StartResident({ owner: binding.owner, vault: binding.vault, backend: NoInference })
pure def lawCredentialRequiredIsStillEnforced(binding: ResidentBinding): bool =
  (binding.owner > 0 and binding.vault > 0) implies residentAdmission(false, true, binding, NoInferenceKey) == RefuseMissingCredential
```

### Cloud inference uses the exact linked account and a newer key can rotate in place

The native sign-in result may link the first account only with a verified
account and the local owner's explicit approval. Linked identity includes
the canonical service origin, verified subject and organization. Later
sign-ins must match that tuple to use it with this vault. A different
account cannot link over it. Sign-out, expiry and mismatched credentials
drop Cloud inference and keep the local binding. An owner-supplied key
can enable its own backend only from the same local owner's native
credential store. Replacing that backend's key needs a new launch.
A change of backend or
storage binding retires the old socket and waits for the child to be
reaped before starting again. A strictly newer key for the same account
and current serving launch can rotate without replacing that launch.
These rules leave manual stop and an app update hold in charge of whether
any new launch can start.

```quint
pure def linkResident(binding: ResidentBinding, account: ServiceAccount, ownerApproved: bool): ResidentBinding =
  if (binding.linked == noServiceAccount and binding.owner > 0 and binding.vault > 0 and knownAccount(account) and ownerApproved)
    { ...binding, linked: account }
  else binding
pure def lawASecondAccountCannotReplaceTheLink(binding: ResidentBinding, account: ServiceAccount, ownerApproved: bool): bool =
  binding.linked != noServiceAccount implies linkResident(binding, account, ownerApproved) == binding
pure def lawLinkDoesNotChangeOwnerOrVault(binding: ResidentBinding, account: ServiceAccount, ownerApproved: bool): bool =
  linkResident(binding, account, ownerApproved).owner == binding.owner and linkResident(binding, account, ownerApproved).vault == binding.vault
pure def lawAKeyForAnotherAccountDoesNotEnableInference(binding: ResidentBinding, account: ServiceAccount, version: int): bool =
  account != binding.linked implies residentBackend(binding, VerifiedInferenceKey({ account: account, version: version })) == NoInference
pure def lawAnOwnKeyForAnotherOwnerDoesNotEnableInference(binding: ResidentBinding, keyOwner: int, version: int): bool =
  keyOwner != binding.owner implies residentBackend(binding, VerifiedOwnerKey({ keyOwner: keyOwner, version: version })) == NoInference

type ResidentRollout = KeepLaunch | RotateKey | RetireLaunch
pure def sameCloudAccount(before: ResidentBackend, after: ResidentBackend): bool =
  match before {
    | CloudInference(b) => match after { | CloudInference(a) => b.account == a.account | _ => false }
    | _ => false
  }
pure def backendVersion(backend: ResidentBackend): int = match backend { | CloudInference(c) => c.version | _ => 0 }
pure def residentRollout(sameBinding: bool, serving: ResidentBackend, desired: ResidentBackend): ResidentRollout =
  if (not(sameBinding)) RetireLaunch
  else if (sameCloudAccount(serving, desired))
    (if (backendVersion(desired) > backendVersion(serving)) RotateKey else KeepLaunch)
  else if (serving == desired) KeepLaunch
  else RetireLaunch
pure val servingValues = Set(NoInference, CloudInference({ account: primaryAccount, version: 1 }),
  CloudInference({ account: primaryAccount, version: 2 }), CloudInference({ account: otherOrg, version: 1 }),
  OwnerInference({ keyOwner: 1, version: 1 }), OwnerInference({ keyOwner: 1, version: 2 }))
pure val desiredValues = servingValues
pure def lawBackendChangeRetiresBeforeServing(desired: ResidentBackend): bool =
  desired != NoInference implies residentRollout(true, NoInference, desired) == RetireLaunch
pure def lawARotationKeepsTheBindingAndAdvancesTheKey(sameBinding: bool, serving: ResidentBackend, desired: ResidentBackend): bool =
  residentRollout(sameBinding, serving, desired) == RotateKey implies
    sameBinding and sameCloudAccount(serving, desired) and backendVersion(desired) > backendVersion(serving)
```

### An inferred change applies only to the current service phase and epoch

A change during a check replaces the pending launch decision when it
would change the binding, backend or key. A child that has spawned but
is still starting is replaced for a changed launch. Once the child is
running, binding or backend changes retire it and the old channel before
another launch can serve. A newer Cloud key takes the in-place path only
for the running epoch.
While a child is being reaped, the next launch reads the current binding
after exit. An inference change by itself cannot start a stopped
resident, or advance a launch during an app update hold.

```quint
type ResidentServicePhase = ResidentStopped | ResidentChecking | ResidentStarting | ResidentServing | ResidentReaping
type ReconcileResident = LeaveService | ReplaceCheck | RetireChild | PushServingKey
pure def reconcileResident(phase: ResidentServicePhase, held: bool, change: ResidentRollout): ReconcileResident =
  if (held) LeaveService
  else match phase {
    | ResidentStopped => LeaveService
    | ResidentChecking => if (change == KeepLaunch) LeaveService else ReplaceCheck
    | ResidentStarting => if (change == KeepLaunch) LeaveService else RetireChild
    | ResidentServing => match change {
        | KeepLaunch => LeaveService
        | RotateKey => PushServingKey
        | RetireLaunch => RetireChild
      }
    | ResidentReaping => LeaveService
  }
pure def lawStoppedResidentIgnoresInferenceChanges(held: bool, change: ResidentRollout): bool =
  reconcileResident(ResidentStopped, held, change) == LeaveService
pure def lawTheUpdateHoldStopsResidentReconciliation(phase: ResidentServicePhase, change: ResidentRollout): bool =
  reconcileResident(phase, true, change) == LeaveService
pure def lawOnlyTheServingResidentCanRotate(phase: ResidentServicePhase, held: bool, change: ResidentRollout): bool =
  (reconcileResident(phase, held, change) == PushServingKey) iff (phase == ResidentServing and not(held) and change == RotateKey)
pure def lawAChangedServingBackendRetiresItsChild(held: bool): bool =
  reconcileResident(ResidentServing, held, RetireLaunch) == (if (held) LeaveService else RetireChild)
pure def lawReapingWaitsForTheExit(held: bool, change: ResidentRollout): bool =
  reconcileResident(ResidentReaping, held, change) == LeaveService
pure def currentEpochCanPush(expectedEpoch: int, servingEpoch: int, phase: ResidentServicePhase): bool =
  expectedEpoch > 0 and expectedEpoch == servingEpoch and phase == ResidentServing
pure def lawAStaleEpochCannotPush(expectedEpoch: int, servingEpoch: int, phase: ResidentServicePhase): bool =
  expectedEpoch != servingEpoch implies not(currentEpochCanPush(expectedEpoch, servingEpoch, phase))
pure val expectedEpochValues = Set(0, 1, 2)
pure val servingEpochValues = Set(0, 1, 2)
```
