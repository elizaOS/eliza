# Identity and sign-in

`@elizaos/auth` is Eliza's identity package: the identity service a branded
cloud deployment runs (code and Google sign-in, second factors, sessions,
tenants, platform users), the trusted native host and Android library that
sign a device in, and the local custody of the agent's own credentials and
secrets. Every secret stays in a trusted host: a renderer only ever sees
non-secret receipts. A sign-in starts by checking the registered
application binding, and every product identity (tenant, client ids,
redirects, branding, wording) is configuration of a deployment, never a
constant of this package. Agent custody (wallets, signing policies, trading)
and secondary sign-in methods are not part of Eliza.

Identity service:
[one-time challenges](./challenges.md),
[code sign-in](./codeSignIn.md),
[Google sign-in](./googleSignIn.md),
[second factor](./mfa.md),
[MFA completion](./mfaCompletion.md),
[sessions](./sessions.md),
[account sign-in methods](./accountMethods.md),
[tenants](./tenants.md),
[platform users](./platformUsers.md),
[request integrity](./requestIntegrity.md),
[login webhooks](./webhooks.md),
[audit log](./audit.md),
[cutover from v3](./stateMigration.md).

Trusted host and device:
[account authority](./accountAuthority.md),
[credential broker](./credentialBroker.md),
[secure slots](./secureSlots.md),
[native enrollment](./native/enrollment.md),
[sign-in receipts](./native/receipt.md),
[browser sign-in return](./native/browserReturn.md),
[deep links](./native/deepLinks.md),
[Android sign-in](./native/android/signIn.md),
[Android sign-in requests](./native/android/signInRequests.md),
[Android sign-in cancel](./native/android/signInCancel.md),
[Android sign-in resend](./native/android/signInResend.md),
[Android activation](./native/android/activation.md),
[Android activation at startup](./native/android/activationRecovery.md),
[Android readiness](./native/android/readiness.md),
[Android return adoption](./native/android/returnAdoption.md),
[Android key renewal](./native/android/keyRenewal.md).

Agent credential custody:
[account storage](./accountStorage.md),
[storage lock](./accountStorageLock.md),
[storage reset](./accountStorageReset.md),
[provider access tokens](./accessTokens.md),
[account pool](./accountPool.md),
[account pool leases](./accountPoolLeases.md),
[device vault](./vault.md),
[key management](./kms.md).

Times are in seconds throughout.

## Story: Sign in to a branded cloud from a registered application

> As a person using an application built on Eliza, I want to sign in to that
> application's cloud deployment, so that the application can act for me,
> while no screen I look at ever holds my codes, verifiers or sessions.

### Every code, verifier and session stays in the trusted host, and a renderer receives only non-secret receipts

Codes, verifiers and session tokens are secret types, so `model` refuses any
path by which one reaches a receipt. A receipt is the request, attempt and
credential ids and nothing else, so two results that differ only in their
secrets give the renderer the same receipt.

```quint
type SecretSessionToken = int
type SecretVerifier = int
type SecretCode = int
type HostSignInResult = { requestId: int, attemptId: int, credentialId: int, sessionToken: SecretSessionToken, verifier: SecretVerifier, code: SecretCode }
type RendererReceipt = { requestId: int, attemptId: int, credentialId: int }
pure def receiptFor(r: HostSignInResult): RendererReceipt = { requestId: r.requestId, attemptId: r.attemptId, credentialId: r.credentialId }
pure def lawReceiptIgnoresSecrets(r: HostSignInResult, token: SecretSessionToken, verifier: SecretVerifier, code: SecretCode): bool =
  receiptFor({ ...r, sessionToken: token, verifier: verifier, code: code }) == receiptFor(r)
pure def lawReceiptCarriesOnlyIds(r: HostSignInResult): bool =
  receiptFor(r) == { requestId: r.requestId, attemptId: r.attemptId, credentialId: r.credentialId }
pure val rValues = Set({ requestId: 1, attemptId: 2, credentialId: 3, sessionToken: 4, verifier: 5, code: 6 }, { requestId: 1, attemptId: 1, credentialId: 1, sessionToken: 9, verifier: 9, code: 9 })
pure val tokenValues = Set(4, 7)
pure val verifierValues = Set(5, 8)
pure val codeValues = Set(6, 9)
```

### A registered application binding is checked before any network sign-in work

The binding names the application's client id, the deployment and the
return address; a binding that does not match the deployment's tenant
refuses the sign-in before anything is sent.

```quint
type AppBinding = { clientRegistered: bool, deploymentMatches: bool, redirectListed: bool }
type SignInStep = CheckBinding | RefuseSignIn | ContactIdentityService
pure def bindingValid(b: AppBinding): bool = b.clientRegistered and b.deploymentMatches and b.redirectListed
pure def signInPlan(b: AppBinding): List[SignInStep] = if (bindingValid(b)) List(CheckBinding, ContactIdentityService) else List(CheckBinding, RefuseSignIn)
pure def lawBindingCheckedFirst(b: AppBinding): bool = signInPlan(b).nthOr(0, RefuseSignIn) == CheckBinding
pure def lawInvalidBindingSendsNothing(b: AppBinding): bool = not(bindingValid(b)) implies signInPlan(b).select(planned => planned == ContactIdentityService).length() == 0
pure val bValues = Set(
  { clientRegistered: true, deploymentMatches: true, redirectListed: true },
  { clientRegistered: true, deploymentMatches: false, redirectListed: true },
  { clientRegistered: false, deploymentMatches: true, redirectListed: true })
```
