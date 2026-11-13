// One browser LoginAuth instance. Repeated reads overlap one pending refresh.
// Scenarios include direct token custody and the existing HttpOnly proxy.
module AccessExpiryRecovery {
  var scenario: int
  var phase: int
  var requests: int
  var valid: bool
  var credential: bool
  var loggedOut: bool

  action init = {
    nondet choice = 0.to(8).oneOf()
    all {
      scenario' = choice, phase' = 0, requests' = 0,
      valid' = choice == 0, credential' = choice != 3, loggedOut' = false
    }
  }
  action read = all {
    phase == 0, phase' = 1, scenario' = scenario,
    requests' = if (scenario == 0 or scenario == 3) 0 else 1,
    valid' = valid, credential' = credential, loggedOut' = loggedOut
  }
  action repeatedRead = all {
    phase == 1, phase' = phase, scenario' = scenario,
    requests' = requests, valid' = valid, credential' = credential,
    loggedOut' = loggedOut
  }
  action signOut = all {
    phase == 1, scenario == 5, phase' = 2, scenario' = scenario,
    requests' = requests, valid' = false, credential' = false, loggedOut' = true
  }
  action settle = all {
    (phase == 1 and scenario != 5) or (phase == 2 and scenario == 5),
    phase' = 3, scenario' = scenario, requests' = requests,
    valid' = Set(0, 1, 6).contains(scenario),
    credential' = Set(0, 1, 4, 6, 8).contains(scenario),
    loggedOut' = loggedOut
  }
  action done = all {
    phase == 3, phase' = phase, scenario' = scenario,
    requests' = requests, valid' = valid, credential' = credential,
    loggedOut' = loggedOut
  }
  action step = any { read, repeatedRead, signOut, settle, done }
  val OneOverlappingRefresh = requests <= 1
  val ExpiryKeepsRecovery = phase != 1 or scenario == 3 or credential
  val SignOutStaysFinal = not(loggedOut) or (not(valid) and not(credential))
  val ValidSessionOnly = not(valid) or scenario == 0 or (phase == 3 and Set(1, 6).contains(scenario))
  val TransientKeepsRecovery = phase != 3 or not(Set(4, 8).contains(scenario)) or credential
  temporal Finishes = and {
    read.weakFair((scenario, phase, requests, valid, credential, loggedOut)),
    signOut.weakFair((scenario, phase, requests, valid, credential, loggedOut)),
    settle.weakFair((scenario, phase, requests, valid, credential, loggedOut))
  }.implies(eventually(phase == 3))
}
