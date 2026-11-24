# Shared cloud vocabulary

The words every cloud spec uses: units, keys, secrets, sign-in methods and the
one refusal language. Sources are develop `packages/cloud/shared/src/lib/api/`
(`cloud-worker-errors.ts`, `mobile-client.ts`) and the refusal tables of the
old `spec/cloud/nativeClients.md` and `spec/auth/index.md`. Downstream readers
of the refusal body are the products' cloud gateways and voice clients.

This library has no state. String formats (such as the client idempotency
key) and the snake_case wire names live in the Effect Schemas
(`src/**/*.schema.ts`); sealing and opening secrets is code only.

## Story: Use one vocabulary across the cloud

> As a maintainer of a cloud service, I want one unit for money, time and
> text, and one shape for each key, so that two services never disagree about
> an amount or a request.

### Money, time and text length each have one unit

Money is whole micro-dollars (one US dollar is 1,000,000 µUSD), time is epoch
milliseconds, and a `CharCount` is the number of UTF-16 code units of a
string, counted by the shell as `spec/core/unicode.md` models them. Wire
encodings in seconds or ISO-8601 are converted at the boundary.

```quint
type Micros = int
type Millis = int
type CharCount = int
pure val microsPerUsd: Micros = 1000000
pure val microsPerCent: Micros = microsPerUsd / 100
pure val millisPerSecond: Millis = 1000
pure val millisPerMinute: Millis = 60000
pure val millisPerHour: Millis = 3600000
pure val millisPerDay: Millis = 86400000
```

### A price is converted to cents only when it is whole cents

Plan prices are kept in µUSD and read on the wire as `amountCents`; `centsOf`
is exact only for whole cents, so a caller states `isWholeCents` of each
amount it converts. Amounts due arrive from the payment provider in cents.

```quint
pure def microsOfCents(cents: int): Micros = cents * microsPerCent
pure def isWholeCents(amount: Micros): bool = amount % microsPerCent == 0
pure def centsOf(amount: Micros): int = amount / microsPerCent
```

### Each metered hold and each provider call has one structural key

Keys are records compared by structure; the shell renders them. The caller
is the calling credential for maps, so two credentials never share a maps
hold, and the organization for inference and speech. A speech session holds
one key per window and direction; inference, batch speech and maps hold one
`WholeRequest` key per request.

```quint
type MeteredService = MeteredInference | MeteredSpeech | MeteredMaps
type SpeechDirection = Transcribe | Synthesize
type HoldPart = WholeRequest | SpeechWindow({ direction: SpeechDirection, window: int })
type HoldKey = { service: MeteredService, caller: str, requestId: str, part: HoldPart }
type ProviderKind = CheckoutSession | SubscriptionUpdate | SubscriptionSchedule | GmailOperation | CalendarEvent | GoogleGrant
type ProviderKey = { providerKind: ProviderKind, providerId: str }
```

### A person signs in by one of three methods and calls with one of three credentials

A spec that accepts only some methods, such as code sign-in by email or
phone, guards `SignInMethod` rather than declaring its own.

```quint
type SignInMethod = EmailSignIn | PhoneSignIn | GoogleSignIn
type CredentialKind = DeviceKeyCredential | SessionCredential | LeaseCredential
type IdempotencyKey = str
```

## Story: Keep secrets out of every answer

> As an account owner, I want my codes, tokens and keys kept out of logs,
> receipts and any answer that does not hand them to me, so that nobody who
> reads those can act as me.

### Codes, tokens, device keys, verifiers and provider tokens are secret

A value of these types may reach only another secret place; `model` refuses
any spec that lets one reach a public field. The one answer that hands a
device key or a token to its owner declassifies it in the spec that mints it.

```quint
type SecretCode = str
type SecretToken = str
type SecretDeviceKey = str
type SecretVerifier = str
type SecretProviderToken = str
```

### A sealed value names its purpose and its key and nothing of its plaintext

