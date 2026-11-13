// virtual-filesystem.ts rollback journal: old tree retained until atomic marker;
// recovery selects old or new tree by committed marker, including interruption.
module services_vfs {
  var s: { phase: str, live: int, previous: int, target: int, stage: bool, backup: bool, marker: bool, locked: bool }
  action init = s' = { phase: "idle", live: 1, previous: 1, target: 2, stage: false, backup: false, marker: false, locked: false }
  action prepare = all { s.phase == "idle", s' = s.with("phase", "staged").with("stage", true).with("locked", true).with("marker", false).with("previous", s.live).with("target", if (s.live == 1) 2 else 1) }
  action saveOld = all { s.phase == "staged", s' = s.with("phase", "saved").with("backup", true).with("live", 0) }
  action publish = all { s.phase == "saved", s' = s.with("phase", "published").with("stage", false).with("live", s.target) }
  action commit = all { s.phase == "published", s' = s.with("phase", "committed").with("marker", true) }
  action recover = all { s.phase != "idle", s' = { phase: "idle", live: if (s.marker) s.target else s.previous, previous: s.previous, target: s.target, stage: false, backup: false, marker: s.marker, locked: false } }
  action keep = s' = s
  action step = any { prepare, saveOld, publish, commit, recover, keep }
  val safety = all { s.live.in(Set(0,1,2)), s.previous.in(Set(1,2)), s.target.in(Set(1,2)), s.phase == "idle" implies s.live != 0 and not(s.locked or s.backup or s.stage), s.phase == "saved" implies s.backup and s.stage and s.live == 0, s.phase == "published" implies s.backup and s.live == s.target, s.phase != "idle" implies s.locked }
  run interruptedPublishRestoresOldTest = init.then(prepare).then(saveOld).then(publish).then(recover).expect(s.live == 1)
  run committedRestoreKeepsNewTest = init.then(prepare).then(saveOld).then(publish).then(commit).then(recover).expect(s.live == 2)
  run secondRollbackRestoresActualPreviousTreeTest = init.then(prepare).then(saveOld).then(publish).then(commit).then(recover).then(prepare).then(saveOld).then(publish).then(recover).expect(s.live == 2)
}
