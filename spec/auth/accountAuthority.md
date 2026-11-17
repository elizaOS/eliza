# Account authority

Billing and account changes need the authority of the person's own account,
not only the device's credential. When a person verifies a code during a
payment or account check, the trusted host keeps the resulting session as
account authority: in memory only, bound to the exact credential that was
active when it was verified, and for at most an hour. It never writes it to
storage and never hands it to a renderer; the stored device credential stays
inference-only.

The same host decides whether the agent on the device sends its model
requests to the cloud. That binding belongs to the active credential too:
it is decided from one read of the verified identity and plan, and while
the cloud cannot be reached it is kept only under a recent plan record of
the same sign-in. It never decides whether the agent runs.

The entitlement reads that use this authority, and the plan the cloud
reports, are in [cloud entitlements](../cloud/entitlements.md).

## Story: Use my account's authority for billing and account changes without re-enrolling

> As a person, I want to confirm a payment or an account change with a code,
> without signing this device in again, and I want that confirmation to count
> only for my own account on this device, and only briefly.

### Account authority lives only in memory, bound to the active credential, and never reaches a renderer

```quint
type AuthorityPurpose = BillingPurpose | AccountPurpose
type CheckResult = NoCheck | CheckStarted | MfaNeeded | AuthorityGranted | BillingAccountMismatch | BillingAccountChanged | BillingSessionExpired | AuthorityCleared
type HeldAuthority = { present: bool, credential: int, user: int, organization: int, issuedAt: int, expiresAt: int }
type CheckAttempt = { open: bool, credential: int, purpose: AuthorityPurpose, mfaPending: bool }
type InferenceBinding = Unbound | BoundToCloud | KeptOffline
type AdmissionReason = NotAdmitted | Admitted | AdmittedFromRecord | Offline | SignInRejected | AccountChanged | NeedsPlan | PlanUnavailable
type PlanRecord = { present: bool, credential: int, user: int, verifiedAt: int, hasEnd: bool, endsAt: int }
type AccountAuthority = {
  now: int, credential: int, credentialUser: int, credentialOrganization: int,
  attempt: CheckAttempt, authority: HeldAuthority, result: CheckResult,
  binding: InferenceBinding, boundCredential: int, record: PlanRecord, admitting: bool, admitCredential: int, admission: AdmissionReason,
  rebindRunning: bool, rebindQueued: bool, hostBusy: bool, rebindsStarted: int
}
pure val noAuthority: HeldAuthority = { present: false, credential: 0, user: 0, organization: 0, issuedAt: 0, expiresAt: 0 }
pure val noAttempt: CheckAttempt = { open: false, credential: 0, purpose: BillingPurpose, mfaPending: false }
pure val noRecord: PlanRecord = { present: false, credential: 0, user: 0, verifiedAt: 0, hasEnd: false, endsAt: 0 }
pure val initial: AccountAuthority = {
  now: 0, credential: 1, credentialUser: 1, credentialOrganization: 1,
  attempt: noAttempt, authority: noAuthority, result: NoCheck,
  binding: Unbound, boundCredential: 0, record: noRecord, admitting: false, admitCredential: 0, admission: NotAdmitted,
  rebindRunning: false, rebindQueued: false, hostBusy: false, rebindsStarted: 0
}
pure def usableAuthority(s: AccountAuthority): bool = s.authority.present and s.authority.credential == s.credential and s.now < s.authority.expiresAt
pure def alwaysAuthorityBoundToActiveCredential(s: AccountAuthority): bool =
  s.authority.present implies (s.authority.credential == s.credential and s.authority.user == s.credentialUser and s.authority.organization == s.credentialOrganization)
pure def sometimesAuthorityHeld(s: AccountAuthority): bool = usableAuthority(s)
```

### A check refuses a session for a different user or organization with `billing_account_mismatch`

The host reads the account the verified session belongs to and compares it
with the owner of the active credential. A personal-purpose session carries
no tenant, so its subject is compared with the credential owner's identity
user. If the active credential changed during the check, the check ends with
`billing_account_changed`. Either refusal clears the attempt.

