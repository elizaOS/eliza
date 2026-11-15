# Code sign-in

A person signs in by receiving a one-time code by email or SMS and typing it
back. The code is a [one-time challenge](./challenges.md): each send
publishes a fresh code that replaces the previous one, and a correct verify
consumes it. This machine follows one destination's sign-in; the global send
budget counts the sends of every destination. Times are in seconds.

Ported from the email and SMS routes of develop `packages/auth/src/server`
(`routes/auth.ts`, `auth/token-store.ts`) on the publication pattern of
`quint/AuthStorePublication.qnt`. The secondary sign-in methods of develop
(wallet signatures, magic links, social and enterprise providers, guest) are
not part of Eliza.

## Story: Sign in with an email or SMS code

> As a person, I want to sign in with a code sent to my email or phone, so
> that I need no password, while nobody can guess, replay or flood codes.

### A send is refused without sending when the request has no destination or names a refused one

SMS goes only to country codes the deployment allows, and email never to a
disposable-address domain.

```quint
type CodeChannel = EmailCode | SmsCode
type SendRequest = { channel: CodeChannel, destination: str, countryAllowed: bool, disposableDomain: bool }
pure def destinationAccepted(r: SendRequest): bool =
  r.destination != "" and (r.channel == SmsCode implies r.countryAllowed) and (r.channel == EmailCode implies not(r.disposableDomain))
pure def lawSmsOnlyToAllowedCountries(r: SendRequest): bool = (r.channel == SmsCode and not(r.countryAllowed)) implies not(destinationAccepted(r))
pure def lawNoCodeToDisposableEmail(r: SendRequest): bool = (r.channel == EmailCode and r.disposableDomain) implies not(destinationAccepted(r))
pure def lawEmptyDestinationRefused(r: SendRequest): bool = r.destination == "" implies not(destinationAccepted(r))
pure val rValues = Set(
  { channel: EmailCode, destination: "a@example.org", countryAllowed: true, disposableDomain: false },
  { channel: EmailCode, destination: "a@example.org", countryAllowed: true, disposableDomain: true },
  { channel: SmsCode, destination: "+15550100", countryAllowed: false, disposableDomain: false },
  { channel: SmsCode, destination: "", countryAllowed: true, disposableDomain: false })
```

### Each accepted send publishes a fresh code that replaces the previous one

A send waits at least the resend interval after the previous one, and stays
within the destination's hourly limit and the deployment's global limit. A
new code starts a fresh attempt budget.

