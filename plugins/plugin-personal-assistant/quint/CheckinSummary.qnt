// A summary is stored only after the configured model returns nonempty text.
module CheckinSummary {
  var outcome: int
  var phase: int
  var called: bool
  var writes: int

  action init = {
    nondet result = Set(0, 1, 2, 3, 4).oneOf()
    all { outcome' = result, phase' = 0, called' = false, writes' = 0 }
  }
  action collect = all {
    phase == 0, outcome' = outcome, phase' = 1,
    called' = called, writes' = writes
  }
  action render = all {
    phase == 1, outcome' = outcome,
    phase' = if (outcome == 0 or outcome == 4) 2 else 4,
    called' = outcome != 2, writes' = writes
  }
  action persist = all {
    phase == 2, outcome' = outcome,
    phase' = if (outcome == 0) 3 else 4,
    called' = called, writes' = if (outcome == 0) 1 else 0
  }
  action stay = all {
    phase == 3 or phase == 4, outcome' = outcome, phase' = phase,
    called' = called, writes' = writes
  }
  action step = any { collect, render, persist, stay }
  val ValidSummaryOnly = writes == 0 or (outcome == 0 and called and phase == 3)
  val FailureKeepsStorage = outcome == 0 or writes == 0
  val SingleWrite = writes >= 0 and writes <= 1
}
