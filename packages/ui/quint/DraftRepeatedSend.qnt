// Two complete send rounds. Each starts two concurrent hold calls against the
// same queue, pauses the winning mark, and then checks settlement and recovery.
module DraftRepeatedSend {
  type State = {
    phase: int,
    round: int,
    event: str,
    editor: str,
    saved: str,
    marked: bool,
    held: bool,
    conflict: bool,
    authority: bool,
    mutation: str,
    fault: str,
    outcome: str,
    accepted: int,
    rejected: int
  }
  var s: State
  pure def text(round: int): str = if (round == 0) "first" else "second"
  action init = s' = {
    phase: 0, round: 0, event: "init", editor: "first", saved: "first",
    marked: false, held: false, conflict: false, authority: true,
    mutation: "none", fault: "ok", outcome: "none", accepted: 0, rejected: 0
  }
  action begin = all {
    s.phase == 0,
    s' = { ...s, phase: 1, event: "begin", held: true, rejected: 1 }
  }
  action interleave(mutation: str): bool = all {
    s.phase == 1,
    s' = {
      ...s, phase: 2, event: "interleave", mutation: mutation,
      editor: if (mutation == "edit") "new" else s.editor,
      authority: mutation != "revoke"
    }
  }
  action finishMark(fault: str): bool = {
    val accepted = fault == "ok" and s.mutation == "none"
    val failure = fault == "before" or fault == "after"
    all {
      s.phase == 2,
      s' = {
        ...s, phase: 3, event: "finish-mark", fault: fault,
        accepted: if (accepted) 1 else 0,
        rejected: if (accepted) 1 else 2,
        held: accepted,
        editor: if (accepted) "" else s.editor,
        saved: if (fault == "ok" and not(accepted)) s.editor else s.saved,
        marked: accepted or fault == "after",
        conflict: failure
      }
    }
  }
  action settle(outcome: str, typed: bool): bool = {
    val remaining = if (typed) "new" else ""
    val restored = if (not(typed)) text(s.round)
      else if (s.round == 0) "first+new" else "second+new"
    all {
      s.phase == 3,
      s' = if (s.held) {
        ...s, phase: 4, event: "settle", outcome: outcome,
        editor: if (outcome == "not-dispatched") restored else remaining,
        saved: if (outcome == "not-dispatched") restored else remaining,
        marked: false, held: false
      } else { ...s, phase: 4, event: "settle", outcome: "none" }
    }
  }
  // A new round explicitly reads the current receipt, reviews any send marker,
  // then writes the second draft. An old failed mark never grants admission.
  action nextRound = all {
    s.phase == 4, s.round == 0,
    s' = {
      ...s, phase: 0, round: 1, event: "next-round",
      editor: "second", saved: "second", marked: false, held: false,
      conflict: false, authority: true, mutation: "none", fault: "ok",
      outcome: "none", accepted: 0, rejected: 0
    }
  }
  action done = all { s.phase == 4, s.round == 1, s' = s }
  action step = any {
    begin,
    { nondet mutation = Set("none", "edit", "revoke").oneOf()
      interleave(mutation) },
    { nondet fault = Set("ok", "before", "after", "too-large").oneOf()
      finishMark(fault) },
    { nondet outcome = Set("not-dispatched", "dispatched", "unknown").oneOf()
      nondet typed = Set(true, false).oneOf()
      settle(outcome, typed) },
    nextRound, done
  }
  val invariant = all {
    s.round.in(Set(0, 1)), s.phase >= 0, s.phase <= 4,
    s.accepted >= 0, s.accepted <= 1,
    s.phase >= 3 implies s.accepted + s.rejected == 2,
    s.phase == 3 and s.held implies s.marked and s.accepted == 1,
    s.outcome == "unknown" or s.outcome == "dispatched" implies not(s.marked) and not(s.held),
    s.phase == 4 implies not(s.held)
  }
  run repeatedAdmissionsAreExclusiveTest = init.then(begin).then(interleave("none"))
    .then(finishMark("ok")).then(settle("unknown", false)).then(nextRound)
    .then(begin).then(interleave("none")).then(finishMark("ok"))
    .expect(s.accepted == 1 and s.rejected == 1 and invariant)
  run lostAckRequiresRecoveryBeforeNextSendTest = init.then(begin).then(interleave("none"))
    .then(finishMark("after")).expect(s.conflict and s.marked and s.accepted == 0)
    .then(settle("unknown", false)).then(nextRound).then(begin)
    .then(interleave("revoke")).then(finishMark("ok"))
    .expect(s.rejected == 2 and not(s.marked) and invariant)
}
