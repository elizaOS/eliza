// The admitted text document already exists. One owner reads it, then either
// saves the returned text unchanged or closes the editor without a write.
module DocumentTextRoundTrip {
  pure def text(sample: int): str =
    if (sample == 0) "\n\n# Runbook\n\nRestart the worker.\n\n"
    else if (sample == 1) "\t  Keep this spacing.\r\n\r\n"
    else "\n  Café — 東京  \n"

  var sample: int
  var original: str
  var stored: str
  var observed: str
  var saveRequested: bool
  var saveRequests: int
  var phase: int

  action init = {
    nondet selected = Set(0, 1, 2).oneOf()
    nondet save = Set(false, true).oneOf()
    all {
      sample' = selected, original' = text(selected), stored' = text(selected),
      observed' = "", saveRequested' = save, saveRequests' = 0, phase' = 0
    }
  }
  action read = all {
    phase == 0, phase' = 1, observed' = stored,
    sample' = sample, original' = original, stored' = stored,
    saveRequested' = saveRequested, saveRequests' = saveRequests
  }
  action finish = all {
    phase == 1, phase' = 2,
    stored' = if (saveRequested) observed else stored,
    saveRequests' = if (saveRequested) 1 else 0,
    sample' = sample, original' = original, observed' = observed,
    saveRequested' = saveRequested
  }
  action reread = all {
    phase == 2, phase' = 3, observed' = stored,
    sample' = sample, original' = original, stored' = stored,
    saveRequested' = saveRequested, saveRequests' = saveRequests
  }
  action settled = all {
    phase == 3, phase' = phase, sample' = sample, original' = original,
    stored' = stored, observed' = observed, saveRequested' = saveRequested,
    saveRequests' = saveRequests
  }
  action step = any { read, finish, reread, settled }
  val StoredTextIsExact = stored == original
  val DetailTextIsExact = phase == 0 or observed == original
  val DiscardDoesNotSave = saveRequested or saveRequests == 0
  val SingleSaveRequest = saveRequests >= 0 and saveRequests <= 1
  // Progress requires the owner to finish the interaction and each admitted
  // read/write to return. Safety does not depend on these fairness assumptions.
  temporal FairWork = and {
    read.weakFair((sample, original, stored, observed, saveRequested, saveRequests, phase)),
    finish.weakFair((sample, original, stored, observed, saveRequested, saveRequests, phase)),
    reread.weakFair((sample, original, stored, observed, saveRequested, saveRequests, phase))
  }
  temporal Finishes = FairWork.implies(eventually(phase == 3))
}
