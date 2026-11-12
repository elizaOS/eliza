// A summary is stored only after the configured model returns nonempty text.
module CheckinSummary {
  var outcome: int
  var phase: int
  var called: bool
  var writes: int
  var dateMatches: bool

  action init = {
    nondet result = Set(0, 1, 2, 3, 4, 5).oneOf()
    all { outcome' = result, phase' = 0, called' = false, writes' = 0, dateMatches' = result != 5 }
  }
  action collect = all {
    phase == 0, outcome' = outcome, phase' = 1,
    called' = called, writes' = writes, dateMatches' = dateMatches
  }
  action render = all {
    phase == 1, outcome' = outcome,
    phase' = if (outcome == 0 or outcome == 4) 2 else 4,
    called' = outcome != 2, writes' = writes, dateMatches' = dateMatches
  }
  action persist = all {
    phase == 2, outcome' = outcome,
    phase' = if (outcome == 0) 3 else 4,
    called' = called, writes' = if (outcome == 0) 1 else 0, dateMatches' = dateMatches
  }
  action stay = all {
    phase == 3 or phase == 4, outcome' = outcome, phase' = phase,
    called' = called, writes' = writes, dateMatches' = dateMatches
  }
  action step = any { collect, render, persist, stay }
  val ValidSummaryOnly = writes == 0 or (outcome == 0 and called and phase == 3)
  val FailureKeepsStorage = outcome == 0 or writes == 0
  val StoredDayMatches = writes == 0 or dateMatches
  val SingleWrite = writes >= 0 and writes <= 1
}
