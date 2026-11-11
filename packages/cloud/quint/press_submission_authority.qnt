// Local press-release state through submission. The release row serializes
// cancellation with recording a receipt. No provider work is dispatched here.
module press_submission_authority {
  type Phase = Draft | Ready | Submitted | Cancelled
  type Reply = NoReply | Accepted | Replayed | Rejected | RolledBack
  type State = {
    phases: int -> Phase,
    keyRelease: int, keyProvider: int, legacy: bool,
    unkeyed: Set[int],
    reply: Reply, replyRelease: int, replyProvider: int,
  }
  var s: State

  pure val draftState: State = {
    phases: Map(1 -> Draft, 2 -> Draft),
    keyRelease: 0, keyProvider: 0, legacy: false,
    unkeyed: Set(), reply: NoReply, replyRelease: 0, replyProvider: 0,
  }
  action init = {
    nondet legacy = Set(false, true).oneOf()
    s' = if (legacy) {
      ...draftState, phases: Map(1 -> Cancelled, 2 -> Draft),
      keyRelease: 1, keyProvider: 1, legacy: true,
    } else draftState
  }
  action markReady(release: int, tenant: int): bool = all {
    tenant == 1, s.phases.get(release) == Draft,
    s' = s.with("phases", s.phases.set(release, Ready)),
  }
  action cancel(release: int, tenant: int): bool = all {
    tenant == 1, s.phases.get(release).in(Set(Draft, Ready)),
    s' = s.with("phases", s.phases.set(release, Cancelled)),
  }
  action record(
    release: int, tenant: int, provider: int, keyed: bool, commits: bool, acknowledges: bool
  ): bool = {
    val phase = s.phases.get(release)
    val observed = { ...s, replyRelease: release, replyProvider: provider }
    if (tenant != 1 or not(phase.in(Set(Ready, Submitted))))
      s' = observed.with("reply", Rejected)
    else if (keyed and s.keyRelease != 0)
      s' = observed.with("reply", if (
        phase == Submitted and s.keyRelease == release and s.keyProvider == provider
      ) Replayed else Rejected)
    else if (not(commits))
      s' = observed.with("reply", RolledBack)
    else s' = {
      ...observed, phases: s.phases.set(release, Submitted),
      keyRelease: if (keyed) release else s.keyRelease,
      keyProvider: if (keyed) provider else s.keyProvider,
      unkeyed: if (keyed) s.unkeyed else s.unkeyed.union(Set(release)),
      reply: if (acknowledges) Accepted else NoReply,
    }
  }
  action idle = s' = s
  action step = any {
    idle,
    {
      nondet release = Set(1, 2).oneOf()
      nondet tenant = Set(1, 2).oneOf()
      nondet provider = Set(1, 2).oneOf()
      nondet keyed = Set(false, true).oneOf()
      nondet commits = Set(false, true).oneOf()
      nondet acknowledges = Set(false, true).oneOf()
      any { markReady(release, tenant), cancel(release, tenant),
        record(release, tenant, provider, keyed, commits, acknowledges) }
    },
  }

  val NewReceiptsHaveSubmittedRelease =
    (s.keyRelease == 0 or s.legacy or s.phases.get(s.keyRelease) == Submitted) and
    s.unkeyed.forall(release => s.phases.get(release) == Submitted)
  val ReplayMatchesOriginal =
    s.reply == Replayed implies and {
      s.keyRelease == s.replyRelease, s.keyProvider == s.replyProvider,
      s.phases.get(s.replyRelease) == Submitted,
    }
  val HistoricalCancelledReleaseRemainsCancelled =
    s.legacy implies s.phases.get(1) == Cancelled
  temporal DurableReceiptAndCancellation = always(and {
    s.keyRelease != 0 implies
      (next(s.keyRelease) == s.keyRelease and next(s.keyProvider) == s.keyProvider),
    s.unkeyed.subseteq(next(s.unkeyed)),
    Set(1, 2).forall(release => s.phases.get(release) == Cancelled implies
      next(s.phases).get(release) == Cancelled),
  }.orKeep(s))

  action stableInit = s' = draftState.with("phases", Map(1 -> Ready, 2 -> Draft))
  action submitFirst = all {
    s.phases.get(1) == Ready, record(1, 1, 1, true, true, true),
  }
  action cancelFirst = cancel(1, 1)
  action rollbackFirst = record(1, 1, 1, true, false, true)
  action stableStep = any { submitFirst, cancelFirst, rollbackFirst, idle }
  temporal ReadyEventuallyResolves = eventually(s.phases.get(1) != Ready)
  temporal FairResolution =
    (submitFirst.weakFair(s) and cancelFirst.weakFair(s)) implies ReadyEventuallyResolves

  run cancelWinsWithoutReceiptTest = stableInit.then(cancelFirst)
    .then(record(1, 1, 1, false, true, true))
    .expect(s.phases.get(1) == Cancelled and s.unkeyed == Set() and s.reply == Rejected)
  run lostReplyReplaysOriginalBindingTest = stableInit
    .then(record(1, 1, 1, true, true, false))
    .expect(s.phases.get(1) == Submitted and s.reply == NoReply)
    .then(record(1, 1, 2, true, true, true)).expect(s.reply == Rejected)
    .then(markReady(2, 1)).then(record(2, 1, 1, true, true, true))
    .expect(s.phases.get(2) == Ready and s.reply == Rejected)
    .then(record(1, 2, 1, true, true, true)).expect(s.reply == Rejected)
    .then(record(1, 1, 1, true, true, true)).expect(s.reply == Replayed)
  run failedTransitionRollsBackThenRetriesTest = stableInit.then(rollbackFirst)
    .expect(s.phases.get(1) == Ready and s.keyRelease == 0 and s.reply == RolledBack)
    .then(submitFirst)
    .expect(s.phases.get(1) == Submitted and s.keyRelease == 1 and s.reply == Accepted)
  action historical = s' = {
    ...draftState, phases: Map(1 -> Cancelled, 2 -> Draft),
    keyRelease: 1, keyProvider: 1, legacy: true,
  }
  run cancelledHistoricalReceiptCannotReplayTest = historical
    .then(record(1, 1, 1, true, true, true))
    .expect(s.phases.get(1) == Cancelled and s.keyRelease == 1 and s.reply == Rejected)
}
