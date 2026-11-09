// agent-backup-restore-v3-{generation,commit,promotion,serving-controller,
// restored-runtime}.ts: a durable commit intent precedes rename; both parent
// syncs precede receipt; boot consumes a separate grant. A commit is not routing authority.
module services_restore_generation {
  var s: { phase: str, validated: bool, intent: bool, moved: bool, synced: bool, receipt: bool, bootGrant: bool, consumed: bool, runtime: bool, stopped: bool }
  action init = s' = { phase: "candidate", validated: false, intent: false, moved: false, synced: false, receipt: false, bootGrant: false, consumed: false, runtime: false, stopped: false }
  action validate = all { s.phase == "candidate", s' = s.with("phase", "prepared").with("validated", true) }
  action intent = all { s.phase == "prepared", s.validated, s' = s.with("phase", "intent").with("intent", true) }
  action rename = all { s.phase == "intent", s.intent, s' = s.with("phase", "moved").with("moved", true) }
  action syncParents = all { s.phase == "moved", s' = s.with("phase", "synced").with("synced", true) }
  action receipt = all { s.phase == "synced", s' = s.with("phase", "committed").with("receipt", true) }
  action grant = all { s.receipt, not(s.consumed or s.stopped), s' = s.with("bootGrant", true) }
  action consumeGrant = all { s.bootGrant, not(s.consumed or s.stopped), s' = s.with("bootGrant", false).with("consumed", true) }
  action boot = all { s.receipt, s.consumed, not(s.stopped), s' = s.with("runtime", true) }
  action stop = s' = s.with("runtime", false).with("stopped", true).with("bootGrant", false)
  action lostReply = s' = s
  action keep = s' = s
  action step = any { validate, intent, rename, syncParents, receipt, grant, consumeGrant, boot, stop, lostReply, keep }
  val safety = all { s.moved implies s.intent and s.validated, s.synced implies s.moved, s.receipt implies s.synced, s.consumed implies s.receipt, s.runtime implies s.consumed and s.receipt and not(s.stopped), s.bootGrant implies s.receipt and not(s.consumed or s.stopped) }
  run lostReplyReplayUsesSameIntentTest = init.then(validate).then(intent).then(rename).then(lostReply).then(syncParents).then(receipt).expect(s.receipt and not(s.runtime))
  run bootNeedsSeparateGrantTest = init.then(validate).then(intent).then(rename).then(syncParents).then(receipt).then(grant).then(consumeGrant).then(boot).expect(s.runtime and not(s.bootGrant)).then(stop).expect(not(s.runtime))
}
