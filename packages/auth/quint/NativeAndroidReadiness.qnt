// Readiness of the Android sign-in methods (CloudSignInPlugin.status, probe,
// readinessMeasured, watchLink, handleOnResume; policy in CloudSignInReadiness).
// A ready answer is cached for hours. A fresh cached answer is always served at
// once. A method that is not ready is measured again behind that answer after a
// short TTL when a sign-in screen asks, and on a growing wait on load and
// resume, where a resume measures only for a recent sign-in screen or an
// attempt in progress. Only an explicit retry of an incomplete answer, or the
// lack of a fresh answer, makes a caller wait. A measurement that got no result
// keeps a fresh answer. A browser return link Android has not verified yet is
// watched with bounded local checks, and readiness is measured once it is
// verified. Callers join one probe.
module NativeAndroidReadiness {
  pure val WatchRounds = 6
  pure val MaxProbes = 5
  pure val MaxResumes = 6

  type State = {
    // The cached answer: none, unavailable (a measurement with no fresh answer
    // failed), partial (Google not ready) or ready.
    cache: str, recheckDue: bool, passiveDue: bool, expired: bool,
    probing: bool, waiters: int, probes: int,
    // A sign-in screen asked for status recently, or an attempt is in progress.
    surface: bool, resumes: int, resumeProbes: int, unaskedResumeProbes: int,
    // Android's verification of the return link, and the bounded watch.
    linkVerified: bool, watching: bool, watchRound: int, watchProbes: int,
    announcements: int, changes: int,
    servedDueWithoutMeasuring: bool, waitedOnFreshAnswer: bool, lostFreshAnswer: bool
  }
  var s: State

