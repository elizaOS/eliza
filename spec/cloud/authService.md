# Hosted auth service

A deployment runs one hosted `auth` service, the server half of the
[auth package](../auth/), and the cloud mounts it at `/auth`. The mount
forwards sign-in traffic, signs every mutating request it forwards and
attests the client's address; the service trusts an attested address only
when the attestation verifies, and limits sign-in attempts with an atomic
sliding window. There is no second login service and no other mount path.
Sessions, challenges, tenants and accounts are specified in the auth
package; this spec covers the hosted deployment around them. Passkey
sign-in is outside this spec: no rule here admits a passkey, and nothing
relies on one.

## Story: Serve sign-in from one hosted auth service

> As an operator, sign-in for every client of the deployment goes through
> one auth service behind the cloud's `/auth` mount, and a request that
> changes state reaches it only with the cloud's signature.

### Only the login-critical public paths are answered before the full application starts

Reading the sign-in providers and the public tenant configuration, and
the email sign-in steps, are served by the light entry so that sign-in does
not wait for the whole application; every other path goes through the full
application.

```quint
type AuthPath = ProvidersPath | TenantConfigPath | EmailSendPath | EmailCodePath | SessionPath | RefreshPath | NonceExchangePath | TenantAdminPath | OtherAuthPath
type Method = GetMethod | OptionsMethod | PostMethod | PutMethod | PatchMethod | DeleteMethod
pure def mutating(m: Method): bool = m == PostMethod or m == PutMethod or m == PatchMethod or m == DeleteMethod
pure def lightEntry(path: AuthPath, m: Method): bool =
  ((path == ProvidersPath or path == TenantConfigPath) and (m == GetMethod or m == OptionsMethod)) or ((path == EmailSendPath or path == EmailCodePath) and (m == PostMethod or m == OptionsMethod))
pure def lawAdministrationNeedsFullApplication(m: Method): bool = not(lightEntry(TenantAdminPath, m)) and not(lightEntry(SessionPath, m))
```

### A mutating request reaches the auth service only with a fresh signature over its exact request

The mount signs the method, path and query, tenant, the digests of the
credential headers and body, a timestamp, an expiry at most 60 seconds
later and the idempotency key. The service accepts it only if the
signature verifies over those exact fields and it has not expired; a
public read needs no signature.

```quint
type SignedRequest = { method: Method, signatureValid: bool, fieldsExact: bool, issuedAt: int, expiresAt: int }
pure val signatureLifetime = 60000
pure def forwardedRequestAccepted(r: SignedRequest, now: int): bool =
  not(mutating(r.method)) or (r.signatureValid and r.fieldsExact and r.expiresAt > now and r.expiresAt - r.issuedAt <= signatureLifetime and r.issuedAt <= now)
pure val rValues = Set(
  { method: PostMethod, signatureValid: true, fieldsExact: true, issuedAt: 0, expiresAt: 60000 },
  { method: PostMethod, signatureValid: true, fieldsExact: false, issuedAt: 0, expiresAt: 60000 },
  { method: DeleteMethod, signatureValid: true, fieldsExact: true, issuedAt: 0, expiresAt: 120000 },
  { method: GetMethod, signatureValid: false, fieldsExact: false, issuedAt: 0, expiresAt: 0 })
pure val nowValues = Set(0, 59999, 60000)
pure def lawUnsignedMutationRefused(r: SignedRequest, now: int): bool = (mutating(r.method) and not(r.signatureValid)) implies not(forwardedRequestAccepted(r, now))
pure def lawExpiredSignatureRefused(r: SignedRequest, now: int): bool = (mutating(r.method) and r.expiresAt <= now) implies not(forwardedRequestAccepted(r, now))
```

### A forwarded client address is trusted only with a valid, fresh attestation for this request

The mount attests the client's address with an HMAC over a domain tag, the
method, the path and query, an expiry and the address. The service uses
that address only if the address parses, the signature verifies for this
request, and the expiry is neither past nor more than 65 seconds ahead;
otherwise it uses the connecting address. Without a configured secret
nothing forwarded is trusted.

```quint
type IpAttestation = { secretConfigured: bool, addressValid: bool, signatureMatches: bool, expiresAt: int }
pure val attestationHorizon = 65000
pure def trustForwardedAddress(a: IpAttestation, now: int): bool = a.secretConfigured and a.addressValid and a.signatureMatches and a.expiresAt >= now and a.expiresAt <= now + attestationHorizon
pure val aValues = Set(
  { secretConfigured: true, addressValid: true, signatureMatches: true, expiresAt: 60000 },
  { secretConfigured: false, addressValid: true, signatureMatches: true, expiresAt: 60000 },
  { secretConfigured: true, addressValid: true, signatureMatches: false, expiresAt: 60000 },
  { secretConfigured: true, addressValid: true, signatureMatches: true, expiresAt: 200000 })
pure def lawUnverifiedAddressNotTrusted(a: IpAttestation, now: int): bool = not(a.signatureMatches) implies not(trustForwardedAddress(a, now))
pure def lawFarFutureAttestationRefused(a: IpAttestation, now: int): bool = a.expiresAt > now + attestationHorizon implies not(trustForwardedAddress(a, now))
```

