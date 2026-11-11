// One owned task, a saved revision, a concurrent execution and two recovery calls.
module TriggerRecovery {
  var s: {archived: bool, erased: bool, enabled: bool, lock: str, phase: str, rev: int, expected: int, history: int, intent: str, owner: bool}
  action init = s' = {archived: false, erased: false, enabled: true, lock: "free", phase: "idle", rev: 0, expected: 0, history: 0, intent: "archive", owner: true}
  action startRun = all {s.lock == "free", not(s.erased), not(s.archived), s.enabled, s.history < 2, s' = {...s, lock: "run"}}
  action finishRun = all {s.lock == "run", s' = {...s, lock: "free", history: s.history + 1, rev: s.rev + 1}}
  action choose(intent: str, owner: bool): bool = all {s.phase == "idle", not(s.erased), s.rev < 4, s' = {...s, intent: intent, expected: s.rev, owner: owner, phase: "selected"}}
  action peerEdit = all {s.lock == "free", s.phase == "selected", s.rev < 4, s' = {...s, rev: s.rev + 1}}
  action claim = all {s.phase == "selected", s.lock == "free", s.owner, s' = {...s, lock: "mutation", phase: "checking"}}
  action refuse = all {s.phase == "selected", not(s.owner) or s.lock != "free", s' = {...s, phase: "idle"}}
  action check = all {s.phase == "checking", s' = if (s.expected == s.rev and (s.intent != "erase" or s.archived)) {...s, phase: "writing"} else {...s, phase: "idle", lock: "free"}}
  action commit = all {s.phase == "writing", s' = {...s, archived: s.intent == "archive", erased: s.intent == "erase", enabled: false, rev: s.rev + 1, phase: "reply"}}
  action settle = all {s.phase == "reply", s' = {...s, lock: "free", phase: "idle"}}
  action rejectWrite = all {s.phase == "writing", s' = {...s, lock: "free", phase: "idle"}}
  action step = any {startRun, finishRun, choose("archive",true), choose("restore",true), choose("erase",true), choose("archive",false), peerEdit, claim, refuse, check, commit, settle, rejectWrite, s' = s}
  val Safety = and {
    s.archived.implies(not(s.enabled)),
    s.erased.implies(not(s.enabled) and not(s.archived)),
    (s.lock == "run").implies(not(s.archived)),
    (s.phase == "writing").implies(s.owner and s.expected == s.rev and s.lock == "mutation"),
    s.history >= 0 and s.history <= 2,
  }
  val settling = s.phase == "reply"
  temporal RepliesSettle = settle.weakFair(s).implies(settling.leadsTo(s.phase == "idle"))
  run archiveKeepsTask = init.then(choose("archive",true)).then(claim).then(check).then(commit).then(settle).expect(s.archived and s.history == 0 and Safety)
  run staleSelectionRefused = init.then(choose("archive",true)).then(peerEdit).then(claim).then(check).expect(not(s.archived) and s.lock == "free" and Safety)
  run runningTaskRefusesArchive = init.then(startRun).then(choose("archive",true)).then(refuse).expect(not(s.archived) and s.lock == "run" and Safety)
  run restoredTaskStaysInactive = init.then(choose("archive",true)).then(claim).then(check).then(commit).then(settle).then(choose("restore",true)).then(claim).then(check).then(commit).then(settle).expect(not(s.archived) and not(s.enabled) and Safety)
  run erasedTaskStaysGone = init.then(choose("archive",true)).then(claim).then(check).then(commit).then(settle).then(choose("erase",true)).then(claim).then(check).then(commit).then(settle).expect(s.erased and not(s.enabled) and Safety)
}
