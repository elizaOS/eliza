// Finite domain permits three owner epochs and five read sequence values.
// Exact ownerFenceStep, including older reads for the same current owner.
// Null owner is 0, two distinct authenticated owners are 1 and 2.
module TaskOwnerFence {
  var s: {
    epoch: int,
    owner: int,
    settled: int,
    closed: bool,
    decision: str,
    revoke: bool,
    previousEpoch: int,
    previousOwner: int,
    previousSettled: int,
    previousClosed: bool,
    confirmed: bool,
    account: int,
    started: int,
    sequence: int
  }
  action init = s' = {
    epoch: 0,
    owner: 0,
    settled: 0,
    closed: false,
    decision: "init",
    revoke: false,
    previousEpoch: 0,
    previousOwner: 0,
    previousSettled: 0,
    previousClosed: false,
    confirmed: false,
    account: 0,
    started: 0,
    sequence: 0
  }
  action read(account: int, sequence: int, started: int, confirmed: bool): bool = {
    val base = s
      .with("previousEpoch", s.epoch)
      .with("previousOwner", s.owner)
      .with("previousSettled", s.settled)
      .with("previousClosed", s.closed)
      .with("confirmed", confirmed)
      .with("account", account)
      .with("started", started)
      .with("sequence", sequence)
    val stale = s.closed or started != s.epoch or (sequence < s.settled and (account == 0 or account != s.owner))
    val revokes = s.owner != 0 and account != s.owner
    all {
      stale or (not(revokes or account == 0)) or s.epoch < 3,
      s' = if (stale) base
        .with("decision", "superseded")
        .with("revoke", false)
      else if (revokes and not(confirmed)) base
        .with("decision", "confirm")
        .with("revoke", false)
      else base
        .with("epoch", s.epoch + (if (revokes or account == 0) 1 else 0))
        .with("owner", account)
        .with("settled", if (sequence > s.settled) sequence else s.settled)
        .with("decision", if (account == 0) "signed-out" else "accepted")
        .with("revoke", revokes or account == 0)
    }
  }
  action retire(close: bool): bool = all {
    s.epoch < 3,
    s' = s
      .with("previousEpoch", s.epoch)
      .with("previousOwner", s.owner)
      .with("previousSettled", s.settled)
      .with("previousClosed", s.closed)
      .with("epoch", s.epoch + 1)
      .with("owner", 0)
      .with("closed", s.closed or close)
      .with("decision", "retired")
      .with("revoke", true)
  }
  action step = {
    nondet account = Set(0, 1, 2).oneOf();
    nondet sequence = 0.to(4).oneOf();
    nondet offset = Set(-1, 0, 1).oneOf();
    nondet confirmed = Set(true, false).oneOf();
    any {
      read(account, sequence, s.epoch + offset, confirmed),
      retire(confirmed)
    }
  }
  val invariant = and {
    s.epoch >= s.previousEpoch,
    s.settled >= s.previousSettled,
    s.previousClosed implies s.closed,
    (s.decision == "superseded" or s.decision == "confirm") implies (s.epoch == s.previousEpoch and s.owner == s.previousOwner and not(s.revoke)),
    (s.decision == "accepted" and s.previousOwner != 0 and s.owner != s.previousOwner) implies (s.confirmed and s.revoke and s.epoch == s.previousEpoch + 1),
    (s.decision == "accepted") implies (not(s.previousClosed) and s.started == s.previousEpoch)
  }
}
