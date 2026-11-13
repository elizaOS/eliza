// Shared database registration admission used by configuration, credential,
// renewal, and hosted callback entrypoints. PKCE and renewal session state
// retain their separate lifecycle models.
module MobileAppClientRegistration {
  type Policy = { databaseAvailable: bool, clientPresent: bool, clientEnabled: bool,
    appActive: bool, appApproved: bool, enabledExactly: bool, environmentValid: bool,
    callbackValid: bool, exactCallbackAllowed: bool, ttlValid: bool, grantMatches: bool,
    androidAssociationValid: bool }
  var policy: Policy
  var entrypoint: str
  var admitted: bool
  pure val allowedPaths = Set("registration", "credential", "renewal", "callback", "assetlinks")
  pure val validPolicy = { databaseAvailable: true, clientPresent: true, clientEnabled: true,
    appActive: true, appApproved: true, enabledExactly: true, environmentValid: true,
    callbackValid: true, exactCallbackAllowed: true, ttlValid: true, grantMatches: true,
    androidAssociationValid: true }
  pure def permits(p: Policy, path: str): bool = all {
    p.databaseAvailable, p.clientPresent, p.clientEnabled, p.appActive, p.appApproved,
    p.enabledExactly, p.environmentValid, p.callbackValid, p.exactCallbackAllowed, p.ttlValid,
    path.in(allowedPaths),
    (path == "credential" or path == "renewal") implies p.grantMatches,
    path == "assetlinks" implies p.androidAssociationValid
  }
  action init = all { policy' = validPolicy, entrypoint' = "registration", admitted' = false }
  action configure(p: Policy, path: str): bool = all {
    policy' = p, entrypoint' = path, admitted' = false
  }
  action resolve = all { policy' = policy, entrypoint' = entrypoint, admitted' = permits(policy, entrypoint) }
  // One observed authority fact changes per step. All combinations remain reachable,
  // with a bounded branching factor for complete graph enumeration.
  action step = any {
    resolve,
    configure(policy.with("databaseAvailable", not(policy.databaseAvailable)), entrypoint),
    configure(policy.with("clientPresent", not(policy.clientPresent)), entrypoint),
    configure(policy.with("clientEnabled", not(policy.clientEnabled)), entrypoint),
    configure(policy.with("appActive", not(policy.appActive)), entrypoint),
    configure(policy.with("appApproved", not(policy.appApproved)), entrypoint),
    configure(policy.with("enabledExactly", not(policy.enabledExactly)), entrypoint),
    configure(policy.with("environmentValid", not(policy.environmentValid)), entrypoint),
    configure(policy.with("callbackValid", not(policy.callbackValid)), entrypoint),
    configure(policy.with("exactCallbackAllowed", not(policy.exactCallbackAllowed)), entrypoint),
    configure(policy.with("ttlValid", not(policy.ttlValid)), entrypoint),
    configure(policy.with("grantMatches", not(policy.grantMatches)), entrypoint),
    configure(policy.with("androidAssociationValid", not(policy.androidAssociationValid)), entrypoint),
    { nondet path = allowedPaths.oneOf(); configure(policy, path) }
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
  run originWithoutExactCallbackRefusedTest = init.then(configure(validPolicy.with("exactCallbackAllowed", false), "registration")).then(resolve).expect(not(admitted))
  run invalidAndroidAssociationRefusedTest = init.then(configure(validPolicy.with("androidAssociationValid", false), "assetlinks")).then(resolve).expect(not(admitted))
  run androidConfigDoesNotRevokeCredentialTest = init.then(configure(validPolicy.with("androidAssociationValid", false), "credential")).then(resolve).expect(admitted)
}

// Two signers for one package. A grant is encoded as signer*2+relation.
// Publishing a statement must preserve these pairs instead of taking the
// Cartesian product of the package's signers and relations.
module AndroidAssociationPublication {
  var firstRelations: Set[int]
  var secondRelations: Set[int]
  var published: Set[int]
  var ready: bool
  pure val relationSets = Set(Set(), Set(0), Set(1), Set(0, 1))
  val authorized = firstRelations.union(secondRelations.map(relation => relation + 2))
  action init = all { firstRelations' = Set(), secondRelations' = Set(), published' = Set(), ready' = false }
  action configure(first: Set[int], second: Set[int]): bool = all {
    firstRelations' = first, secondRelations' = second, published' = Set(), ready' = false
  }
  action publish = all {
    firstRelations' = firstRelations, secondRelations' = secondRelations,
    published' = authorized, ready' = true
  }
  action step = any {
    { nondet first = relationSets.oneOf(); nondet second = relationSets.oneOf(); configure(first, second) },
    publish
  }
  val safety = published.subseteq(authorized) and (ready implies published == authorized)
  run distinctRelationsTest = init.then(configure(Set(0), Set(1))).then(publish).expect(published == Set(0, 3))
  run sharedRelationsTest = init.then(configure(Set(0), Set(0))).then(publish).expect(published == Set(0, 2))
  run disabledSignerTest = init.then(configure(Set(0), Set(1))).then(publish)
    .then(configure(Set(), Set(1))).then(publish).expect(published == Set(3))
}
