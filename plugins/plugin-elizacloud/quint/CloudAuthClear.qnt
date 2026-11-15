// One already-authorized autonomous disconnect, with no remote manager.
// The host's synchronous config writer either succeeds or reports failure.
module CloudAuthClear {
  var scenario: int
  var phase: int
  var authenticated: bool
  var configKey: bool
  var response: int

  action init = {
    nondet choice = Set(0, 1, 2, 3).oneOf()
    all {
      scenario' = choice, phase' = 0,
      authenticated' = choice % 2 == 1, configKey' = choice % 2 == 1,
      response' = 0
    }
  }
  action clear = all {
    phase == 0, phase' = 1, scenario' = scenario,
    authenticated' = false, configKey' = false, response' = response
  }
  action save = all {
    phase == 1, phase' = 2, scenario' = scenario,
    authenticated' = authenticated, configKey' = configKey,
    response' = if (scenario >= 2) 500 else 0
  }
  action reply = all {
    phase == 2, phase' = 3, scenario' = scenario,
    authenticated' = authenticated, configKey' = configKey,
    response' = if (response == 0) 200 else response
  }
  action settled = all {
    phase == 3, phase' = phase, scenario' = scenario,
    authenticated' = authenticated, configKey' = configKey, response' = response
  }
  action step = any { clear, save, reply, settled }
  val ClearedBeforeSave = phase == 0 or (not(authenticated) and not(configKey))
  val SuccessfulReplyIsCleared = response != 200 or (phase == 3 and not(authenticated))
  val SaveFailureIsReported = scenario < 2 or response != 200
  temporal FairWork = and {
    clear.weakFair((scenario, phase, authenticated, configKey, response)),
    save.weakFair((scenario, phase, authenticated, configKey, response)),
    reply.weakFair((scenario, phase, authenticated, configKey, response))
  }
  temporal Finishes = FairWork.implies(eventually(phase == 3))
}