```quint
pure def canStartCheck(s: AccountAuthority, purpose: AuthorityPurpose): bool = s.credential > 0
pure def startCheck(s: AccountAuthority, purpose: AuthorityPurpose): AccountAuthority =
  { ...s, attempt: { open: true, credential: s.credential, purpose: purpose, mfaPending: false }, authority: noAuthority, result: CheckStarted }
pure val maxAuthorityLifetime = 3600
pure def verified(user: int, organization: int, subject: int, tokenLifetime: int, s: AccountAuthority): AccountAuthority =
  if (s.attempt.credential != s.credential) { ...s, attempt: noAttempt, authority: noAuthority, result: BillingAccountChanged }
  else if (user != s.credentialUser or organization != s.credentialOrganization or (s.attempt.purpose == AccountPurpose and subject != s.credentialUser))
    { ...s, attempt: noAttempt, authority: noAuthority, result: BillingAccountMismatch }
  else if (tokenLifetime <= 0) { ...s, attempt: noAttempt, result: BillingSessionExpired }
  else { ...s, attempt: noAttempt, result: AuthorityGranted,
    authority: { present: true, credential: s.credential, user: user, organization: organization, issuedAt: s.now, expiresAt: s.now + (if (tokenLifetime < maxAuthorityLifetime) tokenLifetime else maxAuthorityLifetime) } }
pure def canVerifyCheck(s: AccountAuthority, mfaRequired: bool): bool = s.attempt.open and not(s.attempt.mfaPending)
pure def verifyCheck(s: AccountAuthority, user: int, organization: int, subject: int, tokenLifetime: int, mfaRequired: bool): AccountAuthority =
  if (mfaRequired) { ...s, attempt: { ...s.attempt, mfaPending: true }, result: MfaNeeded } else verified(user, organization, subject, tokenLifetime, s)
pure def canCompleteCheckMfa(s: AccountAuthority): bool = s.attempt.open and s.attempt.mfaPending
pure def completeCheckMfa(s: AccountAuthority, user: int, organization: int, subject: int, tokenLifetime: int): AccountAuthority = verified(user, organization, subject, tokenLifetime, s)
pure val userValues = Set(1, 2)
pure val organizationValues = Set(1, 2)
pure val subjectValues = Set(1, 2)
pure val tokenLifetimeValues = Set(0, 600, 7200)
pure def stepGrantMatchesCredentialOwner(before: AccountAuthority, via: str, after: AccountAuthority): bool =
  (after.result == AuthorityGranted and before.result != AuthorityGranted) implies (after.authority.user == before.credentialUser and after.authority.organization == before.credentialOrganization and after.authority.credential == before.attempt.credential)
pure def sometimesMismatchRefused(s: AccountAuthority): bool = s.result == BillingAccountMismatch
pure def sometimesChangedCredentialRefused(s: AccountAuthority): bool = s.result == BillingAccountChanged
pure def sometimesGrantedAfterMfa(s: AccountAuthority): bool = s.result == AuthorityGranted and s.authority.present
```

### Authority is cleared by cancel, a new check, an explicit clear, its expiry or a credential change

Its expiry is the session's own, and never more than an hour after it was
verified.

```quint
pure def cancel(s: AccountAuthority): AccountAuthority = { ...s, attempt: noAttempt, authority: noAuthority, result: AuthorityCleared }
pure def clearAuthority(s: AccountAuthority): AccountAuthority = { ...s, authority: noAuthority, result: AuthorityCleared }
pure def canChangeCredential(s: AccountAuthority, user: int, organization: int): bool = user > 0 and organization > 0
pure def changeCredential(s: AccountAuthority, user: int, organization: int): AccountAuthority =
  { ...s, credential: s.credential + 1, credentialUser: user, credentialOrganization: organization, authority: noAuthority, binding: Unbound, boundCredential: 0 }
pure def canElapse(s: AccountAuthority, seconds: int): bool = seconds > 0
pure def elapse(s: AccountAuthority, seconds: int): AccountAuthority = {
  val later = s.now + seconds
  { ...s, now: later, authority: if (later >= s.authority.expiresAt) noAuthority else s.authority }
}
pure val secondsValues = Set(60, 600, 3600, 604800)
pure def stepClearingEventsDropAuthority(before: AccountAuthority, via: str, after: AccountAuthority): bool =
  (via == "cancel" or via == "clearAuthority" or via == "startCheck" or via == "changeCredential") implies not(after.authority.present)
pure def alwaysAuthorityWithinAnHour(s: AccountAuthority): bool =
  s.authority.present implies (s.authority.expiresAt <= s.authority.issuedAt + maxAuthorityLifetime and s.now < s.authority.expiresAt and s.authority.issuedAt <= s.now)
pure def sometimesClearedAfterGrant(s: AccountAuthority): bool = s.result == AuthorityCleared and s.credential == 1
```

## Story: Send the agent's model requests to the cloud only for the account signed in now

