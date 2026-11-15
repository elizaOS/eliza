// native-host/cloud-enrollment.mjs: durable tail after mobile/token is saved.
// Each transition completes one public operation, including its failed await.
// The race action names the await at which cancel increments the epoch. It
// waits for resume to settle before reading and revoking the durable receipt.
// Remote acknowledgement/revocation are atomic, authenticated server effects.
// One credential, one host, no new sign-in or replacement credential. The
// verified-owner activation callback and issuance/PKCE are separate contracts.
module NativeEnrollmentRecovery {
  type Durable = { pending: str, active: bool, remote: str }
  type State = {
    durable: Durable,
    previous: Durable,
    now: int,
    bindingMatches: bool,
    ackEver: bool,
    cancelLogged: bool,
    revokeConfirmed: bool,
    operation: str,
    fault: str,
    result: str,
    targeted: bool,
  }
  var s: State

  val resumeFaults = Set(
    "none", "ack-before", "ack-after", "ack-invalid",
    "activate-before", "activate-after", "clear-before", "clear-after"
  )
  val cancelFaults = Set(
    "none", "journal-before", "journal-after", "revoke-before",
    "revoke-after", "active-before", "active-after",
    "clear-before", "clear-after"
  )
  val raceCuts = Set("read", "ack", "activate", "activate-commit", "clear")