### The service answers no sign-in without its deployment's tenant, and no method whose configuration is missing

The service takes its tenant, the mail sender of the
[deployment profile](./deployment.md) and the Google client identifiers
from the deployment, and carries no default for any of them. Without a
tenant it answers no sign-in at all. Email sign-in is answered only with a
configured mail sender, and its mail is sent from that sender only; Google
sign-in, in the browser or from a device's account picker, is answered
only with configured Google clients. A method missing its configuration is
refused as not configured, never served with another deployment's values.

```quint
type SignInMethod = EmailSignIn | GoogleSignIn
type IdentityConfig = { tenant: str, mailSender: str, googleClients: bool }
pure def methodConfigured(config: IdentityConfig, signInMethod: SignInMethod): bool =
  config.tenant != "" and (if (signInMethod == EmailSignIn) config.mailSender != "" else config.googleClients)
pure def mailSentFrom(config: IdentityConfig): str = config.mailSender
pure val configValues = Set(
  { tenant: "tenant-one", mailSender: "sign-in@mail.one", googleClients: true },
  { tenant: "", mailSender: "sign-in@mail.one", googleClients: true },
  { tenant: "tenant-one", mailSender: "", googleClients: true },
  { tenant: "tenant-one", mailSender: "sign-in@mail.one", googleClients: false })
pure def lawNoTenantAnswersNothing(config: IdentityConfig, signInMethod: SignInMethod): bool = config.tenant == "" implies not(methodConfigured(config, signInMethod))
pure def lawEmailNeedsTheConfiguredSender(config: IdentityConfig): bool =
  methodConfigured(config, EmailSignIn) implies (config.mailSender != "" and mailSentFrom(config) == config.mailSender)
pure def lawGoogleNeedsConfiguredClients(config: IdentityConfig): bool = not(config.googleClients) implies not(methodConfigured(config, GoogleSignIn))
```

## Story: Limit sign-in attempts per key

> As an operator, each sign-in key (an address, an email or a phone
> number, per route) is admitted at most a fixed number of times in any
> sliding window, even when attempts arrive at once.

### A sliding window admits at most its limit, atomically, and a refusal records nothing

One atomic step prunes the key's events older than the window, counts the
rest, and records the new attempt only if the count is below the limit:
the limit-th attempt is admitted and the next is refused. A request with
an empty key or a key over 512 characters, or a non-positive window or
limit, is refused as invalid. The model uses a window of three ticks and a
limit of two.

```quint
type RateEvent = { key: str, at: int }
type RateLimits = { now: int, events: List[RateEvent], lastAdmitted: bool }
pure val windowLength = 3
pure val maxRequests = 2
pure val initial: RateLimits = { now: 0, events: List(), lastAdmitted: false }
pure def recent(s: RateLimits, key: str): List[RateEvent] = s.events.select(e => e.key == key and e.at > s.now - windowLength)
pure def requestValid(keyLength: int, window: int, limit: int): bool = keyLength >= 1 and keyLength <= 512 and window > 0 and limit > 0
pure val keyValues = Set("address-1", "email-1")
pure def canAttempt(s: RateLimits, key: str): bool = key != ""
pure def attempt(s: RateLimits, key: str): RateLimits = {
  val pruned = s.events.select(e => e.key != key or e.at > s.now - windowLength)
  val admitted = pruned.select(e => e.key == key).length() < maxRequests
  { ...s, events: if (admitted) pruned.append({ key: key, at: s.now }) else pruned, lastAdmitted: admitted }
}
pure def canTick(s: RateLimits): bool = true
pure def tick(s: RateLimits): RateLimits = { ...s, now: s.now + 1 }
pure def alwaysWindowNeverExceedsLimit(s: RateLimits): bool = s.events.every(e => recent(s, e.key).length() <= maxRequests)
pure def stepRefusalRecordsNothing(before: RateLimits, via: str, after: RateLimits): bool = (via == "attempt" and not(after.lastAdmitted)) implies after.events.length() <= before.events.length()
pure def sometimesAttemptRefused(s: RateLimits): bool = not(s.lastAdmitted) and s.events.length() == maxRequests
pure def sometimesAdmittedAfterWindow(s: RateLimits): bool = s.lastAdmitted and s.now >= windowLength and s.events.length() <= maxRequests
```