> As a person whose agent runs on this device, I want its model requests to
> go to the cloud only under my current sign-in and a plan the cloud
> confirmed, to keep working through a short outage when the cloud
> confirmed my plan recently, and never to carry an old account or an ended
> plan forward.

### Cloud inference is bound only to the credential that is active

An admission reads the saved credential, then the identity and plan the
cloud verifies for it, and binds that credential. Replacing the credential
removes the binding at once, until the new credential is admitted.

```quint
pure def canBeginAdmission(s: AccountAuthority): bool = not(s.admitting)
pure def beginAdmission(s: AccountAuthority): AccountAuthority = { ...s, admitting: true, admitCredential: s.credential }
pure def alwaysBindingOnActiveCredential(s: AccountAuthority): bool =
  s.binding != Unbound implies s.boundCredential == s.credential
pure def sometimesBoundToCloud(s: AccountAuthority): bool = s.binding == BoundToCloud and s.admission == Admitted
```

### An admission whose credential changed before it finished changes nothing

The host checks the credential again after the plan read. If it changed
meanwhile, the old admission ends with `account-changed` and neither
removes nor replaces the binding or the plan record that the newer
credential owns. An identity the cloud verified for another credential
also ends with `account-changed`, and removes the binding.

```quint
type PlanRead = CloudUnreachable | IdentityRejected | IdentityOfOtherCredential | PlanConfirmed | PlanEnded | PlanUnknown | BillingOutage
pure val offlineWindow = 604800
pure def recentRecord(s: AccountAuthority): bool =
  s.record.present and s.record.credential == s.credential and s.record.user == s.credentialUser and
    s.record.verifiedAt <= s.now and s.now - s.record.verifiedAt <= offlineWindow and (not(s.record.hasEnd) or s.now < s.record.endsAt)
pure def decided(binding: InferenceBinding, reason: AdmissionReason, record: PlanRecord, s: AccountAuthority): AccountAuthority =
  { ...s, admitting: false, binding: binding, boundCredential: if (binding == Unbound) 0 else s.credential, record: record, admission: reason }
pure def confirmedRecord(planEnd: int, s: AccountAuthority): PlanRecord =
  if (planEnd > 0) { present: true, credential: s.credential, user: s.credentialUser, verifiedAt: s.now, hasEnd: true, endsAt: s.now + planEnd }
  else if (planEnd < 0 and recentRecord(s) and s.record.hasEnd) { present: true, credential: s.credential, user: s.credentialUser, verifiedAt: s.now, hasEnd: true, endsAt: s.record.endsAt }
  else { present: true, credential: s.credential, user: s.credentialUser, verifiedAt: s.now, hasEnd: false, endsAt: 0 }
pure def canFinishAdmission(s: AccountAuthority, read: PlanRead, planEnd: int): bool = s.admitting
pure def finishAdmission(s: AccountAuthority, read: PlanRead, planEnd: int): AccountAuthority =
  if (s.admitCredential != s.credential) { ...s, admitting: false, admission: AccountChanged }
  else if (read == CloudUnreachable) decided(if (recentRecord(s)) KeptOffline else Unbound, Offline, s.record, s)
  else if (read == IdentityRejected) decided(Unbound, SignInRejected, noRecord, s)
  else if (read == IdentityOfOtherCredential) decided(Unbound, AccountChanged, s.record, s)
  else if (read == PlanEnded) decided(Unbound, NeedsPlan, noRecord, s)
  else if (read == PlanUnknown) decided(Unbound, PlanUnavailable, s.record, s)
  else if (read == BillingOutage) { if (recentRecord(s)) decided(BoundToCloud, AdmittedFromRecord, s.record, s) else decided(Unbound, PlanUnavailable, s.record, s) }
  else decided(BoundToCloud, Admitted, confirmedRecord(planEnd, s), s)
pure val readValues = Set(CloudUnreachable, IdentityRejected, IdentityOfOtherCredential, PlanConfirmed, PlanEnded, PlanUnknown, BillingOutage)
pure val planEndValues = Set(-1, 0, 3600, 1209600)
pure def stepStaleAdmissionChangesNothing(before: AccountAuthority, via: str, after: AccountAuthority): bool =
  (via == "finishAdmission" and before.admitCredential != before.credential) implies
    (after.binding == before.binding and after.boundCredential == before.boundCredential and after.record == before.record and after.admission == AccountChanged)
pure def sometimesStaleAdmissionRefused(s: AccountAuthority): bool = s.admission == AccountChanged and s.admitCredential != s.credential and s.record.present
```

