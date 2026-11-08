// A host can reject after applying the consume clear while storage also refuses
// rollback. The retained original must remain reachable through conflict review.
module DraftConsumeRetention {
  type State = {
    phase: int,
    event: str,
    fault: str,
    readFailure: bool,
    editor: str,
    stored: str,
    record: str,
    currentReceipt: bool,
    offered: str,
    conflict: bool,
    error: bool,
    consuming: bool,
    choice: str,
    secondChoice: str,
    discarded: bool,
    foreign: bool,
    approvedForeign: bool
  }
  var s: State

  pure def initialState(fault: str, readFailure: bool): State = {
    phase: 0, event: "init", fault: fault, readFailure: readFailure,
    editor: "reviewed", stored: "reviewed", record: "reviewed",
    currentReceipt: true, offered: "", conflict: false, error: false,
    consuming: false, choice: "none", secondChoice: "none",
    discarded: false, foreign: false, approvedForeign: false
  }
  action init = {
    nondet fault = Set("before", "after", "external").oneOf()
    nondet readFailure = Set(true, false).oneOf()
    s' = initialState(fault, readFailure)
  }
  action initCase(fault: str, readFailure: bool): bool =
    s' = initialState(fault, readFailure)

  action begin = all {
    s.phase == 0,
    s' = {
      ...s, phase: 1, event: "begin", stored: "", record: "",
      consuming: true
    }
  }
  action rejectAfterApply = {
    val stored = if (s.fault == "before") ""
      else if (s.fault == "after") "reviewed" else "external"
    all {
      s.phase == 1,
      s' = {
        ...s, phase: 2, event: "host-rejected", editor: "", stored: stored,
        record: if (s.readFailure) "" else stored,
        currentReceipt: not(s.readFailure) or s.fault == "before",
        offered: "reviewed", conflict: true,
        error: s.readFailure or stored != "reviewed",
        consuming: false, foreign: s.fault == "external"
      }
    }
  }

  pure def review(previous: State, choice: str): State =
    if (choice == "none" or not(previous.conflict)) previous
    else if (choice == "keep") {
      ...previous, discarded: previous.discarded or previous.editor != "reviewed",
      stored: if (previous.record == previous.offered) previous.editor else previous.stored,
      record: if (previous.record == previous.offered) previous.editor else previous.record,
      offered: if (previous.record != previous.offered and previous.record != "")
        previous.record else previous.offered,
      conflict: previous.record != previous.offered and previous.record != "",
      error: if (previous.record != previous.offered and previous.record != "")
        previous.error else not(previous.currentReceipt) and previous.error
    } else if (previous.record != previous.offered and previous.record != "") {
      ...previous, editor: previous.offered, offered: previous.record
    } else if (previous.record == previous.offered) {
      ...previous, editor: previous.offered, conflict: false, error: false
    } else if (previous.currentReceipt) {
      ...previous, editor: previous.offered, stored: previous.offered,
      record: previous.offered, conflict: false, error: false
    } else {
      ...previous, editor: previous.offered, conflict: false, error: true
    }

  action choose(choice: str): bool = all {
    s.phase == 2,
    s' = { ...review(s, choice), phase: 3, event: "review", choice: choice }
  }

  // An external stored copy is only replaced after it has been offered in the
  // current review. The first local-backup choice cannot authorize that write.
  action chooseAgain(choice: str): bool = {
    val canReview = s.choice != "none" and s.conflict and s.offered == "external"
    all {
      s.phase == 3,
      s' = if (not(canReview) or choice == "none") {
        ...s, phase: 4, event: "review-again", secondChoice: choice
      } else if (choice == "restore") {
        ...s, phase: 4, event: "review-again", secondChoice: choice,
        editor: "external", conflict: false, error: false, discarded: true
      } else {
        ...s, phase: 4, event: "review-again", secondChoice: choice,
        stored: s.editor, record: s.editor, conflict: false, error: false,
        approvedForeign: true
      }
    }
  }
  action step = any {
    begin, rejectAfterApply,
    { nondet choice = Set("none", "keep", "restore").oneOf()
      choose(choice) },
    { nondet choice = Set("none", "keep", "restore").oneOf()
      chooseAgain(choice) },
    all { s.phase == 4, s' = s }
  }
  val invariant = all {
    s.phase >= 0, s.phase <= 4,
    not(s.discarded) implies s.editor == "reviewed" or s.stored == "reviewed" or
      (s.conflict and s.offered == "reviewed"),
    s.foreign and not(s.approvedForeign) implies s.stored == "external",
    s.phase >= 2 implies not(s.consuming)
  }
  run retainedAfterDoubleFailureTest = initCase("before", false)
    .then(begin).then(rejectAfterApply).expect(s.offered == "reviewed" and invariant)
    .then(choose("restore")).expect(s.editor == "reviewed" and s.stored == "reviewed")
  run externalCopyNeedsItsOwnReviewTest = initCase("external", false)
    .then(begin).then(rejectAfterApply).then(choose("restore"))
    .expect(s.editor == "reviewed" and s.stored == "external" and s.conflict)
    .then(chooseAgain("keep")).expect(s.stored == "reviewed" and invariant)
}
