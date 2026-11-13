// Formal state model for database-backed mobile App Auth client registration.
// Covers database client resolution, active app authority, enabled status,
// redirect URI matching, and fail-closed legacy fallback behavior.
module MobileAppClientRegistration {
  var clientInDb: bool
  var clientActive: bool
  var appActive: bool
  var appApproved: bool
  var redirectMatches: bool
  var envFallbackPresent: bool
  var authorized: bool

  action init = all {
    clientInDb' = false,
    clientActive' = true,
    appActive' = true,
    appApproved' = true,
    redirectMatches' = true,
    envFallbackPresent' = false,
    authorized' = false
  }

  action configure(
    inDb: bool,
    activeClient: bool,
    activeApp: bool,
    approvedApp: bool,
    redirect: bool,
    fallback: bool
  ): bool = all {
    clientInDb' = inDb,
    clientActive' = activeClient,
    appActive' = activeApp,
    appApproved' = approvedApp,
    redirectMatches' = redirect,
    envFallbackPresent' = fallback,
    authorized' = false
  }

  // Database is primary authority; fallback is only reached when client is absent from database.
  // A disabled or unapproved client in the database fails closed and never defers to fallback.
  action resolve = all {
    clientInDb' = clientInDb,
    clientActive' = clientActive,
    appActive' = appActive,
    appApproved' = appApproved,
    redirectMatches' = redirectMatches,
    envFallbackPresent' = envFallbackPresent,
    authorized' = if (clientInDb) {
      clientActive and appActive and appApproved and redirectMatches
    } else {
      envFallbackPresent and appActive and appApproved and redirectMatches
    }
  }

  action step = any {
    resolve,
    {
      nondet inDb = Bool.oneOf();
      nondet activeClient = Bool.oneOf();
      nondet activeApp = Bool.oneOf();
      nondet approvedApp = Bool.oneOf();
      nondet redirect = Bool.oneOf();
      nondet fallback = Bool.oneOf();
      configure(inDb, activeClient, activeApp, approvedApp, redirect, fallback)
    }
  }

  // Safety invariant: authorization requires active and approved app, matching redirect, and valid client
  val safety = authorized implies (
    appActive and appApproved and redirectMatches and
    (if (clientInDb) clientActive else envFallbackPresent)
  )

  // Test cases proving state transitions
  run validDbClientAuthorizedTest = init
    .then(configure(true, true, true, true, true, false))
    .then(resolve)
    .expect(authorized)

  run disabledDbClientRefusedTest = init
    .then(configure(true, false, true, true, true, true))
    .then(resolve)
    .expect(not(authorized))

  run unapprovedAppDbClientRefusedTest = init
    .then(configure(true, true, true, false, true, false))
    .then(resolve)
    .expect(not(authorized))

  run mismatchedRedirectRefusedTest = init
    .then(configure(true, true, true, true, false, false))
    .then(resolve)
    .expect(not(authorized))

  run envFallbackAuthorizedWhenDbMissingTest = init
    .then(configure(false, true, true, true, true, true))
    .then(resolve)
    .expect(authorized)

  run disabledDbClientBlocksEnvFallbackTest = init
    .then(configure(true, false, true, true, true, true))
    .then(resolve)
    .expect(not(authorized))
}
