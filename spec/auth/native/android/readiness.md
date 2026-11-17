# Android sign-in readiness

The Android sign-in plugin tells the sign-in screen which methods the cloud
is ready for. Email and SMS are measured by one probe; Google is ready only
once Android has verified the browser return link. The model keeps one
deployment, and abstracts the clock into the events that end each wait:
the short time to live of a "not ready" answer, the growing wait for
unasked measurements (30 seconds, 2 minutes, 10 minutes, then hourly) and
the six-hour life of a ready answer.

## Story: Show only the sign-in methods the cloud is ready for

> As a person opening sign-in, I want to see the methods that work right
> away, without waiting on a check, and without the app polling the cloud
> while I am not signing in.

### A fresh cached answer is served at once, and a "not ready" one is measured again behind it

A status request from a sign-in screen gets a fresh cached answer at once.
When a method in it is not ready and its short time to live has ended, a
measurement starts behind the answer. The caller waits only for an
explicit retry of an incomplete answer, or when nothing fresh exists; all
waiting callers join one probe.

```quint
type Readiness = NoAnswer | Unavailable | Partial | Ready
type ReadinessCache = { answer: Readiness, recheckDue: bool, passiveDue: bool, expired: bool,
  probing: bool, waiters: int, probes: int, surface: bool, resumes: int, resumeProbes: int, unaskedResumeProbes: int,
  linkVerified: bool, watching: bool, watchRound: int, watchProbes: int, announcements: int, changes: int,
  servedDueWithoutMeasuring: bool, waitedOnFreshAnswer: bool, lostFreshAnswer: bool, turnedOnUnmeasured: bool }
pure val initial: ReadinessCache = { answer: NoAnswer, recheckDue: false, passiveDue: false, expired: false,
  probing: false, waiters: 0, probes: 0, surface: false, resumes: 0, resumeProbes: 0, unaskedResumeProbes: 0,
  linkVerified: false, watching: false, watchRound: 0, watchProbes: 0, announcements: 0, changes: 0,
  servedDueWithoutMeasuring: false, waitedOnFreshAnswer: false, lostFreshAnswer: false, turnedOnUnmeasured: false }
pure def fresh(c: ReadinessCache): bool = c.answer != NoAnswer and not(c.expired)
pure def incomplete(c: ReadinessCache): bool = c.answer != Ready
pure def askStatus(c: ReadinessCache, refreshNegative: bool): ReadinessCache = {
  val served = fresh(c) and (not(incomplete(c)) or not(refreshNegative))
  val due = incomplete(c) and c.recheckDue
  val measure = not(served) or due
  val starts = measure and not(c.probing)
  { ...c, surface: true, probing: c.probing or measure, probes: c.probes + (if (starts) 1 else 0),
    waiters: c.waiters + (if (served) 0 else 1),
    servedDueWithoutMeasuring: c.servedDueWithoutMeasuring or (served and due and not(c.probing or measure)),
    waitedOnFreshAnswer: c.waitedOnFreshAnswer or (not(served) and fresh(c) and not(refreshNegative)) }
}
pure def canShortTtlEnds(c: ReadinessCache): bool = (c.answer == Partial or c.answer == Unavailable) and not(c.recheckDue)
pure def shortTtlEnds(c: ReadinessCache): ReadinessCache = { ...c, recheckDue: true }
pure def canLongTtlEnds(c: ReadinessCache): bool = c.answer != NoAnswer and not(c.expired)
pure def longTtlEnds(c: ReadinessCache): ReadinessCache = { ...c, expired: true }
pure def alwaysNegativeIsMeasuredAgain(c: ReadinessCache): bool = not(c.servedDueWithoutMeasuring)
pure def alwaysFreshAnswerServedAtOnce(c: ReadinessCache): bool = not(c.waitedOnFreshAnswer)
pure def alwaysCallersJoinOneProbe(c: ReadinessCache): bool = (c.waiters > 0 implies c.probing) and c.waiters >= 0
pure def sometimesMeasuredBehindAnswer(c: ReadinessCache): bool = c.probing and c.waiters == 0 and c.probes >= 2
```

