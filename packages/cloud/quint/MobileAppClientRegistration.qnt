// Shared database registration admission used by configuration, credential,
// renewal, and hosted callback entrypoints. PKCE and renewal session state
// retain their separate lifecycle models.
module MobileAppClientRegistration {
  type Policy = { databaseAvailable: bool, clientPresent: bool, clientEnabled: bool,
    appActive: bool, appApproved: bool, enabledExactly: bool, environmentValid: bool,
    callbackValid: bool, originAllowed: bool, ttlValid: bool, grantMatches: bool }
  var policy: Policy
  var entrypoint: str
  var admitted: bool
  pure val allowedPaths = Set("registration", "credential", "renewal", "callback")
  pure val validPolicy = { databaseAvailable: true, clientPresent: true, clientEnabled: true,
    appActive: true, appApproved: true, enabledExactly: true, environmentValid: true,
    callbackValid: true, originAllowed: true, ttlValid: true, grantMatches: true }
  pure def permits(p: Policy, path: str): bool = all {
    p.databaseAvailable, p.clientPresent, p.clientEnabled, p.appActive, p.appApproved,
    p.enabledExactly, p.environmentValid, p.callbackValid, p.originAllowed, p.ttlValid,
    path.in(allowedPaths),
    (path == "credential" or path == "renewal") implies p.grantMatches
  }
  action init = all { policy' = validPolicy, entrypoint' = "registration", admitted' = false }
  action configure(p: Policy, path: str): bool = all {
    policy' = p, entrypoint' = path, admitted' = false
  }
  action resolve = all { policy' = policy, entrypoint' = entrypoint, admitted' = permits(policy, entrypoint) }
  action step = any {
    resolve,
    {
      nondet databaseAvailable = Bool.oneOf(); nondet clientPresent = Bool.oneOf();
      nondet clientEnabled = Bool.oneOf(); nondet appActive = Bool.oneOf();
      nondet appApproved = Bool.oneOf(); nondet enabledExactly = Bool.oneOf();
      nondet environmentValid = Bool.oneOf(); nondet callbackValid = Bool.oneOf();
      nondet originAllowed = Bool.oneOf(); nondet ttlValid = Bool.oneOf();
      nondet grantMatches = Bool.oneOf(); nondet path = allowedPaths.oneOf();
      configure({ databaseAvailable: databaseAvailable, clientPresent: clientPresent,
        clientEnabled: clientEnabled, appActive: appActive, appApproved: appApproved,
        enabledExactly: enabledExactly, environmentValid: environmentValid,
        callbackValid: callbackValid, originAllowed: originAllowed, ttlValid: ttlValid,
        grantMatches: grantMatches }, path)
    }
  }
  val safety = admitted implies permits(policy, entrypoint)
  run validDbClientAuthorizedTest = init.then(resolve).expect(admitted)
  run disabledDbClientRefusedTest = init.then(configure(validPolicy.with("clientEnabled", false), "registration")).then(resolve).expect(not(admitted))
  run unapprovedAppDbClientRefusedTest = init.then(configure(validPolicy.with("appApproved", false), "callback")).then(resolve).expect(not(admitted))
  run mismatchedGrantRefusedTest = init.then(configure(validPolicy.with("grantMatches", false), "renewal")).then(resolve).expect(not(admitted))
  run absentDbClientRefusedTest = init.then(configure(validPolicy.with("clientPresent", false), "credential")).then(resolve).expect(not(admitted))
  run invalidEnvironmentRefusedTest = init.then(configure(validPolicy.with("environmentValid", false), "callback")).then(resolve).expect(not(admitted))
  run unsetEnableRefusedTest = init.then(configure(validPolicy.with("enabledExactly", false), "renewal")).then(resolve).expect(not(admitted))
  run databaseOutageRefusedTest = init.then(configure(validPolicy.with("databaseAvailable", false), "registration")).then(resolve).expect(not(admitted))
}
