# Shared cloud vocabulary

The words every cloud spec uses: units, keys, secrets, sign-in methods and the
one refusal language. Sources are develop `packages/cloud/shared/src/lib/api/`
(`cloud-worker-errors.ts`, `mobile-client.ts`) and the refusal tables of the
old `spec/cloud/nativeClients.md` and `spec/auth/index.md`. Downstream readers
of the refusal body are the products' cloud gateways and voice clients.

This library has no state. String formats stay in the Effect Schemas
(`src/**/*.schema.ts`): a client idempotency key matches
`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`, and the shell renders keys, codes and
reasons to their snake_case wire names. Sealing and opening secrets is code
only; no spec verifies cryptography.

## Story: Use one vocabulary across the cloud

> As a maintainer of a cloud service, I want one unit for money, time and
> text, and one shape for each key, so that two services never disagree about
> an amount or a request.

### Money is whole micro-dollars, time is epoch milliseconds and text length is UTF-16 code units

One US dollar is 1,000,000 µUSD. A `CharCount` is counted by the shell over
the exact UTF-16 code units of a string, as `spec/core/unicode.md` models
them. Wire encodings in seconds or ISO-8601 are converted at the boundary.

```quint
type Micros = int
type Millis = int
type CharCount = int
pure val microsPerUsd: Micros = 1000000
pure val microsPerCent: Micros = 10000
pure val millisPerSecond: Millis = 1000
pure val millisPerMinute: Millis = 60000
pure val millisPerHour: Millis = 3600000
pure val millisPerDay: Millis = 86400000
```

### Whole cents convert to micro-dollars and back without loss

Plan prices are kept in µUSD and read on the wire as `amountCents`.

```quint
pure def microsOfCents(cents: int): Micros = cents * microsPerCent
pure def centsOf(amount: Micros): int = amount / microsPerCent
pure def lawCentsRoundTrip(cents: int): bool = centsOf(microsOfCents(cents)) == cents
```

### A hold is keyed by its service, request and part, and a provider call by its kind and id

Keys are records compared by structure; the shell renders them. A speech
session holds one key per window and direction; inference and maps hold one
`Whole` key per request. The maps request id is the calling credential and its
`Idempotency-Key` together, so two credentials never share a hold.

```quint
type MeteredService = MeteredInference | MeteredSpeech | MeteredMaps
type SpeechDirection = Stt | Tts
type HoldPart = Whole | Window({ direction: SpeechDirection, window: int })
type HoldKey = { service: MeteredService, requestId: str, part: HoldPart }
type ProviderKind = Checkout | Subscription | Schedule | GmailOperation | CalendarEvent | GoogleGrant
type ProviderKey = { kind: ProviderKind, id: str }
```

### A person signs in by email, phone or Google, and a request carries a device key or a session

```quint
type SignInMethod = Email | Phone | Google
type CredentialKind = DeviceKey | Session
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
with the purpose it was sealed for and the id of the key that sealed it. The
shell opens it only for that purpose.

```quint
type SealPurpose = DeviceKeyCopy | GoogleTokens | TotpSeed
type Sealed = { purpose: SealPurpose, keyId: int }
```

## Story: Speak one refusal language

> As the developer of a client of the cloud, I want every refusal to carry a
> stable code, a status, whether trying again can help and, where it matters,
> why and when, so that my client retries only what can succeed and tells
> the person what to do.

Every refusal is answered as `{error, errorDescription, retryable, retryAt?,
reason?}` with the status of its code. No spec refuses with a code outside
this list.

### Every refusal code has exactly one HTTP status

```quint
type RefusalCode =
  InvalidRequest | ModelUnavailable | InvalidClient | RedirectMismatch | GrantCodeInvalid
  | AuthenticationRequired | CredentialProofInvalid
  | InsufficientCredits | AllowanceExhausted
  | AccessDenied | ClientDisabled | SpeechConsentRequired
  | NotFound | CapabilityUnavailable
  | IdempotencyConflict | StaleRevision | BillingStateConflict | IdentityInUse | LastMethod | GoogleReauthRequired | SubscriptionGrantAlreadyRedeemed | SubscriptionGrantPaidPlanActive | ReferralAlreadyApplied
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
  else if (Set(IdempotencyConflict, StaleRevision, BillingStateConflict, IdentityInUse, LastMethod, GoogleReauthRequired, SubscriptionGrantAlreadyRedeemed, SubscriptionGrantPaidPlanActive, ReferralAlreadyApplied).contains(code)) 409
  else if (code == SessionClosed) 410
  else if (code == PreconditionFailed) 412
  else if (code == ContentTooLarge) 413
  else if (Set(NoRoute, UnsupportedMode, UnsupportedRegion).contains(code)) 422
  else if (code == FreshSessionRequired) 428
  else if (code == RateLimited) 429
  else if (code == ProviderInvalidResponse) 502
  else 503
