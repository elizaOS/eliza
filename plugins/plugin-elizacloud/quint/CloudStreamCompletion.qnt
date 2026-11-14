// Five finite SSE replies: empty completion, full-text completion, error,
// partial text followed by error, and an error without a message.
module CloudStreamCompletion {
  var scenario: int
  var phase: int
  var shown: int
  var rejected: bool
  var completed: bool
  var fallbackRequests: int
  action init = {
    nondet choice = Set(0, 1, 2, 3, 4).oneOf()
    all {
      scenario' = choice, phase' = 0, shown' = 0,
      rejected' = false, completed' = false, fallbackRequests' = 0
    }
  }
  action frames = all {
    phase == 0, phase' = 1, scenario' = scenario,
    shown' = if (scenario == 1 or scenario == 3) 1 else 0,
    rejected' = rejected, completed' = completed,
    fallbackRequests' = fallbackRequests
  }
  action settle = all {
    phase == 1, phase' = 2, scenario' = scenario, shown' = shown,
    rejected' = scenario != 1, completed' = scenario == 1,
    fallbackRequests' = 0
  }
  action settled = all {
    phase == 2, phase' = phase, scenario' = scenario, shown' = shown,
    rejected' = rejected, completed' = completed,
    fallbackRequests' = fallbackRequests
  }
  action step = any { frames, settle, settled }
  val ErrorCannotComplete = scenario < 2 or not(completed)
  val EmptyCannotComplete = scenario != 0 or not(completed)
  val NoFallbackResend = fallbackRequests == 0
  val PartialTextRetained = phase == 0 or scenario != 3 or shown == 1
  temporal Finishes = and {
    frames.weakFair((scenario, phase, shown, rejected, completed, fallbackRequests)),
    settle.weakFair((scenario, phase, shown, rejected, completed, fallbackRequests))
  }.implies(eventually(phase == 2))
}