A sealed copy of a device key, a Google token pair or a TOTP seed is stored
with the purpose it was sealed for and the id of the key that sealed it.

```quint
type SealPurpose = DeviceKeyCopy | GoogleTokens | TotpSeed
type Sealed = { purpose: SealPurpose, keyId: int }
```

## Story: Speak one refusal language

> As the developer of a client of the cloud, I want every refusal to carry a
> stable code, a status, whether trying again can help and, where it matters,
> why and when, so that my client retries only what can succeed and tells
> the person what to do.

Every refusal is answered with the status of its code and the body
`{error, errorDescription, retryable, retryAt?, resetsAt?, reason?}`, both
times in epoch milliseconds. No spec refuses with a code outside this list,
and a spec that builds a refusal states that it is `wellFormed`.

### Each refusal code answers with the HTTP status of its class

```quint
type RefusalCode =
  InvalidRequest | ModelUnavailable | InvalidClient | RedirectMismatch | GrantCodeInvalid
  | AuthenticationRequired | CredentialProofInvalid
  | InsufficientCredits | AllowanceExhausted
  | AccessDenied | ClientDisabled | SpeechConsentRequired
  | NotFound | CapabilityUnavailable
  | IdempotencyConflict | AlreadyDispatched | StaleRevision | BillingStateConflict | IdentityInUse | LastMethod | GoogleReauthRequired | SubscriptionGrantAlreadyRedeemed | SubscriptionGrantPaidPlanActive | ReferralAlreadyApplied | RenewalWindowClosed
  | SessionClosed | PreconditionFailed | ContentTooLarge
  | NoRoute | UnsupportedMode | UnsupportedRegion
  | FreshSessionRequired | RateLimited | ProviderInvalidResponse
  | ServiceUnavailable | ProviderUnavailable | RateLimitUnavailable
pure def statusOf(code: RefusalCode): int =
  if (Set(InvalidRequest, ModelUnavailable, InvalidClient, RedirectMismatch, GrantCodeInvalid).contains(code)) 400
  else if (Set(AuthenticationRequired, CredentialProofInvalid).contains(code)) 401
  else if (Set(InsufficientCredits, AllowanceExhausted).contains(code)) 402
  else if (Set(AccessDenied, ClientDisabled, SpeechConsentRequired).contains(code)) 403
  else if (Set(NotFound, CapabilityUnavailable).contains(code)) 404
  else if (Set(IdempotencyConflict, AlreadyDispatched, StaleRevision, BillingStateConflict, IdentityInUse, LastMethod, GoogleReauthRequired, SubscriptionGrantAlreadyRedeemed, SubscriptionGrantPaidPlanActive, ReferralAlreadyApplied, RenewalWindowClosed).contains(code)) 409
  else if (code == SessionClosed) 410
  else if (code == PreconditionFailed) 412
  else if (code == ContentTooLarge) 413
  else if (Set(NoRoute, UnsupportedMode, UnsupportedRegion).contains(code)) 422
  else if (code == FreshSessionRequired) 428
  else if (code == RateLimited) 429
  else if (code == ProviderInvalidResponse) 502
  else if (Set(ServiceUnavailable, ProviderUnavailable, RateLimitUnavailable).contains(code)) 503
  else 500
pure def lawEveryCodeHasAClassStatus(code: RefusalCode): bool = statusOf(code) != 500
```

### A reason refines only the code it belongs to

`authentication_required` always carries a credential reason; a missing or
malformed bearer is `credential_unknown`. `account_inactive` answers an action
on an account that is not Active (the operator adding credits, a redeem).
`device_key_not_allowed` answers a device key on a mail or calendar route,
which only a session or a device lease may call. `provider_rate_limited` marks
a `rate_limited` that the model provider set, so a caller can tell it from a
limit of Cloud's own.

