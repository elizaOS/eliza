# Account authority

Billing and account changes need the authority of the person's own account,
not only the device's credential. When a person verifies a code during a
payment or account check, the trusted host keeps the resulting session as
account authority: in memory only, bound to the exact credential that was
active when it was verified, and for at most an hour. It never writes it to
storage and never hands it to a renderer; the stored device credential stays
inference-only. Times are in seconds.

New in v4, from the billing authority of develop
`native-host/cloud-enrollment.mjs` (`billingAuthority`, `clearBilling`,
`confirmBilling`). The entitlement reads that use this authority are in
[cloud entitlements](../cloud/entitlements.md).

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
type AccountAuthority = {
  now: int, credential: int, credentialUser: int, credentialOrganization: int,
  attempt: CheckAttempt, authority: HeldAuthority, result: CheckResult, storageWrites: int, rendererTokens: int
}
pure val noAuthority: HeldAuthority = { present: false, credential: 0, user: 0, organization: 0, issuedAt: 0, expiresAt: 0 }
pure val noAttempt: CheckAttempt = { open: false, credential: 0, purpose: BillingPurpose, mfaPending: false }
pure val initial: AccountAuthority = {
  now: 0, credential: 1, credentialUser: 1, credentialOrganization: 1,
  attempt: noAttempt, authority: noAuthority, result: NoCheck, storageWrites: 0, rendererTokens: 0
}
pure def usableAuthority(s: AccountAuthority): bool = s.authority.present and s.authority.credential == s.credential and s.now < s.authority.expiresAt
pure def alwaysAuthorityBoundToActiveCredential(s: AccountAuthority): bool =
  (s.authority.present implies (s.authority.credential == s.credential and s.authority.user == s.credentialUser and s.authority.organization == s.credentialOrganization))
    and s.storageWrites == 0 and s.rendererTokens == 0
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
  { ...s, credential: s.credential + 1, credentialUser: user, credentialOrganization: organization, authority: noAuthority }
pure def canElapse(s: AccountAuthority, seconds: int): bool = seconds > 0
pure def elapse(s: AccountAuthority, seconds: int): AccountAuthority = {
  val later = s.now + seconds
  { ...s, now: later, authority: if (later >= s.authority.expiresAt) noAuthority else s.authority }
}
pure val secondsValues = Set(60, 600, 3600)
pure def stepClearingEventsDropAuthority(before: AccountAuthority, via: str, after: AccountAuthority): bool =
  (via == "cancel" or via == "clearAuthority" or via == "startCheck" or via == "changeCredential") implies not(after.authority.present)
pure def alwaysAuthorityWithinAnHour(s: AccountAuthority): bool =
  s.authority.present implies (s.authority.expiresAt <= s.authority.issuedAt + maxAuthorityLifetime and s.now < s.authority.expiresAt and s.authority.issuedAt <= s.now)
pure def sometimesClearedAfterGrant(s: AccountAuthority): bool = s.result == AuthorityCleared and s.credential == 1
```
