# Sign-in readiness

Which sign-in methods the native sign-in screen may offer, how long the
device trusts the cloud's answer, and the public service document. This
library holds no state: the `ElizaSignIn` plugin keeps one `Answer` per
registered environment (in memory and in plain preferences: it holds no
secret), asks `onStatus`, `onLoad` and `onResume` whether to measure,
folds each probe into it with `measureAnswer`, and tells the renderer
`signInReadinessChanged` when `announces` says so. The sign-in flow
(`spec/os/signIn/flow.md`) starts only a method `offered` names.

One probe reads the cloud's native client configuration
(`GET /api/v1/app-auth/mobile/config` for this client id, environment and
redirect: `google {configured, serverClientId, nativeSignIn}`) and its
offered methods (`GET /api/v1/auth/methods`: `{email, sms, google}`), so
email and SMS share it. The shell turns the probe into a `CloudReading`: a
refusal of this client (`invalid_client`, `client_disabled`,
`redirect_mismatch`) is `ClientUnregistered`; a read with no usable answer
(no connection, a timeout, a 5xx, a 408 or a 429) makes the whole probe
`NoReading`. Android's own facts (the host's Google mode, the App Link
verification, an external browser that is not the host or the WebView
shell) are read when an answer is shown, never cached. Times are epoch
milliseconds.

## Story: Show only the methods the cloud is ready for

> As a person opening sign-in, I want to see at once the methods that work
> on this device, never a method that would fail and never a hosted sign-in
> page, without the app polling the cloud while I am not signing in.

### The screen offers only an email code, an SMS code or Google in the host's mode, and only as the answer names them

There is no hosted sign-in page among the methods. Email and SMS are offered
when the cloud's answer offers them. Google uses the account picker unless
the host selects the browser, and is offered only in that mode: the picker
needs the cloud's Google, its native sign-in and a configured server client
id; the browser needs the cloud's Google, Android's verified App Link and an
external browser. A probe that has not answered, or an unknown answer,
offers nothing.

```quint
type GoogleMode = Picker | Browser
type SignInMethod = EmailCode | SmsCode | Google({ mode: GoogleMode })
type CloudMethods = { email: bool, sms: bool, google: bool, nativeSignIn: bool, serverClientId: bool }
type Readiness = NotMeasured | ReadinessUnknown | Known(CloudMethods)
type DeviceFacts = { googleMode: GoogleMode, appLinkVerified: bool, externalBrowser: bool }
pure def offered(readiness: Readiness, device: DeviceFacts, method: SignInMethod): bool = match readiness {
  | Known(m) => match method {
    | EmailCode => m.email
    | SmsCode => m.sms
    | Google(g) => g.mode == device.googleMode and m.google
        and (if (g.mode == Picker) m.nativeSignIn and m.serverClientId else device.appLinkVerified and device.externalBrowser)
  }
  | _ => false
}
pure val readinessValues = Set(NotMeasured, ReadinessUnknown,
  Known({ email: true, sms: true, google: true, nativeSignIn: true, serverClientId: true }),
  Known({ email: false, sms: false, google: false, nativeSignIn: false, serverClientId: false }),
  Known({ email: true, sms: false, google: true, nativeSignIn: true, serverClientId: false }))
pure val deviceValues = Set(
  { googleMode: Picker, appLinkVerified: false, externalBrowser: false },
  { googleMode: Browser, appLinkVerified: true, externalBrowser: true },
  { googleMode: Browser, appLinkVerified: true, externalBrowser: false }
)
pure def lawOneGoogleButtonAtMost(readiness: Readiness, device: DeviceFacts): bool =
  not(offered(readiness, device, Google({ mode: Picker })) and offered(readiness, device, Google({ mode: Browser })))
```

### A fresh cached answer is served at once

A status request is answered from a fresh cached answer without waiting.
It waits for a probe only when nothing fresh is cached, or when the screen
explicitly retries an answer that is not complete. A cached answer more
than six hours in the future is not trusted. An answer is complete when
every method the host can use is ready; only then is nothing left to
measure.