```quint
type RefusalReason =
  NoReason | GrantRequired | UnsupportedField
  | CredentialExpired | CredentialRevoked | CredentialUnknown
  | ChallengeLocked | GoogleAccountChanged | AccountInactive | CapabilityMissing
  | GoogleNotConfigured | DeviceKeyNotAllowed | ProviderRateLimited
pure def isCredentialReason(reason: RefusalReason): bool = Set(CredentialExpired, CredentialRevoked, CredentialUnknown).contains(reason)
pure def reasonFits(code: RefusalCode, reason: RefusalReason): bool =
  if (code == AuthenticationRequired) isCredentialReason(reason)
  else if (reason == NoReason) true
  else if (code == InvalidRequest) Set(GrantRequired, UnsupportedField).contains(reason)
  else if (code == AccessDenied) Set(ChallengeLocked, GoogleAccountChanged, AccountInactive, CapabilityMissing, DeviceKeyNotAllowed).contains(reason)
  else if (code == ProviderUnavailable) reason == GoogleNotConfigured
  else if (code == RateLimited) reason == ProviderRateLimited
  else false
```

### A refusal names a credential fault exactly when its code is authentication_required

```quint
pure def lawCredentialFaultIffAuthenticationRequired(code: RefusalCode, reason: RefusalReason): bool =
  reasonFits(code, reason) implies (code == AuthenticationRequired iff isCredentialReason(reason))
```

### Only a rate limit or a passing outage is retryable

A client retries a retryable refusal unchanged; any other refusal needs the
person or the request to change first. A spent allowance is not retryable,
and neither is a missing configuration (`google_not_configured`).
`isRetryable` tells whether a code can ever be retried; the wire `retryable`
is `retryableOf` the whole refusal.

```quint
type WaitTime = NoWait | RetryAt({ retryAtMs: Millis }) | ResetsAt({ resetsAtMs: Millis })
type Refusal = { code: RefusalCode, reason: RefusalReason, wait: WaitTime }
pure def isRetryable(code: RefusalCode): bool = statusOf(code) == 429 or statusOf(code) == 503
pure def retryableOf(r: Refusal): bool = isRetryable(r.code) and r.reason != GoogleNotConfigured
```

### A refusal carries a time only where waiting helps

A rate limit always says when to retry and a retryable outage may; a spent
allowance always says when it resets. A refusal that is not retryable never
carries `retryAt`.

```quint
pure def waitFits(r: Refusal): bool = {
  val w = r.wait
  match w {
    | NoWait => r.code != RateLimited and r.code != AllowanceExhausted
    | RetryAt(x) => retryableOf(r)
    | ResetsAt(x) => r.code == AllowanceExhausted
  }
}
```

### A refusal is well formed when its reason and its time fit it

```quint
pure def wellFormed(r: Refusal): bool = reasonFits(r.code, r.reason) and waitFits(r)
pure def refuse(code: RefusalCode): Refusal = { code: code, reason: NoReason, wait: NoWait }
pure def refuseFor(code: RefusalCode, reason: RefusalReason): Refusal = { code: code, reason: reason, wait: NoWait }
pure def refuseUntil(code: RefusalCode, at: Millis): Refusal = { code: code, reason: NoReason, wait: RetryAt({ retryAtMs: at }) }
pure def refuseAllowance(resetsAt: Millis): Refusal = { code: AllowanceExhausted, reason: NoReason, wait: ResetsAt({ resetsAtMs: resetsAt }) }
```

### Retry-After never sends a client back before its retry time

An answer with `retryAt` also sets `Retry-After` to the whole seconds from
now to that time, rounded up, and at least one second.

```quint
pure def retryAfterSeconds(at: Millis, now: Millis): int = if (at <= now) 1 else (at - now + millisPerSecond - 1) / millisPerSecond
pure def lawRetryAfterIsNotEarly(at: Millis, now: Millis): bool = now + retryAfterSeconds(at, now) * millisPerSecond >= at
```