  action init = s' = {
    cache: "none", recheckDue: false, passiveDue: false, expired: false, probing: false, waiters: 0, probes: 0,
    surface: false, resumes: 0, resumeProbes: 0, unaskedResumeProbes: 0,
    linkVerified: false, watching: false, watchRound: 0, watchProbes: 0,
    announcements: 0, changes: 0,
    servedDueWithoutMeasuring: false, waitedOnFreshAnswer: false, lostFreshAnswer: false
  }

  pure def fresh(x: State): bool = x.cache != "none" and not(x.expired)
  pure def incomplete(x: State): bool = x.cache != "ready"

  // status() from a sign-in screen. A fresh answer is served at once; when a
  // method in it is due, a measurement starts behind it. The caller waits only
  // for an explicit retry of an incomplete answer or when nothing fresh exists.
  action status(refreshNegative: bool): bool = all {
    s.probes < MaxProbes, s.waiters < 2,
    val served = fresh(s) and (not(incomplete(s)) or not(refreshNegative))
    val due = incomplete(s) and s.recheckDue
    val measure = not(served) or due
    val starts = measure and not(s.probing)
    s' = { ...s, surface: true,
      probing: s.probing or measure,
      probes: s.probes + (if (starts) 1 else 0),
      waiters: s.waiters + (if (served) 0 else 1),
      servedDueWithoutMeasuring: s.servedDueWithoutMeasuring or (served and due and not(s.probing or measure)),
      waitedOnFreshAnswer: s.waitedOnFreshAnswer or (not(served) and fresh(s) and not(refreshNegative)) }
  }

  // Resume (and the warm-up on load when `first`): no caller. It measures only
  // for a recent sign-in screen or an attempt, and only when the growing wait ended.
  action resume(first: bool): bool = all {
    s.resumes < MaxResumes, s.probes < MaxProbes,
    val allowed = first or s.surface
    val due = not(fresh(s)) or (incomplete(s) and s.passiveDue)
    val starts = allowed and due and not(s.probing)
    s' = { ...s, resumes: s.resumes + 1,
      probing: s.probing or (allowed and due),
      probes: s.probes + (if (starts) 1 else 0),
      resumeProbes: s.resumeProbes + (if (starts) 1 else 0),
      unaskedResumeProbes: s.unaskedResumeProbes + (if (starts and not(first) and not(s.surface)) 1 else 0) }
  }

  // The probe's answer. Google is ready only once Android verified the link.
  // A change from an earlier answer is announced; an unverified link is watched.
  // A measurement with no result keeps a fresh answer and announces nothing.
  action measured(failed: bool): bool = all {
    s.probing,
    val kept = failed and fresh(s)
    val result = if (kept) s.cache else if (failed) "unavailable" else if (s.linkVerified) "ready" else "partial"
    val changed = s.cache != "none" and s.cache != result
    s' = { ...s, probing: false, waiters: 0, cache: result, recheckDue: false, passiveDue: false,
      expired: if (kept) s.expired else false,
      changes: s.changes + (if (changed) 1 else 0),
      announcements: s.announcements + (if (changed) 1 else 0),
      lostFreshAnswer: s.lostFreshAnswer or (failed and fresh(s) and result != s.cache),
      watching: s.watching or (not(failed) and result == "partial"),
      watchRound: if (not(s.watching) and not(failed) and result == "partial") 0 else s.watchRound }
  }

  // One local check of the link. No request is sent until Android verified it;
  // then readiness is measured once and the watch ends.
  action watchTick = all {
    s.watching,
    s' = if (s.watchRound >= WatchRounds) { ...s, watching: false }
      else if (not(s.linkVerified)) { ...s, watchRound: s.watchRound + 1 }
      else if (s.probing or s.probes >= MaxProbes) { ...s, watching: false }
      else { ...s, watching: false, probing: true, probes: s.probes + 1,
        watchProbes: s.watchProbes + 1 }
  }

  action linkVerifies = all { not(s.linkVerified), s' = { ...s, linkVerified: true } }
  action shortTtlEnds = all { s.cache.in(Set("partial", "unavailable")), not(s.recheckDue), s' = { ...s, recheckDue: true } }
  // The growing wait for measurements nobody asked for never ends before the short one.
  action passiveWaitEnds = all { s.recheckDue, not(s.passiveDue), s' = { ...s, passiveDue: true } }
  action longTtlEnds = all { s.cache != "none", not(s.expired), s' = { ...s, expired: true } }
  // The sign-in screen's last lookup is ten minutes old and no attempt is in progress.
  action surfaceGoesQuiet = all { s.surface, s' = { ...s, surface: false } }

  action idle = s' = s
  action step = any {
    nondet refresh = Set(true, false).oneOf()
    status(refresh),
    nondet first = Set(true, false).oneOf()
    resume(first and s.resumes == 0),
    nondet failed = Set(true, false).oneOf()
    measured(failed),
    watchTick, linkVerifies, shortTtlEnds, passiveWaitEnds, longTtlEnds, surfaceGoesQuiet, idle
  }

  // A cached "not ready" is never served past its short TTL without a measurement running behind it.
  val NegativeIsMeasuredAgain = not(s.servedDueWithoutMeasuring)
  // Opening sign-in never waits for a recheck: a fresh answer is served at once unless Retry was asked.
  val FreshAnswerServedAtOnce = not(s.waitedOnFreshAnswer)
  // A measurement that got no result never replaces a fresh answer.
  val FailedProbeKeepsFreshAnswer = not(s.lostFreshAnswer)
  // Resume sends nothing unless a sign-in screen asked recently or an attempt is in progress.
  val ResumeProbesOnlyWhenAsked = s.unaskedResumeProbes == 0
  // Callers wait only for a running probe: one probe per deployment.
  val CallersJoinOneProbe = (s.waiters > 0).implies(s.probing)
  // The watch is bounded and sends nothing before Android verified the link.
  val WatchBounded = s.watchRound.in(0.to(WatchRounds))
  val WatchSendsNothingUnverified = (s.watchProbes > 0).implies(s.linkVerified)
  // Google is never reported ready over an unverified link.
  val ReadyNeedsVerifiedLink = (s.cache == "ready").implies(s.linkVerified)
  // Only a changed answer is announced, and never the first one.
  val AnnouncedOnlyChanges = s.announcements == s.changes and s.announcements < s.probes + 1
  val ProbeBudget = s.probes.in(0.to(MaxProbes)) and s.waiters.in(0.to(2)) and s.resumeProbes <= s.resumes

  run verifiedLinkIsMeasuredAndAnnouncedTest = init.then(status(false)).then(measured(false))
    .expect(s.cache == "partial" and s.watching and s.announcements == 0)
    .then(watchTick).then(linkVerifies).then(watchTick)
    .expect(s.probing and s.watchProbes == 1 and not(s.watching))
    .then(measured(false)).expect(s.cache == "ready" and s.announcements == 1)

  run dueAnswerIsServedAndMeasuredBehindTest = init.then(status(false)).then(measured(false))
    .then(status(false)).expect(s.probes == 1 and not(s.probing) and s.waiters == 0)
    .then(shortTtlEnds).then(status(false))
    .expect(s.probes == 2 and s.probing and s.waiters == 0 and not(s.waitedOnFreshAnswer))

  run explicitRetryWaitsForTheMeasurementTest = init.then(status(false)).then(measured(false))
    .then(status(true)).expect(s.probes == 2 and s.probing and s.waiters == 1)
    .then(status(true)).expect(s.probes == 2 and s.waiters == 2)

  run failedRecheckKeepsReadyMethodsTest = init.then(status(false)).then(measured(false))
    .then(shortTtlEnds).then(status(false)).then(measured(true))
    .expect(s.cache == "partial" and s.announcements == 0 and not(s.recheckDue))

  run failedProbeWithoutFreshAnswerIsUnavailableTest = init.then(status(false)).then(measured(true))
    .expect(s.cache == "unavailable" and s.announcements == 0)
    .then(shortTtlEnds).then(status(false)).then(measured(false))
    .expect(s.cache == "partial" and s.announcements == 1)

  run readyAnswerStaysCachedTest = init.then(linkVerifies).then(status(false)).then(measured(false))
    .then(status(true)).expect(s.probes == 1 and s.cache == "ready" and not(s.watching))

  run resumeWithoutSignInScreenSendsNothingTest = init.then(resume(true)).then(measured(false))
    .then(shortTtlEnds).then(passiveWaitEnds).then(resume(false)).then(resume(false))
    .expect(s.probes == 1 and s.resumeProbes == 1 and not(s.probing))
    .then(status(false)).expect(s.probes == 2 and s.waiters == 0)
    .then(measured(false)).then(shortTtlEnds).then(resume(false))
    .expect(s.probes == 2 and not(s.probing))
    .then(passiveWaitEnds).then(resume(false)).expect(s.probes == 3 and s.resumeProbes == 2)

  run unverifiedWatchEndsQuietlyTest = init.then(resume(true)).then(measured(false))
    .then(watchTick).then(watchTick).then(watchTick).then(watchTick).then(watchTick).then(watchTick)
    .then(watchTick).expect(not(s.watching) and s.watchRound == 6 and s.probes == 1)
}
