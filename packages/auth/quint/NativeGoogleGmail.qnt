// Native Google sign-in that also connects Google for the scopes the host registers
// (CloudSignInPlugin.startGoogle, gmailClientId, signInWithGoogle, commit, connectGmail;
// NativeGoogleCredential.authorize). The plugin reads Cloud's web client before the account picker;
// after it, it asks Google for exactly the registered scopes and holds the one-use server code in
// memory. One Cloud call verifies the identity, mints the key and connects Google. With a second
// factor Cloud answers mfa_required before it exchanges the code that travelled with that call; the
// code waits for the factor and for Cloud's confirmation of the new key, and is exchanged with that
// key. A Google failure never fails the sign-in; the outcome says what became of the connection.
module NativeGoogleGmail {
  type State = {
    scopes: bool, client: bool, phase: str, code: str, codeUses: int, google: str,
    confirmed: bool, connectSent: bool, result: str
  }
  var s: State

  action start(scopes: bool): bool = s' = {
    scopes: scopes, client: false, phase: if (scopes) "config" else "picker", code: "none", codeUses: 0, google: "none",
    confirmed: false, connectSent: false, result: "none"
  }
  action init = { nondet scopes = Set(true, false).oneOf() start(scopes) }

  pure def failed(x: State): State = { ...x, phase: "done", result: "failed", code: if (x.code == "held") "dropped" else x.code }
  pure def refused(x: State): State = { ...x, google: if (x.scopes) "refused" else x.google }

  action config(configured: bool): bool = all {
    s.phase == "config",
    s' = if (configured) { ...s, phase: "picker", client: true } else { ...refused(s), phase: "picker" },
  }
  action picker(ok: bool): bool = all {
    s.phase == "picker",
    s' = if (not(ok)) failed(s) else { ...s, phase: if (s.client) "sheet" else "authorize" },
  }
  action sheet(granted: bool): bool = all {
    s.phase == "sheet",
    s' = if (granted) { ...s, phase: "authorize", code: "held" } else { ...refused(s), phase: "authorize" },
  }
  action authorize(approved: bool): bool = all {
    s.phase == "authorize",
    s' = if (approved) { ...s, phase: "cloud" } else failed(s),
  }
  // The one Cloud call. The held code goes with it; Cloud exchanges it and answers for the connection
  // in the same reply, unless it answers mfa_required first, when the code stays held.
  action cloud(answer: str, connected: bool): bool = all {
    s.phase == "cloud",
    s' = if (answer == "refused") { ...failed(s), code: if (s.code == "held") "sent" else s.code, codeUses: s.codeUses + (if (s.code == "held") 1 else 0) }
      else if (answer == "mfa") { ...s, phase: "mfa" }
      else if (s.code == "held") { ...s, phase: "ack", code: "sent", codeUses: s.codeUses + 1, google: if (connected) "connected" else "refused" }
      else { ...s, phase: "ack" },
  }
  action mfa(ok: bool): bool = all {
    s.phase == "mfa",
    s' = if (ok) { ...s, phase: "ack" } else failed(s),
  }
  // Cloud's acknowledgement of the stored key. Only a confirmed key connects Google with the code a
  // second factor held back; otherwise the code is dropped and the outcome says Google is not connected.
  action ack(answer: str, connected: bool): bool = all {
    s.phase == "ack",
    s' = if (answer == "confirmed" and s.code == "held") {
        ...s, phase: "done", result: "authenticated", confirmed: true, connectSent: true,
        code: "sent", codeUses: s.codeUses + 1, google: if (connected) "connected" else "refused",
      } else if (answer == "confirmed") { ...s, phase: "done", result: "authenticated", confirmed: true }
      else {
        ...s, phase: "done", result: if (answer == "pending") "activation-pending" else "activation-expired",
        code: if (s.code == "held") "dropped" else s.code,
        google: if (s.code == "held") "refused" else s.google,
      },
  }
  action idle = all { s.phase == "done", s' = s }

  action step = any {
    nondet ok = Set(true, false).oneOf()
    nondet connected = Set(true, false).oneOf()
    nondet answer = Set("signed-in", "mfa", "refused").oneOf()
    nondet acked = Set("confirmed", "pending", "refused").oneOf()
    any { picker(ok), config(ok), sheet(ok), authorize(ok), cloud(answer, connected), mfa(ok), ack(acked, connected) },
    idle,
  }

  // Google's one-use code is exchanged at most once.
  val CodeAtMostOnce = s.codeUses <= 1
  // The code a second factor held back is exchanged only with a key Cloud confirmed.
  val ConnectOnlyConfirmed = s.connectSent.implies(s.confirmed)
  // A finished attempt holds no Google code.
  val NoCodeLeftHeld = (s.phase == "done").implies(s.code != "held")
  // A host that registers scopes always learns what became of the connection.
  val ConnectionReported = (s.result == "authenticated" and s.scopes).implies(s.google != "none")
  // A host that registers no scope asks Google for nothing and reports no connection.
  val NoScopesNoGoogle = not(s.scopes).implies(s.google == "none" and s.codeUses == 0 and s.code == "none")
  // A confirmed key always signs in, whatever happened to the Google connection.
  val GoogleNeverFailsSignIn = s.confirmed.implies(s.result == "authenticated")

  run oneCallConnectsTest = start(true).then(config(true)).then(picker(true)).then(sheet(true))
    .then(authorize(true)).then(cloud("signed-in", true)).then(ack("confirmed", false))
    .expect(s.result == "authenticated" and s.google == "connected" and s.codeUses == 1 and not(s.connectSent))

  run declinedSheetStillSignsInTest = start(true).then(config(true)).then(picker(true)).then(sheet(false))
    .then(authorize(true)).then(cloud("signed-in", false)).then(ack("confirmed", false))
    .expect(s.result == "authenticated" and s.google == "refused" and s.codeUses == 0)

  run secondFactorConnectsAfterConfirmationTest = start(true).then(config(true)).then(picker(true))
    .then(sheet(true)).then(authorize(true)).then(cloud("mfa", false)).then(mfa(true)).then(ack("confirmed", true))
    .expect(s.result == "authenticated" and s.google == "connected" and s.connectSent and s.codeUses == 1)

  run unconfirmedKeyDropsCodeTest = start(true).then(config(true)).then(picker(true)).then(sheet(true))
    .then(authorize(true)).then(cloud("mfa", false)).then(mfa(true)).then(ack("refused", false))
    .expect(s.result == "activation-expired" and s.code == "dropped" and s.google == "refused" and s.codeUses == 0)

  run noScopesSignsInOnlyTest = start(false).then(picker(true)).then(authorize(true))
    .then(cloud("signed-in", true)).then(ack("confirmed", true))
    .expect(s.result == "authenticated" and s.google == "none" and s.codeUses == 0)
}
