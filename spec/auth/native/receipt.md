# Sign-in receipts

The auth package's renderer port admits the results that the Android
sign-in plugin returns, and a consumer's renderer wraps it. The native
side is [Android sign-in](./android/signIn.md), with its renderer
[requests](./android/signInRequests.md), [cancel](./android/signInCancel.md)
and [resend](./android/signInResend.md); a browser return that lands in
another process is in [browser return](./browserReturn.md). A host-run
enrollment uses [enrollment](./enrollment.md) instead.

## Story: Complete sign-in only from the expected native request

> As a person signing in on the device, I want the app to accept a result
> only from the sign-in I started for this deployment, and never to see my
> codes or keys.

### The renderer accepts only documented, deployment-matched metadata

Successful authentication names the expected deployment and projects only
receipt fields. It carries attempt, credential and request ids, each a
valid UUID. A prior-key result is revoked or unconfirmed. Account creation
is true, false, or unknown. Every MFA result carries a valid request id; a
Google MFA result also carries the exact deployment and current native
attempt UUID, with an expiry still in the future, while ordinary MFA also
supports email and phone attempts with the wider attempt id grammar. The
parser admits positive finite times, and Google MFA separately checks the
clock. A result with fields beyond the documented ones is refused, so
native state, code, verifier and key never cross. The rules consume
decoded shape evidence and project a typed result category.

```quint
type ReceiptVariant = AuthenticationMetadata | CodeMetadata | GenericMfaMetadata | GoogleMfaMetadata
type NativeFacts = { shapeValid: bool, exactFields: bool, environmentPresent: bool, environmentMatches: bool, expiresAt: int, resendAt: int, validPriorDisposition: bool, hasAttempt: bool, attemptShapeValid: bool, attemptUuidValid: bool, credentialUuidValid: bool, requestUuidValid: bool, mfaMethodValid: bool }
type NativeReceipt = NativeAccepted | NativeUnavailable | NativeExpired
pure def identityValid(facts: NativeFacts): bool = facts.hasAttempt and facts.attemptUuidValid and facts.credentialUuidValid and facts.requestUuidValid
pure def genericMfaValid(facts: NativeFacts): bool =
  facts.exactFields and (not(facts.environmentPresent) or facts.environmentMatches) and facts.mfaMethodValid and (not(facts.hasAttempt) or facts.attemptShapeValid) and facts.requestUuidValid
pure def admitNativeReceipt(kind: ReceiptVariant, facts: NativeFacts, now: int): NativeReceipt =
  if (not(facts.shapeValid) or facts.expiresAt <= 0) NativeUnavailable
  else if (kind == AuthenticationMetadata) {
    if (facts.exactFields and facts.environmentPresent and facts.environmentMatches and facts.validPriorDisposition and identityValid(facts)) NativeAccepted else NativeUnavailable
  } else if (kind == CodeMetadata) {
    if (facts.hasAttempt and facts.attemptShapeValid and facts.resendAt > 0) NativeAccepted else NativeUnavailable
  } else if (not(genericMfaValid(facts))) NativeUnavailable
  else if (kind == GenericMfaMetadata) NativeAccepted
  else if (not(facts.environmentPresent) or not(facts.environmentMatches) or not(facts.hasAttempt) or not(facts.attemptUuidValid)) NativeUnavailable
  else if (facts.expiresAt <= now) NativeExpired
  else NativeAccepted
pure val factsValues = Set(
  { shapeValid: true, exactFields: true, environmentPresent: true, environmentMatches: true, expiresAt: 10, resendAt: 5, validPriorDisposition: true, hasAttempt: true, attemptShapeValid: true, attemptUuidValid: true, credentialUuidValid: true, requestUuidValid: true, mfaMethodValid: true },
  { shapeValid: true, exactFields: true, environmentPresent: true, environmentMatches: true, expiresAt: 10, resendAt: 5, validPriorDisposition: true, hasAttempt: true, attemptShapeValid: true, attemptUuidValid: true, credentialUuidValid: true, requestUuidValid: false, mfaMethodValid: true },
  { shapeValid: true, exactFields: false, environmentPresent: true, environmentMatches: true, expiresAt: 10, resendAt: 5, validPriorDisposition: true, hasAttempt: true, attemptShapeValid: true, attemptUuidValid: true, credentialUuidValid: true, requestUuidValid: true, mfaMethodValid: true },
  { shapeValid: true, exactFields: true, environmentPresent: true, environmentMatches: false, expiresAt: 10, resendAt: 5, validPriorDisposition: true, hasAttempt: true, attemptShapeValid: true, attemptUuidValid: true, credentialUuidValid: true, requestUuidValid: true, mfaMethodValid: true })
pure val nowValues = Set(0, 9, 10, 11)
pure def lawAuthenticationRequiresCompleteIdentity(facts: NativeFacts, now: int): bool = admitNativeReceipt(AuthenticationMetadata, facts, now) == NativeAccepted implies identityValid(facts)
pure def lawGoogleMfaCannotCrossDeployment(facts: NativeFacts, now: int): bool = admitNativeReceipt(GoogleMfaMetadata, facts, now) == NativeAccepted implies facts.environmentPresent and facts.environmentMatches and facts.expiresAt > now
pure def lawExtraFieldsCannotCrossSecretBoundary(facts: NativeFacts, now: int): bool = not(facts.exactFields) implies admitNativeReceipt(AuthenticationMetadata, facts, now) == NativeUnavailable and admitNativeReceipt(GoogleMfaMetadata, facts, now) == NativeUnavailable
```
