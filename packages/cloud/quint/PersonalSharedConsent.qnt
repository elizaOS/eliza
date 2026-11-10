// One all-adults binding. SQL serializes consent, account retirement and delivery authority.
// The live slot is separate from the durable attempt retained for each source.
module PersonalSharedConsent {
  type Lease = { source: int, token: int, until: int, committedAt: int }
  type Attempt = { token: int, epoch: int, control: bool, status: str }
  type State = {
    now: int, epoch: int, active: bool, ownerEligible: bool, joinerEligible: bool,
    consent: bool, challenge: int, lastChallenge: int, retirement: str,
    lease: Lease, lastToken: int, attempts: int -> Attempt
  }

  pure val Sources = Set(1, 2)
  pure val EmptyLease = { source: 0, token: 0, until: 0, committedAt: -1 }
  pure val EmptyAttempt = { token: 0, epoch: 0, control: false, status: "none" }
  pure val Horizon = 4
  pure val MaxToken = 3
  pure val Recovery = 2

  var s: State
  action init = s' = {
    now: 0, epoch: 1, active: true, ownerEligible: true, joinerEligible: true,
    consent: false, challenge: 0, lastChallenge: 0, retirement: "idle",
    lease: EmptyLease, lastToken: 0, attempts: Sources.mapBy(_ => EmptyAttempt)
  }

  val liveReservation = s.lease.source != 0 and s.lease.committedAt < 0 and s.lease.until > s.now
  val joinerQualifies = s.active and s.joinerEligible
  val quorum = s.ownerEligible and joinerQualifies and s.consent

  action issueChallenge = all {
    joinerQualifies and not(s.consent) and s.challenge == 0 and s.lastChallenge < 2,
    s' = s.with("challenge", s.lastChallenge + 1).with("lastChallenge", s.lastChallenge + 1)
  }

  def canConfirm(challenge: int): bool = joinerQualifies and not(liveReservation) and
    not(s.consent) and challenge > 0 and s.challenge == challenge

  action confirm(challenge: int): bool = all {
    canConfirm(challenge),
    s' = s.with("consent", true).with("challenge", 0).with("epoch", s.epoch + 1)
  }

  action requestRetirement = all {
    s.retirement == "idle" and s.active,
    s' = s.with("retirement", "pending")
  }

  action retireAccount = all {
    s.retirement == "pending",
    {
      val linkedAuthority = s.consent or s.challenge > 0
      all {
        not(linkedAuthority and liveReservation),
        s' = s.with("active", false).with("retirement", "done")
          .with("consent", false).with("challenge", 0)
          .with("epoch", if (linkedAuthority) s.epoch + 1 else s.epoch)
      }
    }
  }

  action reactivate = all { not(s.active), s' = s.with("active", true) }
  action loseOwnerEligibility = all { s.ownerEligible, s' = s.with("ownerEligible", false) }
  action loseJoinerEligibility = all { s.joinerEligible, s' = s.with("joinerEligible", false) }

  // The stale-attempt write can survive a denied authorization in the same transaction.
  action authorize(source: int, epoch: int, control: bool, exactScope: bool): bool = {
    val scoped = exactScope and epoch == s.epoch
    val recover = scoped and s.lease.committedAt >= 0 and s.lease.committedAt + Recovery <= s.now
    val prior = if (recover)
      s.with("attempts", s.attempts.set(s.lease.source,
        s.attempts.get(s.lease.source).with("status", "uncertain")))
        .with("lease", EmptyLease)
      else s
    val available = prior.lease.source == 0 or
      (prior.lease.committedAt < 0 and prior.lease.until <= s.now)
    val allowed = scoped and (control or quorum) and available and
      prior.attempts.get(source) == EmptyAttempt and s.now < Horizon and s.lastToken < MaxToken
    val token = s.lastToken + 1
    s' = if (allowed) prior.with("lastToken", token)
      .with("lease", { source: source, token: token, until: s.now + 1, committedAt: -1 })
      else prior
  }

  action renew(source: int, token: int, epoch: int, control: bool): bool = all {
    source == s.lease.source and token == s.lease.token and epoch == s.epoch,
    s.lease.committedAt < 0 and (control or quorum) and s.now < Horizon,
    s' = s.with("lease", s.lease.with("until", s.now + 1))
  }

  def canCommit(source: int, token: int, epoch: int, control: bool, exactScope: bool): bool =
    exactScope and epoch == s.epoch and source == s.lease.source and token == s.lease.token and
      (control or quorum) and (s.lease.committedAt >= 0 or liveReservation)

  action commit(source: int, token: int, epoch: int, control: bool, exactScope: bool): bool = all {
    canCommit(source, token, epoch, control, exactScope),
    s' = if (s.lease.committedAt >= 0) s else
      s.with("lease", s.lease.with("committedAt", s.now))
        .with("attempts", s.attempts.set(source,
          { token: token, epoch: epoch, control: control, status: "committed" }))
  }

  def canRecord(source: int, token: int, exactScope: bool): bool =
    exactScope and token > 0 and s.attempts.get(source).token == token

  action record(source: int, token: int, exactScope: bool): bool = all {
    canRecord(source, token, exactScope),
    s' = s.with("attempts", s.attempts.set(source, s.attempts.get(source).with("status", "reconciled")))
      .with("lease", if (s.lease.source == source and s.lease.token == token) EmptyLease else s.lease)
  }

  action tick = all { s.now < Horizon, s' = s.with("now", s.now + 1) }
  action wait = s' = s

  action step = any {
    issueChallenge, confirm(s.challenge), requestRetirement, retireAccount, reactivate,
    loseOwnerEligibility, loseJoinerEligibility, tick, wait,
    {
      nondet source = Sources.oneOf()
      nondet control = Set(false, true).oneOf()
      any {
        authorize(source, s.epoch, control, true),
        renew(source, s.lease.token, s.epoch, control),
        commit(source, s.lease.token, s.epoch, control, true),
        record(source, s.attempts.get(source).token, true)
      }
    }
  }

  val Safety = and {
    not(s.active) implies (not(s.consent) and s.challenge == 0),
    s.consent implies (s.challenge == 0 and s.active),
    s.lease.committedAt >= 0 implies
      (s.attempts.get(s.lease.source).token == s.lease.token and
        s.attempts.get(s.lease.source).status == "committed"),
    liveReservation implies s.attempts.get(s.lease.source) == EmptyAttempt,
    Sources.forall(source => s.attempts.get(source).token <= s.lastToken)
  }

  temporal DurableAuthority = always((all {
    (liveReservation and (s.consent or s.challenge > 0)) implies
      (next(s.active) == s.active and next(s.epoch) == s.epoch),
    Sources.forall(source => all {
      (s.attempts.get(source).token == 0 and next(s.attempts.get(source).token) > 0) implies
        (next(s.attempts.get(source).epoch) == s.epoch and
          (next(s.attempts.get(source).control) or quorum)),
      s.attempts.get(source).token > 0 implies all {
        next(s.attempts.get(source).token) == s.attempts.get(source).token,
        next(s.attempts.get(source).epoch) == s.attempts.get(source).epoch,
        next(s.attempts.get(source).control) == s.attempts.get(source).control
      },
      (s.attempts.get(source).status == "reconciled") implies
        next(s.attempts.get(source).status) == "reconciled",
      (s.attempts.get(source).status != "reconciled" and
        next(s.attempts.get(source).status) == "reconciled" and s.lease.source != source)
          implies next(s.lease) == s.lease
    })
  }).orKeep(s))

  temporal RetirementSettles = (s.retirement == "pending").leadsTo(s.retirement == "done")
  temporal FairRetirement = (tick.weakFair(s) and retireAccount.weakFair(s)) implies RetirementSettles

  run consentControlBypassesQuorumTest = init
    .then(authorize(1, 1, false, true)).expect(s.lease == EmptyLease)
    .then(authorize(1, 1, true, true)).then(commit(1, 1, 1, true, true))
    .expect(s.attempts.get(1).status == "committed")

  run eligibilityRecheckedAtCommitTest = init.then(issueChallenge).then(confirm(1))
    .then(authorize(1, 2, false, true)).then(loseJoinerEligibility)
    .expect(not(canCommit(1, 1, 2, false, true)) and s.attempts.get(1) == EmptyAttempt)

  run retirementRetriesAfterExpiryTest = init.then(issueChallenge).then(confirm(1))
    .then(authorize(1, 2, false, true)).then(requestRetirement)
    .expect(s.active and s.consent and liveReservation)
    .then(tick).then(retireAccount).then(reactivate)
    .expect(not(s.consent) and s.epoch == 3 and not(canCommit(1, 1, 2, false, true)))

  run pendingConfirmationCannotResurrectTest = init.then(issueChallenge)
    .then(requestRetirement).then(retireAccount).then(reactivate).then(issueChallenge)
    .expect(s.challenge == 2 and s.epoch == 2 and not(canConfirm(1)))
    .then(confirm(2)).expect(s.consent and s.epoch == 3)

  run expiredTokenFencedTest = init.then(issueChallenge).then(confirm(1))
    .then(authorize(1, 2, false, true)).then(tick).then(authorize(1, 2, false, true))
    .expect(not(canCommit(1, 1, 2, false, true)))
    .then(commit(1, 2, 2, false, true)).expect(not(canRecord(1, 1, true)))

  run wrongAuthorityCannotPublishOrRecordTest = init.then(issueChallenge).then(confirm(1))
    .then(authorize(1, 2, false, false)).expect(s.lease == EmptyLease)
    .then(authorize(1, 1, false, true)).expect(s.lease == EmptyLease)
    .then(authorize(1, 2, false, true))
    .expect(not(canCommit(1, 1, 2, false, false)))
    .then(commit(1, 1, 2, false, true)).expect(not(canRecord(1, 1, false)))

  run retirementPreservesExactLateReceiptTest = init.then(issueChallenge).then(confirm(1))
    .then(authorize(1, 2, false, true)).then(commit(1, 1, 2, false, true))
    .then(requestRetirement).then(retireAccount).then(tick).then(tick)
    .then(authorize(1, 3, true, true))
    .expect(s.lease == EmptyLease and s.attempts.get(1).status == "uncertain")
    .then(authorize(2, 3, true, true)).then(record(1, 1, true))
    .expect(s.lease.source == 2 and s.attempts.get(1).status == "reconciled")
}