### A method is marked not ready only by an answer that says so

A measurement that got no result keeps a fresh answer, and only without
one does it record that readiness is unavailable. When the probe answered
but Google's own reads got no usable answer (a timeout, a 5xx, a 408 or a
429), Google keeps what a fresh answer said, and is otherwise not ready; it
is never turned on by such a measurement. Google is ready only over a
verified link.

```quint
pure def canMeasured(c: ReadinessCache): bool = c.probing
pure def measured(c: ReadinessCache, failed: bool): ReadinessCache = {
  val kept = failed and fresh(c)
  val result = if (kept) c.answer else if (failed) Unavailable else if (c.linkVerified) Ready else Partial
  val changed = c.answer != NoAnswer and c.answer != result
  { ...c, probing: false, waiters: 0, answer: result, recheckDue: false, passiveDue: false,
    expired: if (kept) c.expired else false,
    changes: c.changes + (if (changed) 1 else 0), announcements: c.announcements + (if (changed) 1 else 0),
    lostFreshAnswer: c.lostFreshAnswer or (failed and fresh(c) and result != c.answer),
    watching: c.watching or (not(failed) and result == Partial),
    watchRound: if (not(c.watching) and not(failed) and result == Partial) 0 else c.watchRound }
}
pure def canMeasuredWithoutGoogle(c: ReadinessCache): bool = c.probing and c.linkVerified
pure def measuredWithoutGoogle(c: ReadinessCache): ReadinessCache = {
  val kept = fresh(c) and c.answer != Unavailable
  val result = if (kept) c.answer else Partial
  val changed = c.answer != NoAnswer and c.answer != result
  { ...c, probing: false, waiters: 0, answer: result, recheckDue: false, passiveDue: false,
    expired: if (kept) c.expired else false,
    changes: c.changes + (if (changed) 1 else 0), announcements: c.announcements + (if (changed) 1 else 0),
    lostFreshAnswer: c.lostFreshAnswer or (kept and result != c.answer),
    turnedOnUnmeasured: c.turnedOnUnmeasured or (result == Ready and c.answer != Ready) }
}
pure def canLinkVerifies(c: ReadinessCache): bool = not(c.linkVerified)
pure def linkVerifies(c: ReadinessCache): ReadinessCache = { ...c, linkVerified: true }
pure def alwaysFailedProbeKeepsFreshAnswer(c: ReadinessCache): bool = not(c.lostFreshAnswer)
pure def alwaysUnansweredMethodNeverTurnsOn(c: ReadinessCache): bool = not(c.turnedOnUnmeasured)
pure def alwaysReadyNeedsVerifiedLink(c: ReadinessCache): bool = c.answer == Ready implies c.linkVerified
pure def sometimesUnavailableAfterFailedProbe(c: ReadinessCache): bool = c.answer == Unavailable
pure def sometimesAllMethodsReady(c: ReadinessCache): bool = c.answer == Ready
```

### A resume measures only for a recent sign-in screen or an attempt in progress

On load the plugin warms the cache once. A later resume measures only when
a sign-in screen asked for status within the last ten minutes or an attempt
is in progress, and only once the growing wait has ended; that wait never
ends before the short time to live.