```quint
type Answer = { readiness: Readiness, until: int, recheckAt: int, passiveAt: int, unchanged: int }
type StatusPlan = { serveNow: bool, measure: bool }
pure val readyTtlMs = 21600000
pure val notReadyTtlMs = 600000
pure val noAnswer: Answer = { readiness: NotMeasured, until: 0, recheckAt: 0, passiveAt: 0, unchanged: 0 }
pure def answerFresh(cached: Answer, now: int): bool = now < cached.until and cached.until - now <= readyTtlMs
pure def readinessComplete(readiness: Readiness, googleMode: GoogleMode): bool = match readiness {
  | Known(m) => m.email and m.sms and m.google and (googleMode == Browser or (m.nativeSignIn and m.serverClientId))
  | _ => false
}
pure def onStatus(cached: Answer, googleMode: GoogleMode, now: int, retry: bool): StatusPlan = {
  val served = answerFresh(cached, now) and (readinessComplete(cached.readiness, googleMode) or not(retry))
  { serveNow: served, measure: not(served) or recheckDue(cached, googleMode, now) }
}
pure val nowValues = Set(0, 29999, 30000, 600000, 21600000)
pure val cachedValues = Set(
  noAnswer,
  { readiness: Known({ email: true, sms: false, google: true, nativeSignIn: true, serverClientId: false }), until: 21600000, recheckAt: 30000, passiveAt: 120000, unchanged: 1 },
  { readiness: Known({ email: true, sms: true, google: true, nativeSignIn: true, serverClientId: true }), until: 21600000, recheckAt: 21600000, passiveAt: 21600000, unchanged: 0 },
  { readiness: ReadinessUnknown, until: 600000, recheckAt: 30000, passiveAt: 30000, unchanged: 0 },
  { readiness: Known({ email: false, sms: false, google: false, nativeSignIn: false, serverClientId: false }), until: 50000000, recheckAt: 30000, passiveAt: 30000, unchanged: 0 }
)
pure def lawFreshAnswerServedAtOnce(cached: Answer, googleMode: GoogleMode, now: int): bool =
  answerFresh(cached, now) implies onStatus(cached, googleMode, now, false).serveNow
pure def lawNothingFreshWaitsForAProbe(cached: Answer, googleMode: GoogleMode, now: int, retry: bool): bool =
  not(answerFresh(cached, now)) implies (onStatus(cached, googleMode, now, retry).measure and not(onStatus(cached, googleMode, now, retry).serveNow))
```

### An answer that is not complete is measured again behind it after 30 seconds

When a screen asks and a method is still not ready 30 seconds after the
last measurement, the probe runs behind the answer just served. A complete
fresh answer is not measured again before it expires. A recheck time more
than 30 seconds in the future is not trusted.

```quint
pure val recheckMs = 30000
pure def recheckDue(cached: Answer, googleMode: GoogleMode, now: int): bool =
  not(readinessComplete(cached.readiness, googleMode)) and (now >= cached.recheckAt or cached.recheckAt - now > recheckMs)
pure def lawNotReadyMeasuredBehindAnswer(cached: Answer, googleMode: GoogleMode, now: int): bool = {
  val plan = onStatus(cached, googleMode, now, false)
  (answerFresh(cached, now) and recheckDue(cached, googleMode, now)) implies (plan.serveNow and plan.measure)
}
pure def lawCompleteAnswerNotMeasured(cached: Answer, googleMode: GoogleMode, now: int, retry: bool): bool =
  (answerFresh(cached, now) and readinessComplete(cached.readiness, googleMode)) implies not(onStatus(cached, googleMode, now, retry).measure)
```

### Load and resume measure only on a growing wait, and a resume only for a recent screen or an attempt

When the plugin loads it warms the cache. A later resume measures only
while a sign-in screen asked for status within the last ten minutes or an
attempt is in progress, so a launcher resumed all day sends nothing. A
measurement nobody asked for waits 30 seconds, then 2 minutes, 10 minutes
and hourly while the same answer that is not complete comes back, never
past the answer's expiry; a wait more than an hour in the future is not
trusted.

```quint
pure val passiveWaitsMs = List(30000, 120000, 600000, 3600000)
pure val resumeWindowMs = 600000
pure def passiveWait(unchanged: int): int = passiveWaitsMs.nthOr(unchanged, 3600000)
pure def passiveDue(cached: Answer, googleMode: GoogleMode, now: int): bool =
  not(readinessComplete(cached.readiness, googleMode)) and (now >= cached.passiveAt or cached.passiveAt - now > 3600000)
pure def onLoad(cached: Answer, googleMode: GoogleMode, now: int): bool =
  not(answerFresh(cached, now)) or passiveDue(cached, googleMode, now)
pure def onResume(cached: Answer, googleMode: GoogleMode, now: int, statusAskedAt: int, attemptActive: bool): bool =
  (attemptActive or (statusAskedAt > 0 and statusAskedAt <= now and now - statusAskedAt < resumeWindowMs))
    and onLoad(cached, googleMode, now)
```

### A method is marked not ready only by an answer that says so

A probe with no reading keeps a fresh answer's methods and expiry and only
puts off the next measurement; without a fresh answer it records that
readiness is unknown for ten minutes. A refusal of this client is an answer
that no method is ready. A ready answer lives six hours, one with no ready
method ten minutes.