```quint
type CodeOutcome = AwaitingCode | SessionIssued | MfaRequired | LockedOut
type CodeSignIn = { now: int, destination: str, code: int, codeLive: bool, expiresAt: int, attempts: int, sentAt: int, windowStart: int, windowSends: int, globalSends: int, consumedCodes: Set[int], sessionIssued: bool, mfaIssued: bool, outcome: CodeOutcome }
pure val initial: CodeSignIn = { now: 0, destination: "", code: 0, codeLive: false, expiresAt: 0, attempts: 0, sentAt: 0, windowStart: 0, windowSends: 0, globalSends: 0, consumedCodes: Set(), sessionIssued: false, mfaIssued: false, outcome: AwaitingCode }
pure val codeLifetime = 600
pure val resendInterval = 60
pure val sendWindow = 3600
pure val maxSendsPerWindow = 5
pure val globalSendLimit = 1000
pure def sendsInWindow(s: CodeSignIn): int = if (s.now - s.windowStart >= sendWindow) 0 else s.windowSends
pure def canSend(s: CodeSignIn, request: SendRequest): bool =
  destinationAccepted(request) and s.outcome == AwaitingCode and (s.destination == "" or s.destination == request.destination)
    and (s.code == 0 or s.now - s.sentAt >= resendInterval) and sendsInWindow(s) < maxSendsPerWindow and s.globalSends < globalSendLimit
pure def send(s: CodeSignIn, request: SendRequest): CodeSignIn = {
  val fresh = s.now - s.windowStart >= sendWindow
  { ...s, destination: request.destination, code: s.code + 1, codeLive: true, expiresAt: s.now + codeLifetime, attempts: 0, sentAt: s.now,
    windowStart: if (fresh) s.now else s.windowStart, windowSends: if (fresh) 1 else s.windowSends + 1, globalSends: s.globalSends + 1 }
}
pure def canOtherDestinationSends(s: CodeSignIn): bool = s.globalSends < globalSendLimit
pure def otherDestinationSends(s: CodeSignIn): CodeSignIn = { ...s, globalSends: s.globalSends + 1 }
pure def canElapse(s: CodeSignIn, seconds: int): bool = seconds > 0
pure def elapse(s: CodeSignIn, seconds: int): CodeSignIn = { ...s, now: s.now + seconds }
pure val secondsValues = Set(1, 60, 600, 3600)
pure val requestValues = Set(
  { channel: EmailCode, destination: "a@example.org", countryAllowed: true, disposableDomain: false },
  { channel: SmsCode, destination: "+15550100", countryAllowed: true, disposableDomain: false },
  { channel: SmsCode, destination: "+15550100", countryAllowed: false, disposableDomain: false })
pure def stepResendWaitsTheInterval(before: CodeSignIn, via: str, after: CodeSignIn): bool =
  (via == "send" and before.code > 0) implies after.sentAt - before.sentAt >= resendInterval
pure def alwaysSendsWithinLimits(s: CodeSignIn): bool = s.windowSends <= maxSendsPerWindow and s.globalSends <= globalSendLimit
pure def sometimesCodeResent(s: CodeSignIn): bool = s.code > 1 and s.codeLive
```

### A code is consumed at most once

```quint
pure val maxAttempts = 5
pure def canVerify(s: CodeSignIn, code: int, mfaEnrolled: bool): bool =
  s.outcome == AwaitingCode and s.codeLive and s.now < s.expiresAt and s.attempts < maxAttempts
pure def verify(s: CodeSignIn, code: int, mfaEnrolled: bool): CodeSignIn =
  if (code == s.code) { ...s, codeLive: false, consumedCodes: s.consumedCodes.union(Set(code)), sessionIssued: not(mfaEnrolled), mfaIssued: mfaEnrolled, outcome: if (mfaEnrolled) MfaRequired else SessionIssued }
  else { ...s, attempts: s.attempts + 1, codeLive: s.attempts + 1 < maxAttempts, outcome: if (s.attempts + 1 >= maxAttempts) LockedOut else AwaitingCode }
pure val codeValues = Set(1, 2, 3)
pure def alwaysLiveCodeNotConsumed(s: CodeSignIn): bool = s.codeLive implies not(s.consumedCodes.contains(s.code))
pure def alwaysConsumedOnlyIssuedCodes(s: CodeSignIn): bool = s.consumedCodes.forall(c => c >= 1 and c <= s.code) and s.consumedCodes.size() <= 1
pure def sometimesSignedInWithCode(s: CodeSignIn): bool = s.outcome == SessionIssued
```

### Verification attempts are bounded, and an exhausted code refuses even the right code

```quint
pure def alwaysAttemptsBounded(s: CodeSignIn): bool = s.attempts >= 0 and s.attempts <= maxAttempts and (s.attempts == maxAttempts implies (not(s.codeLive) and s.outcome == LockedOut))
pure def sometimesLockedOut(s: CodeSignIn): bool = s.outcome == LockedOut
```

### A successful verify yields either a session or an MFA challenge, never both

```quint
pure def alwaysSessionOrMfaNeverBoth(s: CodeSignIn): bool =
  not(s.sessionIssued and s.mfaIssued) and (s.sessionIssued iff s.outcome == SessionIssued) and (s.mfaIssued iff s.outcome == MfaRequired)
pure def sometimesMfaRequired(s: CodeSignIn): bool = s.outcome == MfaRequired
```