```quint
pure def resume(c: ReadinessCache, first: bool): ReadinessCache = {
  val warmUp = first and c.resumes == 0
  val allowed = warmUp or c.surface
  val due = not(fresh(c)) or (incomplete(c) and c.passiveDue)
  val starts = allowed and due and not(c.probing)
  { ...c, resumes: c.resumes + 1, probing: c.probing or (allowed and due), probes: c.probes + (if (starts) 1 else 0),
    resumeProbes: c.resumeProbes + (if (starts) 1 else 0),
    unaskedResumeProbes: c.unaskedResumeProbes + (if (starts and not(warmUp) and not(c.surface)) 1 else 0) }
}
pure def canPassiveWaitEnds(c: ReadinessCache): bool = c.recheckDue and not(c.passiveDue)
pure def passiveWaitEnds(c: ReadinessCache): ReadinessCache = { ...c, passiveDue: true }
pure def canSurfaceGoesQuiet(c: ReadinessCache): bool = c.surface
pure def surfaceGoesQuiet(c: ReadinessCache): ReadinessCache = { ...c, surface: false }
pure def alwaysResumeProbesOnlyWhenAsked(c: ReadinessCache): bool = c.unaskedResumeProbes == 0 and c.resumeProbes <= c.resumes
pure def alwaysPassiveWaitFollowsShortTtl(c: ReadinessCache): bool = c.passiveDue implies c.recheckDue
pure def sometimesResumeMeasured(c: ReadinessCache): bool = c.resumeProbes >= 2
```

### An unverified return link is watched with bounded local checks

While Android has not verified the browser return link, the plugin checks
it locally for at most six rounds and sends nothing. Once it is verified,
readiness is measured once and the watch ends.

```quint
pure val watchRounds = 6
pure def canWatchTick(c: ReadinessCache): bool = c.watching
pure def watchTick(c: ReadinessCache): ReadinessCache =
  if (c.watchRound >= watchRounds) { ...c, watching: false }
  else if (not(c.linkVerified)) { ...c, watchRound: c.watchRound + 1 }
  else if (c.probing) { ...c, watching: false }
  else { ...c, watching: false, probing: true, probes: c.probes + 1, watchProbes: c.watchProbes + 1 }
pure def alwaysWatchBounded(c: ReadinessCache): bool = c.watchRound >= 0 and c.watchRound <= watchRounds
pure def alwaysWatchSendsNothingUnverified(c: ReadinessCache): bool = c.watchProbes > 0 implies c.linkVerified
pure def sometimesWatchMeasuredVerifiedLink(c: ReadinessCache): bool = c.watchProbes > 0
```

### Only a changed answer is announced, and never the first one

The plugin announces `signInReadinessChanged` when a measurement changes an
earlier answer; the first answer and an unchanged one are not announced.
Each measurement announces at most once, so a probe still running has not
announced yet.

```quint
pure def alwaysAnnouncedOnlyChanges(c: ReadinessCache): bool = c.announcements == c.changes and c.announcements <= c.probes
pure def alwaysRunningProbeNotYetAnnounced(c: ReadinessCache): bool = c.announcements + (if (c.probing) 1 else 0) <= c.probes
pure def sometimesChangeAnnounced(c: ReadinessCache): bool = c.announcements > 0
```

### The sign-in screen shows only the methods the answer names, and never a hosted sign-in

A ready answer shows Google with email; a partial one shows email
without Google; with no answer, or one that readiness is unavailable,
email stays with its error and retry. SMS appears only when the host
reports it, never inferred. No answer ever offers the deployment's hosted
sign-in page in place of a method.

```quint
type SignInMethod = EmailMethod | PhoneMethod | GoogleMethod | HostedSignIn
pure def methodsShown(answer: Readiness, phoneReported: bool): List[SignInMethod] =
  List(EmailMethod).concat(if (phoneReported and (answer == Ready or answer == Partial)) List(PhoneMethod) else List())
    .concat(if (answer == Ready) List(GoogleMethod) else List())
pure def lawNeverOffersHostedSignIn(answer: Readiness, phoneReported: bool): bool = not(methodsShown(answer, phoneReported).includes(HostedSignIn))
pure def lawGoogleShownOnlyWhenReady(answer: Readiness, phoneReported: bool): bool = methodsShown(answer, phoneReported).includes(GoogleMethod) iff answer == Ready
pure def lawPhoneNeverInferred(answer: Readiness, phoneReported: bool): bool = methodsShown(answer, phoneReported).includes(PhoneMethod) implies phoneReported
```