  action initial(acked: bool, active: bool, matches: bool): bool = all {
    active.implies(acked),
    val durable = {
      pending: "activation", active: active,
      remote: if (acked) "acknowledged" else "issued"
    }
    s' = {
      durable: durable, previous: durable, now: 0, bindingMatches: matches,
      ackEver: acked, cancelLogged: false, revokeConfirmed: false,
      operation: "init", fault: "none", result: "init", targeted: false,
    },
  }
  action init = {
    nondet acked = Set(false, true).oneOf()
    nondet active = Set(false, true).oneOf()
    nondet matches = Set(false, true).oneOf()
    initial(acked, active, matches)
  }

  action resume(fault: str): bool = {
    val before = s.durable
    val eligible = before.pending == "activation" and s.bindingMatches
    val remoteAccepts = before.remote == "acknowledged" or
      (before.remote == "issued" and s.now < 2)
    val ackApplied = eligible and remoteAccepts and fault != "ack-before"
    val ackReturned = ackApplied and fault != "ack-after" and fault != "ack-invalid"
    val activated = ackReturned and fault != "activate-before"
    val cleared = activated and fault != "activate-after" and fault != "clear-before"
    val success = cleared and fault != "clear-after"
    s' = {
      ...s,
      durable: {
        pending: if (cleared) "none" else before.pending,
        active: before.active or activated,
        remote: if (ackApplied) "acknowledged" else before.remote,
      },
      previous: before,
      ackEver: s.ackEver or ackApplied,
      operation: "resume", fault: fault, targeted: false,
      result: if (before.pending == "none") "none"
        else if (success) "authenticated" else "error",
    }
  }

  action cancel(disconnect: bool, fault: str): bool = {
    val before = s.durable
    val targeted = before.pending != "none" or (disconnect and before.active)
    val needsJournal = before.pending == "activation" or
      (disconnect and before.active and before.pending == "none")
    val journaled = targeted and (not(needsJournal) or fault != "journal-before")
    val afterJournal = journaled and (not(needsJournal) or fault != "journal-after")
    val journalSucceeded = not(needsJournal) or
      (fault != "journal-before" and fault != "journal-after")
    val earlyCleared = journalSucceeded and disconnect and fault != "active-before"
    val earlySucceeded = not(disconnect) or
      (fault != "active-before" and fault != "active-after")
    val reachedRevoke = afterJournal and earlySucceeded
    val revoked = reachedRevoke and fault != "revoke-before"
    val confirmed = revoked and fault != "revoke-after"
    val mustClearLate = not(disconnect) and before.active
    val lateCleared = confirmed and mustClearLate and fault != "active-before"
    val reachedClear = journalSucceeded and earlySucceeded and
      (not(targeted) or (confirmed and
        (not(mustClearLate) or (lateCleared and fault != "active-after"))))
    val cleared = reachedClear and fault != "clear-before"
    val success = cleared and fault != "clear-after"
    s' = {
      ...s,
      durable: {
        pending: if (cleared) "none"
          else if (journaled) "revocation" else before.pending,
        active: before.active and not(earlyCleared or lateCleared),
        remote: if (revoked) "revoked" else before.remote,
      },
      previous: before,
      cancelLogged: s.cancelLogged or journaled,
      revokeConfirmed: s.revokeConfirmed or confirmed,
      operation: if (disconnect) "disconnect" else "cancel",
      fault: fault, targeted: targeted,
      result: if (success) "cancelled" else "error",
    }
  }

  // Cancel at clear observes an already committed activation whose receipt
  // has been removed. Plain cancel preserves that active credential. At the
  // earlier cuts the durable receipt remains and cancel revokes that exact key.
  action cancelDuringResume(cut: str): bool = all {
    s.durable.pending == "activation",
    s.bindingMatches,
    s.durable.remote == "acknowledged" or
      (s.durable.remote == "issued" and s.now < 2),
    val afterAck = cut != "read"
    val committed = cut == "activate-commit" or cut == "clear"
    val receiptGone = cut == "clear"
    s' = {
      ...s,
      durable: {
        pending: "none",
        active: receiptGone,
        remote: if (receiptGone) "acknowledged" else "revoked",
      },
      previous: s.durable,
      ackEver: s.ackEver or afterAck or committed,
      cancelLogged: not(receiptGone),
      revokeConfirmed: not(receiptGone),
      operation: "race", fault: cut, result: "cancelled",
      targeted: not(receiptGone),
    },
  }

  action restart = s' = {
    ...s, previous: s.durable, operation: "restart", fault: "none",
    result: "none", targeted: false,
  }
  action tick = all {
    s.now < 3,
    s' = {
      ...s, now: s.now + 1, previous: s.durable,
      operation: "tick", fault: "none", result: "none", targeted: false,
    },
  }
  action step = {
    any {
      {
        nondet fault = resumeFaults.oneOf()
        resume(fault)
      },
      {
        nondet fault = cancelFaults.oneOf()
        nondet disconnect = Set(false, true).oneOf()
        cancel(disconnect, fault)
      },
      {
        nondet cut = raceCuts.oneOf()
        cancelDuringResume(cut)
      },
      restart,
      tick,
    }
  }

  val TypeOK = and {
    s.durable.pending.in(Set("activation", "revocation", "none")),
    s.durable.remote.in(Set("issued", "acknowledged", "revoked")),
    s.now.in(0.to(3)),
  }
  val ActivateOnlyAcknowledged = s.durable.active.implies(s.ackEver)
  val DurableCancelCannotResume = s.cancelLogged.implies(s.durable.pending != "activation")
  val ConfirmedCancellationClearsTarget =
    (s.result == "cancelled" and s.targeted).implies(not(s.durable.active))
  val ClearedCancellationHasReceipt =
    (s.cancelLogged and s.durable.pending == "none").implies(
      s.revokeConfirmed and not(s.durable.active))
  val RefusedResumeHasNoEffects =
    (s.operation == "resume" and
      (s.previous.pending != "activation" or not(s.bindingMatches)))
      .implies(s.durable == s.previous)
  val RestartPreservesDurableState =
    (s.operation == "restart").implies(s.durable == s.previous)
  val invariant = TypeOK and ActivateOnlyAcknowledged and DurableCancelCannotResume and
    ConfirmedCancellationClearsTarget and ClearedCancellationHasReceipt and
    RefusedResumeHasNoEffects and RestartPreservesDurableState

  // Successful retry includes completed network/storage effects. No progress
  // is asserted while those effects fail forever or the caller never retries.
  temporal RetriedCancellationCompletes = cancel(false, "none").weakFair(s).implies(
    always((s.durable.pending == "revocation").implies(eventually(
      s.durable.pending == "none" and not(s.durable.active)))))

  run lostAckReplaysPastDeadlineTest = initial(false, false, true)
    .then(resume("ack-after")).then(tick).then(tick).then(resume("none"))
    .expect(s.result == "authenticated" and s.durable.active)
  run unacknowledgedExpiryPreservesReceiptTest = initial(false, false, true)
    .then(tick).then(tick).then(resume("none"))
    .expect(s.result == "error" and s.durable.pending == "activation")
  run lostRevokeCannotReactivateTest = initial(true, true, true)
    .then(cancel(false, "revoke-after")).then(restart).then(resume("none"))
    .expect(s.result == "error" and s.durable.active and s.durable.pending == "revocation")
  run durableCancelRetryClearsTest = initial(true, true, true)
    .then(cancel(false, "revoke-after")).then(restart).then(cancel(false, "none"))
    .expect(s.result == "cancelled" and not(s.durable.active))
  run cancelBeforeCommitRevokesTest = initial(false, false, true)
    .then(cancelDuringResume("activate"))
    .expect(s.durable.remote == "revoked" and not(s.durable.active))
  run cancelAfterReceiptRemovalPreservesCommittedKeyTest = initial(false, false, true)
    .then(cancelDuringResume("clear"))
    .expect(s.durable.remote == "acknowledged" and s.durable.active)
}