```quint
type CloudReading = NoReading | ClientUnregistered | MethodsRead(CloudMethods)
pure def earlier(a: int, b: int): int = if (a < b) a else b
pure def later(a: int, b: int): int = if (a < b) b else a
pure def anyReady(readiness: Readiness): bool = match readiness {
  | Known(m) => m.email or m.sms or m.google
  | _ => false
}
pure def answerOf(readiness: Readiness, until: int, recheckAt: int, passiveAt: int, unchanged: int, googleMode: GoogleMode): Answer = {
  val complete = readinessComplete(readiness, googleMode)
  val recheck = if (complete) until else earlier(until, recheckAt)
  { readiness: readiness, until: until, recheckAt: recheck,
    passiveAt: if (complete) until else earlier(until, later(recheck, passiveAt)),
    unchanged: later(0, earlier(unchanged, 4)) }
}
pure def measureAnswer(cached: Answer, reading: CloudReading, googleMode: GoogleMode, now: int): Answer = {
  val readiness = match reading {
    | MethodsRead(m) => Known({ email: m.email, sms: m.sms, google: m.google, nativeSignIn: m.nativeSignIn, serverClientId: m.serverClientId })
    | ClientUnregistered => Known({ email: false, sms: false, google: false, nativeSignIn: false, serverClientId: false })
    | NoReading => ReadinessUnknown
  }
  val repeated = not(readinessComplete(readiness, googleMode)) and readiness == cached.readiness
  val count = if (repeated) cached.unchanged + 1 else 0
  if (reading == NoReading and answerFresh(cached, now))
    answerOf(cached.readiness, cached.until, now + recheckMs, now + passiveWait(cached.unchanged + 1), cached.unchanged + 1, googleMode)
  else if (reading == NoReading)
    answerOf(ReadinessUnknown, now + notReadyTtlMs, now + recheckMs, now + recheckMs, 0, googleMode)
  else
    answerOf(readiness, now + (if (anyReady(readiness)) readyTtlMs else notReadyTtlMs), now + recheckMs, now + passiveWait(count), count, googleMode)
}
pure val readingValues = Set(NoReading, ClientUnregistered,
  MethodsRead({ email: true, sms: true, google: true, nativeSignIn: true, serverClientId: true }),
  MethodsRead({ email: true, sms: false, google: true, nativeSignIn: true, serverClientId: false }),
  MethodsRead({ email: false, sms: false, google: false, nativeSignIn: false, serverClientId: false }))
pure def lawNoReadingKeepsFreshAnswer(cached: Answer, googleMode: GoogleMode, now: int): bool = {
  val after = measureAnswer(cached, NoReading, googleMode, now)
  answerFresh(cached, now) implies (after.readiness == cached.readiness and after.until == cached.until)
}
pure def lawNoReadingNeverOffersMore(cached: Answer, device: DeviceFacts, method: SignInMethod, now: int): bool =
  offered(measureAnswer(cached, NoReading, device.googleMode, now).readiness, device, method) implies offered(cached.readiness, device, method)
pure def lawReadyAnswerLivesSixHours(cached: Answer, reading: CloudReading, googleMode: GoogleMode, now: int): bool = {
  val after = measureAnswer(cached, reading, googleMode, now)
  (reading != NoReading and anyReady(after.readiness)) implies (answerFresh(after, now + readyTtlMs - 1) and not(answerFresh(after, now + readyTtlMs)))
}
pure def lawNotCompleteRecheckedWithinThirtySeconds(cached: Answer, reading: CloudReading, googleMode: GoogleMode, now: int): bool = {
  val after = measureAnswer(cached, reading, googleMode, now)
  not(readinessComplete(after.readiness, googleMode)) implies recheckDue(after, googleMode, now + recheckMs)
}
pure def lawPassiveWaitNeverBeforeRecheck(cached: Answer, reading: CloudReading, googleMode: GoogleMode, now: int): bool = {
  val after = measureAnswer(cached, reading, googleMode, now)
  after.recheckAt <= after.passiveAt and after.passiveAt <= after.until
}
pure val methodValues = Set(EmailCode, SmsCode, Google({ mode: Picker }), Google({ mode: Browser }))
```

### Only a changed answer is announced, never the first

The renderer is told `signInReadinessChanged` when a measurement changes an
earlier answer; the first answer and an unchanged one are not announced.

```quint
pure def announces(previous: Readiness, measured: Readiness): bool = previous != NotMeasured and previous != measured
pure def lawNoReadingOverFreshAnswerAnnouncesNothing(cached: Answer, googleMode: GoogleMode, now: int): bool =
  answerFresh(cached, now) implies not(announces(cached.readiness, measureAnswer(cached, NoReading, googleMode, now).readiness))
```

## Story: Read the service's own terms

> As a person signing in, I want the service's name, Terms and Privacy
> exactly as the service publishes them, so that I know what I agree to.

### The service document comes only from the registered environment's API origin and is shown as received

The plugin reads `GET /api/public/service` only from the API origin of the
environment the call names, which must be registered. A document that is
not a 200 answer of the expected shape (`{success, version: 1, service:
{name, terms, privacy}}`, checked by the shell) is reported unavailable,
never replaced by a bundled copy or another origin's.

```quint
type ServiceOutcome = ServiceShown | ServiceUnavailable | ServiceUnknownEnvironment
pure def serviceOutcome(registered: bool, status: int, wellFormed: bool): ServiceOutcome =
  if (not(registered)) ServiceUnknownEnvironment
  else if (status == 200 and wellFormed) ServiceShown
  else ServiceUnavailable
```
