# Code sign-in

A person signs in by receiving a one-time code by email or SMS and typing it
back. The code is a [one-time challenge](./challenges.md): each send
publishes a fresh code that replaces the previous one, and a correct verify
consumes it. This machine follows one destination's sign-in; the global send
budget counts the sends of every destination.

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
```

### Each accepted send publishes a fresh code that replaces the previous one

The code is drawn at random by the service, so nothing about one code
predicts the next. A send waits at least the resend interval after the
previous one, and stays
within the destination's hourly limit and the deployment's global limit. A
new code starts a fresh attempt budget.

```quint
import index as I from "./index"
type CodeOutcome = AwaitingCode | SessionIssued | MfaRequired | LockedOut
type CodeSignIn = { now: int, destination: str, sent: int, code: I::SecretCode, codeLive: bool, expiresAt: int, attempts: int, sentAt: int, windowStart: int, windowSends: int, globalSends: int, sessionIssued: bool, mfaIssued: bool, outcome: CodeOutcome }
pure val initial: CodeSignIn = { now: 0, destination: "", sent: 0, code: 0, codeLive: false, expiresAt: 0, attempts: 0, sentAt: 0, windowStart: 0, windowSends: 0, globalSends: 0, sessionIssued: false, mfaIssued: false, outcome: AwaitingCode }
pure val codeLifetime = 600
pure val resendInterval = 60
pure val sendWindow = 3600
pure val maxSendsPerWindow = 5
pure val globalSendLimit = 1000
pure def sendsInWindow(s: CodeSignIn): int = if (s.now - s.windowStart >= sendWindow) 0 else s.windowSends
pure def canSend(s: CodeSignIn, request: SendRequest): bool =
  destinationAccepted(request) and s.outcome == AwaitingCode and (s.destination == "" or s.destination == request.destination)
    and (s.sent == 0 or s.now - s.sentAt >= resendInterval) and sendsInWindow(s) < maxSendsPerWindow and s.globalSends < globalSendLimit
pure def send(s: CodeSignIn, request: SendRequest, issued: I::SecretCode): CodeSignIn = {
  val fresh = s.now - s.windowStart >= sendWindow
  { ...s, destination: request.destination, sent: s.sent + 1, code: issued, codeLive: true, expiresAt: s.now + codeLifetime, attempts: 0, sentAt: s.now,
    windowStart: if (fresh) s.now else s.windowStart, windowSends: if (fresh) 1 else s.windowSends + 1, globalSends: s.globalSends + 1 }
}
pure def canOtherDestinationSends(s: CodeSignIn): bool = s.globalSends < globalSendLimit
pure def otherDestinationSends(s: CodeSignIn): CodeSignIn = { ...s, globalSends: s.globalSends + 1 }
pure def canElapse(s: CodeSignIn, seconds: int): bool = seconds > 0
pure def elapse(s: CodeSignIn, seconds: int): CodeSignIn = { ...s, now: s.now + seconds }
pure val secondsValues = Set(1, 60, 600, 3600)
pure val issuedValues = Set(1, 2, 3)
pure val requestValues = Set(
  { channel: EmailCode, destination: "a@example.org", countryAllowed: true, disposableDomain: false },
  { channel: SmsCode, destination: "+15550100", countryAllowed: true, disposableDomain: false },
  { channel: SmsCode, destination: "+15550100", countryAllowed: false, disposableDomain: false })
pure def stepResendWaitsTheInterval(before: CodeSignIn, via: str, after: CodeSignIn): bool =
  (via == "send" and before.sent > 0) implies after.sentAt - before.sentAt >= resendInterval
pure def alwaysSendsWithinLimits(s: CodeSignIn): bool = s.windowSends <= maxSendsPerWindow and s.globalSends <= globalSendLimit
pure def sometimesCodeResent(s: CodeSignIn): bool = s.sent > 1 and s.codeLive
```

### A code is consumed at most once

A matching verify spends the code, and a spent code never becomes live
again: only a new send makes a code live. A typed code reveals nothing
beyond whether it matches the code issued.

```quint
pure val maxAttempts = 5
pure def declassifyCodeMatches(typed: I::SecretCode, issued: I::SecretCode): bool = typed == issued
pure def canVerify(s: CodeSignIn, code: I::SecretCode, mfaEnrolled: bool): bool =
  s.outcome == AwaitingCode and s.codeLive and s.now < s.expiresAt and s.attempts < maxAttempts
pure def verify(s: CodeSignIn, code: I::SecretCode, mfaEnrolled: bool): CodeSignIn =
  if (declassifyCodeMatches(code, s.code)) { ...s, codeLive: false, sessionIssued: not(mfaEnrolled), mfaIssued: mfaEnrolled, outcome: if (mfaEnrolled) MfaRequired else SessionIssued }
  else { ...s, attempts: s.attempts + 1, codeLive: s.attempts + 1 < maxAttempts, outcome: if (s.attempts + 1 >= maxAttempts) LockedOut else AwaitingCode }
pure val codeValues = Set(1, 2, 3)
pure def stepSpentCodeNeverRevives(before: CodeSignIn, after: CodeSignIn): bool = (after.codeLive and not(before.codeLive)) implies after.sent > before.sent
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
