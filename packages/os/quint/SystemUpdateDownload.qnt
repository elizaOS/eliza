/// Settled calls for one known-unapplied candidate in the updater's private cache.
/// The serial host and the real FileLock own each call; apply/reboot authority is separate.
module SystemUpdateDownload {
  type State = {partial: str, published: bool, peerLock: bool,
    requests: int, rangeRequests: int, outcome: str,
    beforePartial: str, beforeRequests: int, beforeRanges: int}
  pure val Parts = Set("empty", "prefix", "bad-prefix", "corrupt", "oversized", "valid")
  var s: State
  pure def initial(partial: str): State = {partial: partial, published: false, peerLock: false,
    requests: 0, rangeRequests: 0, outcome: "ready",
    beforePartial: partial, beforeRequests: 0, beforeRanges: 0}
  action init = s' = initial("empty")
  action corruptInit = s' = initial("corrupt")
  action seed(partial: str): bool = all {
    partial.in(Parts), s.outcome == "ready", not(s.published),
    s' = {...s, partial: partial, beforePartial: partial, outcome: "seeded"}
  }
  action lockPeer(value: bool): bool = all {
    not(s.published), s.peerLock != value,
    s' = {...s, peerLock: value}
  }
  action reopen = all {
    not(s.published), s.outcome != "reopened",
    s' = {...s, outcome: "reopened"}
  }
  // Cancellation/deadline while hashing retained bytes precedes digest rejection.
  // The oversized length guard is earlier and does not take this path.
  action pauseRetainedRead = all {
    not(s.published), not(s.peerLock), s.partial.in(Set("prefix", "bad-prefix", "corrupt", "valid")),
    s' = {...s, beforePartial: s.partial, beforeRequests: s.requests,
      beforeRanges: s.rangeRequests, outcome: "paused"}
  }
  // A rejected full/oversized partial is reset under the held lock, then the call fails.
  // The next call can fetch again. A bad prefix fails only after a real ranged fetch.
  // The external response class describes a valid body or an interrupted valid prefix.
  action attempt(response: str): bool = {
    val resetBeforeNetwork = s.partial.in(Set("corrupt", "oversized"))
    val network = not(s.peerLock) and not(resetBeforeNetwork) and s.partial != "valid"
    val interrupted = network and response == "interrupted"
    val rejected = not(s.peerLock) and (resetBeforeNetwork or
      (s.partial == "bad-prefix" and not(interrupted)))
    val published = not(s.peerLock) and not(rejected) and not(interrupted)
    all {
      response.in(Set("valid", "interrupted")), not(s.published),
      not(network) or s.requests < 2,
      s' = {...s,
        beforePartial: s.partial, beforeRequests: s.requests, beforeRanges: s.rangeRequests,
        partial: if (s.peerLock) s.partial else if (rejected or published) "empty"
          else if (s.partial == "bad-prefix") "bad-prefix" else "prefix",
        requests: s.requests + (if (network) 1 else 0),
        rangeRequests: s.rangeRequests +
          (if (network and s.partial.in(Set("prefix", "bad-prefix"))) 1 else 0),
        published: published,
        outcome: if (s.peerLock) "busy" else if (rejected) "rejected"
          else if (published) "published" else "paused"}
    }
  }
  action step = any {
    nondet part = Parts.oneOf()
    seed(part),
    nondet held = Bool.oneOf()
    lockPeer(held),
    attempt("valid"), attempt("interrupted"), pauseRetainedRead, reopen, s' = s
  }
  action recoveryStep = any {attempt("valid"), s' = s}
  val TypeOK = s.partial.in(Parts) and s.beforePartial.in(Parts)
    and s.requests.in(0.to(2)) and s.rangeRequests.in(0.to(s.requests))
    and s.outcome.in(Set("ready", "seeded", "busy", "reopened", "rejected", "paused", "published"))
  val VerifiedPublication = s.published implies (s.partial == "empty" and s.outcome == "published"
    and s.beforePartial.in(Set("empty", "prefix", "valid"))
    and s.requests == s.beforeRequests + (if (s.beforePartial == "valid") 0 else 1))
  val RejectedDataCannotPublish = s.outcome == "rejected" implies (not(s.published) and s.partial == "empty")
  val BusyPreservesOwnedFile = s.outcome == "busy" implies
    (s.partial == s.beforePartial and s.requests == s.beforeRequests and s.rangeRequests == s.beforeRanges)
  val NoReadOfRejectedCompleteFile = s.outcome == "rejected"
    and s.beforePartial.in(Set("corrupt", "oversized")) implies s.requests == s.beforeRequests
  val safety = TypeOK and VerifiedPublication and RejectedDataCannotPublish
    and BusyPreservesOwnedFile and NoReadOfRejectedCompleteFile
  val invariant = safety
  temporal RetryEventuallyPublishes = eventually(s.published)
  temporal FairRetryEventuallyPublishes = attempt("valid").weakFair(s) implies RetryEventuallyPublishes

  run corruptCompleteCanRetryTest = init.then(seed("corrupt")).then(attempt("valid"))
    .expect(safety and s.partial == "empty" and not(s.published) and s.requests == 0)
    .then(attempt("valid")).expect(safety and s.published and s.requests == 1)
  run oversizedCompleteCanRetryTest = init.then(seed("oversized")).then(attempt("valid"))
    .then(reopen).expect(safety and s.partial == "empty")
    .then(attempt("valid")).expect(safety and s.published and s.requests == 1)
  run validPrefixResumesTest = init.then(seed("prefix")).then(attempt("valid"))
    .expect(safety and s.published and s.requests == 1 and s.rangeRequests == 1)
  run corruptPrefixRefetchesAfterDigestFailureTest = init.then(seed("bad-prefix")).then(attempt("valid"))
    .expect(safety and not(s.published) and s.partial == "empty" and s.requests == 1 and s.rangeRequests == 1)
    .then(attempt("valid")).expect(safety and s.published and s.requests == 2 and s.rangeRequests == 1)
  run validCompleteNeedsNoNetworkTest = init.then(seed("valid")).then(attempt("valid"))
    .expect(safety and s.published and s.requests == 0)
  run peerLockCannotResetRejectedBytesTest = init.then(seed("corrupt")).then(lockPeer(true))
    .then(attempt("valid")).expect(safety and s.partial == "corrupt" and s.outcome == "busy")
    .then(lockPeer(false)).then(attempt("valid")).then(attempt("valid")).expect(safety and s.published)
  run interruptedPrefixSurvivesRestartTest = init.then(attempt("interrupted"))
    .then(reopen).expect(safety and s.partial == "prefix" and not(s.published))
    .then(attempt("valid")).expect(safety and s.published and s.requests == 2)
  run retainedReadCancellationPreservesUntilRetryTest = init.then(seed("corrupt"))
    .then(pauseRetainedRead).then(reopen).expect(safety and s.partial == "corrupt" and s.requests == 0)
    .then(attempt("valid")).then(attempt("valid")).expect(safety and s.published and s.requests == 1)
}
