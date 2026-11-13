// Formal state model for database-backed mobile App Auth client registration.
// Covers database client resolution, active app authority, enabled status,
// redirect URI matching, and fail-closed behavior (no environment fallback).
module MobileAppClientRegistration {
  var clientInDb: bool
  var clientActive: bool
  var appActive: bool
  var appApproved: bool
  var redirectMatches: bool
  var authorized: bool

  action init = all {
    clientInDb' = false,
    clientActive' = true,
    appActive' = true,
    appApproved' = true,
    redirectMatches' = true,
    authorized' = false
  }

  action configure(
    inDb: bool,
    activeClient: bool,
    activeApp: bool,
    approvedApp: bool,
    redirect: bool
  ): bool = all {
    clientInDb' = inDb,
    clientActive' = activeClient,
    appActive' = activeApp,
    appApproved' = approvedApp,
    redirectMatches' = redirect,
    authorized' = false
  }

  // Database is the sole authority; clients absent from the database cannot be authorized.
  // Disabled clients or unapproved apps in the database fail closed.
  action resolve = all {
    clientInDb' = clientInDb,
    clientActive' = clientActive,
    appActive' = appActive,
    appApproved' = appApproved,
    redirectMatches' = redirectMatches,
    authorized' = if (clientInDb) {
      clientActive and appActive and appApproved and redirectMatches
    } else {
      false
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
      configure(inDb, activeClient, activeApp, approvedApp, redirect)
    }
  }

  // Safety invariant: authorization strictly requires database presence, active client, active & approved app, and matching redirect
  val safety = authorized implies (
    clientInDb and clientActive and appActive and appApproved and redirectMatches
  )

  // Test cases proving state transitions
  run validDbClientAuthorizedTest = init
    .then(configure(true, true, true, true, true))
    .then(resolve)
    .expect(authorized)

  run disabledDbClientRefusedTest = init
    .then(configure(true, false, true, true, true))
    .then(resolve)
    .expect(not(authorized))

  run unapprovedAppDbClientRefusedTest = init
    .then(configure(true, true, true, false, true))
    .then(resolve)
    .expect(not(authorized))

  run mismatchedRedirectRefusedTest = init
    .then(configure(true, true, true, true, false))
    .then(resolve)
    .expect(not(authorized))

  run absentDbClientRefusedTest = init
    .then(configure(false, true, true, true, true))
    .then(resolve)
    .expect(not(authorized))
}
