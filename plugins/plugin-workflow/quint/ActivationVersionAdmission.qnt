// workflow.ts normalizes the optional expected version before the existing
// embedded service commits the exact version. One same-owner concurrent edit.
module ActivationVersionAdmission {
  var s: { phase: int, form: int, owned: bool, current: int,
    edited: bool, writes: int, qualified: bool, receiptVersion: int }
  // form: 0 = omitted legacy field, 1 = selected version zero, 2 = malformed.
  action initialize(form: int, owned: bool): bool = s' = {
    phase: 0, form: form, owned: owned, current: 0, edited: false,
    writes: 0, qualified: true, receiptVersion: -1,
  }
  action init = {
    nondet form = 0.to(2).oneOf()
    nondet owned = Set(false, true).oneOf()
    initialize(form, owned)
  }
  action validate = all { s.phase == 0,
    s' = s.with("phase", if (s.owned and s.form != 2) 1 else 3) }
  action concurrentEdit = all { not(s.edited), s.current < 2,
    s' = s.with("edited", true).with("current", s.current + 1) }
  action commit = all { s.phase == 1,
    val allowed = s.form == 0 or s.current == 0
    s' = if (allowed)
      s.with("phase", 2).with("writes", 1)
        .with("qualified", s.owned and s.form != 2 and (s.form == 0 or s.current == 0))
        .with("current", s.current + 1).with("receiptVersion", s.current + 1)
      else s.with("phase", 3),
  }
  // A lost response never re-runs the mutation or replaces its saved version.
  action reply = all { s.phase == 2, s' = s.with("phase", 3) }
  action advance = any { validate, commit, reply }
  action step = any { advance, concurrentEdit, s' = s }
  val TypeOK = s.phase.in(0.to(3)) and s.form.in(0.to(2))
    and s.current.in(0.to(2)) and s.writes.in(0.to(1))
  val OnlyAdmittedVersionChanges = s.qualified
  val MalformedNeverMutates = s.form == 2 implies s.writes == 0
  val ForeignOwnerNeverMutates = not(s.owned) implies s.writes == 0
  val ReceiptNamesCommittedVersion = s.writes == 1 implies
    s.receiptVersion > 0 and s.receiptVersion <= s.current
  temporal Settles = (s.phase < 3).leadsTo(s.phase == 3)
  temporal FairSettlement = advance.weakFair(s) implies Settles
  run malformedCannotBecomeLegacyTest = initialize(2, true).then(validate)
    .expect(s.phase == 3 and s.writes == 0)
  run selectedVersionRefusesConcurrentEditTest = initialize(1, true)
    .then(validate).then(concurrentEdit).then(commit)
    .expect(s.phase == 3 and s.writes == 0)
  run legacyOmissionKeepsItsContractTest = initialize(0, true)
    .then(validate).then(concurrentEdit).then(commit).then(reply)
    .expect(s.writes == 1 and s.receiptVersion == 2)
  run receiptDoesNotFollowLaterVersionTest = initialize(1, true)
    .then(validate).then(commit).then(concurrentEdit).then(reply)
    .expect(s.writes == 1 and s.receiptVersion == 1 and s.current == 2)
}