```

### Only a rate limit or an outage is retryable

A client retries a retryable refusal unchanged; any other refusal needs the
person or the request to change first. A spent allowance is not retryable:
it says when it resets.

```quint
pure def isRetryable(code: RefusalCode): bool = Set(RateLimited, ServiceUnavailable, ProviderUnavailable, RateLimitUnavailable).contains(code)
pure def lawRetryableExactlyOnRateLimitOrOutage(code: RefusalCode): bool = isRetryable(code) iff (statusOf(code) == 429 or statusOf(code) == 503)
```

### A reason refines only the code it belongs to, and an expired, revoked or unknown credential is always named

A refused credential always says which of the three it was, so that the
device's credential owner decides what to keep; the cloud never signs a
device out. A missing credential is unknown.

```quint
type RefusalReason =
  NoReason | GrantRequired | UnsupportedField
  | CredentialExpired | CredentialRevoked | CredentialUnknown
  | ChallengeLocked | GoogleAccountChanged | AccountInactive | CapabilityMissing
  | GoogleNotConfigured
pure def isCredentialReason(reason: RefusalReason): bool = Set(CredentialExpired, CredentialRevoked, CredentialUnknown).contains(reason)
pure def reasonFits(code: RefusalCode, reason: RefusalReason): bool =
  if (code == AuthenticationRequired) isCredentialReason(reason)
  else if (reason == NoReason) true
  else if (code == InvalidRequest) Set(GrantRequired, UnsupportedField).contains(reason)
  else if (code == AccessDenied) Set(ChallengeLocked, GoogleAccountChanged, AccountInactive, CapabilityMissing).contains(reason)
  else if (code == ProviderUnavailable) reason == GoogleNotConfigured
  else false
pure def lawCredentialReasonsAnswerOnly401(code: RefusalCode, reason: RefusalReason): bool = (reasonFits(code, reason) and isCredentialReason(reason)) implies statusOf(code) == 401
```

### A rate limit and a spent allowance always say when, an outage may, and nothing else does

The time is `retryAt` for a rate limit and an outage (`Retry-After` on the
wire), and `resetsAt` for a spent allowance.

```quint
type RetryTime = NoRetryTime | RetryAt({ at: Millis })
pure def hasRetryTime(t: RetryTime): bool = match t { | RetryAt(x) => true | NoRetryTime => false }
pure def retryTimeFits(code: RefusalCode, t: RetryTime): bool =
  if (code == RateLimited or code == AllowanceExhausted) hasRetryTime(t)
  else if (statusOf(code) == 503) true
  else not(hasRetryTime(t))
pure def lawRetryTimeOnlyWhereWaitingHelps(code: RefusalCode, t: RetryTime): bool = (retryTimeFits(code, t) and hasRetryTime(t)) implies (isRetryable(code) or code == AllowanceExhausted)
pure val tValues = Set(NoRetryTime, RetryAt({ at: 0 }), RetryAt({ at: 60000 }))
```

### A refusal is its code, a fitting reason and a fitting retry time

Specs build refusals with these helpers; the status and `retryable` on the
wire come from the code alone.

```quint
type Refusal = { code: RefusalCode, reason: RefusalReason, retryAt: RetryTime }
pure def refuse(code: RefusalCode): Refusal = { code: code, reason: NoReason, retryAt: NoRetryTime }
pure def refuseFor(code: RefusalCode, reason: RefusalReason): Refusal = { code: code, reason: reason, retryAt: NoRetryTime }
pure def refuseUntil(code: RefusalCode, at: Millis): Refusal = { code: code, reason: NoReason, retryAt: RetryAt({ at: at }) }
pure def wellFormed(r: Refusal): bool = reasonFits(r.code, r.reason) and retryTimeFits(r.code, r.retryAt)
pure def lawEveryCodeHasAWellFormedRefusal(code: RefusalCode, at: Millis): bool = wellFormed(refuse(code)) or wellFormed(refuseFor(code, CredentialUnknown)) or wellFormed(refuseUntil(code, at))
```
