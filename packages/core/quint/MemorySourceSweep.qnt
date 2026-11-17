// A stable three-row SQL snapshot: an embedding chunk, a document source
// referencing media, and an orphan source segment. Ordinary lists hide sources.
module MemorySourceSweep {
  pure val Rows = Set(1, 2, 3)
  var s: { phase: int, collected: Set[int], stored: Set[int], media: bool }
  action init = s' = { phase: 0, collected: Set(), stored: Rows, media: true }
  action readOrdinary = all {
    s.phase == 0, s' = { ...s, phase: 1, collected: Set(1) }
  }
  action readSources = all {
    s.phase == 1, s' = { ...s, phase: 2, collected: s.collected.union(Set(2, 3)) }
  }
  action collectMedia = all {
    s.phase == 2, s' = { ...s, phase: 3, media: s.collected.contains(2) }
  }
  action wipe = all {
    s.phase == 3, s' = { ...s, phase: 4, stored: s.stored.exclude(s.collected) }
  }
  action advance = any { readOrdinary, readSources, collectMedia, wipe }
  action step = any { advance, s' = s }
  val TypeOK = s.phase.in(0.to(4)) and s.collected.subseteq(Rows) and s.stored.subseteq(Rows)
  val CompleteSourceSet = s.phase >= 2 implies s.collected == Rows
  val SourceMediaRetained = s.media
  val WipeRemovesOrphans = s.phase == 4 implies s.stored == Set()
  temporal SweepFinishesWithoutFairness = (s.phase < 4).leadsTo(s.phase == 4)
  temporal SweepFinishes = advance.weakFair(s).implies(SweepFinishesWithoutFairness)
  action legacySkipSources = all {
    s.phase == 1, s' = { ...s, phase: 3, media: s.collected.contains(2) }
  }
  run sourceRowsProtectMediaAndWipeTest = init.then(readOrdinary).then(readSources)
    .expect(CompleteSourceSet).then(collectMedia).expect(SourceMediaRetained)
    .then(wipe).expect(WipeRemovesOrphans)
  run legacySweepDropsSourceMediaTest = init.then(readOrdinary).then(legacySkipSources)
    .expect(not(SourceMediaRetained) and not(CompleteSourceSet))
}
