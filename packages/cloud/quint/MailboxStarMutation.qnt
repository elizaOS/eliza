// One reviewed star/unstar request with current owner, scope and message revision.
module MailboxStarMutation {
  var s: {phase: str, owner: bool, grant: bool, revision: int, reviewed: int, target: bool, starred: bool, inbox: bool, important: bool, calls: int}
  action init = s' = {phase: "idle", owner: true, grant: false, revision: 0, reviewed: -1, target: true, starred: false, inbox: true, important: true, calls: 0}
  action authorize = all {s.owner, s' = {...s, grant: true}}
  action prepare(target: bool): bool = all {s.phase == "idle", s.owner, s.grant, s' = {...s, phase: "review", target: target, reviewed: s.revision}}
  action changeRevision = all {s.revision < 2, s' = {...s, revision: s.revision+1}}
  action revoke = s' = {...s, grant: false}
  action replaceOwner = s' = {...s, owner: false}
  action dispatch = all {s.phase == "review", s.owner, s.grant, s.revision == s.reviewed, s' = {...s, phase: "sent", calls: 1, starred: s.target}}
  action lost = all {s.phase == "sent", s' = {...s, phase: "unknown"}}
  action observe = all {s.phase.in(Set("sent","unknown")), s' = {...s, phase: "done"}}
  action step = any {authorize,prepare(true),prepare(false),changeRevision,revoke,replaceOwner,dispatch,lost,observe,s' = s}
  val safety = s.calls <= 1 and s.inbox and s.important and (s.calls == 1 implies s.starred == s.target)
  run starKeepsOtherLabels = init.then(authorize).then(prepare(true)).then(dispatch).then(observe).expect(s.starred and safety)
  run unstarKeepsOtherLabels = init.then(authorize).then(prepare(false)).then(dispatch).then(observe).expect(not(s.starred) and safety)
  run lostReplyIsObserved = init.then(authorize).then(prepare(true)).then(dispatch).then(lost).then(observe).expect(s.calls == 1 and safety)
}