### Offline, a binding is kept only under a recent plan record of the same sign-in

While the cloud cannot be reached, or billing cannot be read, the binding
stays only when this credential and user recorded a confirmed plan within
the last seven days whose end has not passed. A record of another sign-in,
an older one, or one whose plan ended grants nothing. The cloud still
decides each request once it answers.

```quint
pure def stepOfflineBindingOnlyFromRecentRecord(before: AccountAuthority, via: str, after: AccountAuthority): bool =
  (via == "finishAdmission" and (after.admission == AdmittedFromRecord or (after.admission == Offline and after.binding == KeptOffline))) implies recentRecord(before)
pure def sometimesKeptOffline(s: AccountAuthority): bool = s.binding == KeptOffline and s.admission == Offline
pure def sometimesOutageAdmittedFromRecord(s: AccountAuthority): bool = s.binding == BoundToCloud and s.admission == AdmittedFromRecord
pure def sometimesOtherSignInRecordIgnored(s: AccountAuthority): bool = s.record.present and s.record.credential != s.credential and s.admission == Offline and s.binding == Unbound
pure def sometimesOldRecordKeepsNothing(s: AccountAuthority): bool = s.record.present and s.record.credential == s.credential and s.now - s.record.verifiedAt > offlineWindow and s.admission == Offline and s.binding == Unbound
```

### A plan end already past is never recorded or carried forward

A confirmed plan is recorded with the end the cloud reported. When the
cloud did not say, the end of a recent record is carried, and a record
whose end has passed is not recent. A refused sign-in or a plan the cloud
says ended (`needs-plan`) removes the record; a plan the cloud could not
read keeps it.

```quint
pure def alwaysRecordedEndIsAfterVerification(s: AccountAuthority): bool =
  s.record.present implies ((not(s.record.hasEnd) or s.record.endsAt > s.record.verifiedAt) and s.record.verifiedAt <= s.now)
pure def alwaysRefusalForgetsRecord(s: AccountAuthority): bool = (s.admission == SignInRejected or s.admission == NeedsPlan) implies not(s.record.present)
pure def sometimesCarriedEnd(s: AccountAuthority): bool = s.record.present and s.record.hasEnd and s.record.endsAt > s.now and s.admission == Admitted and s.record.verifiedAt > 0
pure def sometimesRejectionForgotRecord(s: AccountAuthority): bool = s.admission == SignInRejected and not(s.record.present) and s.now > 0
```

### At most one rebind runs, and one more waits behind it

A request to rebind while one runs, or while the host is busy with
another credential operation, waits; further requests join the one that
waits. The waiting rebind runs when the running one settles or the host
becomes idle, so it is never left waiting while nothing would start it.

```quint
pure def requestRebind(s: AccountAuthority): AccountAuthority =
  if (not(s.rebindRunning) and not(s.hostBusy)) { ...s, rebindRunning: true, rebindsStarted: s.rebindsStarted + 1 } else { ...s, rebindQueued: true }
pure def canRebindSettles(s: AccountAuthority): bool = s.rebindRunning
pure def rebindSettles(s: AccountAuthority): AccountAuthority =
  if (s.rebindQueued and not(s.hostBusy)) { ...s, rebindQueued: false, rebindsStarted: s.rebindsStarted + 1 } else { ...s, rebindRunning: false }
pure def canHostBecomesBusy(s: AccountAuthority): bool = not(s.hostBusy)
pure def hostBecomesBusy(s: AccountAuthority): AccountAuthority = { ...s, hostBusy: true }
pure def canHostBecomesIdle(s: AccountAuthority): bool = s.hostBusy
pure def hostBecomesIdle(s: AccountAuthority): AccountAuthority =
  if (s.rebindQueued and not(s.rebindRunning)) { ...s, hostBusy: false, rebindQueued: false, rebindRunning: true, rebindsStarted: s.rebindsStarted + 1 } else { ...s, hostBusy: false }
pure def alwaysQueuedRebindHasSomethingToWaitFor(s: AccountAuthority): bool = s.rebindQueued implies (s.rebindRunning or s.hostBusy)
pure val fair_rebindSettles = "weak"
pure val fair_hostBecomesIdle = "weak"
pure def leadsToQueuedRebindRuns(s: AccountAuthority, later: AccountAuthority): bool = s.rebindQueued implies not(later.rebindQueued)
pure def sometimesQueuedRebindRan(s: AccountAuthority): bool = s.rebindsStarted >= 2 and not(s.rebindQueued) and s.rebindRunning
```
