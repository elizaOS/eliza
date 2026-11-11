// Readiness of the Android sign-in methods (CloudSignInPlugin.status, probe,
// readinessMeasured, watchLink, handleOnResume; policy in CloudSignInReadiness).
// A ready answer is cached for hours. A method that is not ready is measured
// again after a short TTL, on resume and on an explicit retry. A browser return
// link Android has not verified yet is watched with bounded local checks, and
// readiness is measured once it is verified. Callers join one probe.
module NativeAndroidReadiness {
  pure val WatchRounds = 6
  pure val MaxProbes = 4

  type State = {
    // The cached answer: none, partial (Google not ready) or ready.
    cache: str, recheckDue: bool, expired: bool,
    probing: bool, waiters: int, probes: int,
    // Android's verification of the return link, and the bounded watch.
    linkVerified: bool, watching: bool, watchRound: int, watchProbes: int,
    announcements: int, changes: int, servedNegativeWhenDue: bool
  }
  var s: State

  action init = s' = {
    cache: "none", recheckDue: false, expired: false, probing: false, waiters: 0, probes: 0,
    linkVerified: false, watching: false, watchRound: 0, watchProbes: 0,
    announcements: 0, changes: 0, servedNegativeWhenDue: false
  }

  pure def cachedAnswerServes(x: State, refreshNegative: bool): bool =
    x.cache != "none" and not(x.expired) and
      (x.cache == "ready" or (not(refreshNegative) and not(x.recheckDue)))

  // status() from the renderer, or the warm-up on load and resume (no caller).
  action status(refreshNegative: bool, caller: bool): bool = all {
    s.probes < MaxProbes, s.waiters < 2,
    s' = if (cachedAnswerServes(s, refreshNegative))
        { ...s, servedNegativeWhenDue: s.servedNegativeWhenDue or
            (s.cache == "partial" and (s.recheckDue or refreshNegative)) }
      else if (s.probing) { ...s, waiters: s.waiters + (if (caller) 1 else 0) }
      else { ...s, probing: true, probes: s.probes + 1, waiters: if (caller) 1 else 0 }
  }

  // The probe's answer. Google is ready only once Android verified the link.
  // A change from an earlier answer is announced; an unverified link is watched.
  action measured = all {
    s.probing,
    val result = if (s.linkVerified) "ready" else "partial"
    val changed = s.cache != "none" and s.cache != result
    s' = { ...s, probing: false, waiters: 0, cache: result, recheckDue: false, expired: false,
      changes: s.changes + (if (changed) 1 else 0),
      announcements: s.announcements + (if (changed) 1 else 0),
      watching: s.watching or result == "partial",
      watchRound: if (not(s.watching) and result == "partial") 0 else s.watchRound }
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
  action shortTtlEnds = all { s.cache == "partial", not(s.recheckDue), s' = { ...s, recheckDue: true } }
  action longTtlEnds = all { s.cache != "none", not(s.expired), s' = { ...s, expired: true } }

  action idle = s' = s
  action step = any {
    nondet refresh = Set(true, false).oneOf()
    nondet caller = Set(true, false).oneOf()
    status(refresh, caller),
    measured, watchTick, linkVerifies, shortTtlEnds, longTtlEnds, idle
  }

  // A cached "not ready" is never served once its short TTL ended or on an explicit retry.
  val NegativeIsMeasuredAgain = not(s.servedNegativeWhenDue)
  // Callers wait only for a running probe: one probe per deployment.
  val CallersJoinOneProbe = (s.waiters > 0).implies(s.probing)
  // The watch is bounded and sends nothing before Android verified the link.
  val WatchBounded = s.watchRound.in(0.to(WatchRounds))
  val WatchSendsNothingUnverified = (s.watchProbes > 0).implies(s.linkVerified)
  // Google is never reported ready over an unverified link.
  val ReadyNeedsVerifiedLink = (s.cache == "ready").implies(s.linkVerified)
  // Only a changed answer is announced, and never the first one.
  val AnnouncedOnlyChanges = s.announcements == s.changes and s.announcements < s.probes + 1
  val ProbeBudget = s.probes.in(0.to(MaxProbes)) and s.waiters.in(0.to(2))

  run verifiedLinkIsMeasuredAndAnnouncedTest = init.then(status(false, true)).then(measured)
    .expect(s.cache == "partial" and s.watching and s.announcements == 0)
    .then(watchTick).then(linkVerifies).then(watchTick)
    .expect(s.probing and s.watchProbes == 1 and not(s.watching))
    .then(measured).expect(s.cache == "ready" and s.announcements == 1)

  run negativeAnswerIsNotServedAfterItsTtlTest = init.then(status(false, true)).then(measured)
    .then(status(false, true)).expect(s.probes == 1 and not(s.probing))
    .then(shortTtlEnds).then(status(false, true)).expect(s.probes == 2 and s.probing)

  run explicitRetryMeasuresAtOnceTest = init.then(status(false, true)).then(measured)
    .then(status(true, true)).expect(s.probes == 2 and s.probing and s.waiters == 1)
    .then(status(true, true)).expect(s.probes == 2 and s.waiters == 2)

  run readyAnswerStaysCachedTest = init.then(linkVerifies).then(status(false, true)).then(measured)
    .then(status(true, true)).expect(s.probes == 1 and s.cache == "ready" and not(s.watching))

  run unverifiedWatchEndsQuietlyTest = init.then(status(false, false)).then(measured)
    .then(watchTick).then(watchTick).then(watchTick).then(watchTick).then(watchTick).then(watchTick)
    .then(watchTick).expect(not(s.watching) and s.watchRound == 6 and s.probes == 1)
}
