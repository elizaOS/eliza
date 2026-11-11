// Three finite policy projections. Progress assumes only fair invocation of
// the synchronous decision; it does not assume provider or storage success.
// Actual runtime/SQLite/HTTP bridges are mandatory in the conformance hook.
module SettingsSaltPolicy {
  var s: { production: bool, salt: str, retiredFlag: bool, process: int,
    phase: str, key: str, storedKey: str, readResult: str }
  action initial(production: bool, salt: str, flag: bool): bool = s' = {
    production: production, salt: salt, retiredFlag: flag, process: 0,
    phase: "unresolved", key: "none", storedKey: "none", readResult: "none",
  }
  action init = {
    nondet production = Set(false, true).oneOf()
    nondet salt = Set("missing", "historical", "explicit").oneOf()
    nondet flag = Set(false, true).oneOf()
    initial(production, salt, flag)
  }
  action resolve = all {
    s.phase == "unresolved",
    s' = if (s.production and s.salt != "explicit")
      s.with("phase", "refused")
    else s.with("phase", "resolved").with("key",
      if (s.salt == "explicit") "configured"
      else if (s.process == 0) "ephemeral-0" else "ephemeral-1"),
  }
  action persist = all {
    s.phase == "resolved", s.storedKey == "none",
    s' = s.with("storedKey", s.key),
  }
  action clearCache = all {
    s.phase == "resolved", s' = s.with("phase", "unresolved").with("key", "none").with("readResult", "none"),
  }
  action restart = all {
    s.process == 0,
    s' = s.with("process", 1).with("phase", "unresolved")
      .with("key", "none").with("readResult", "none"),
  }
  action read = all {
    s.phase == "resolved", s.storedKey != "none",
    s' = s.with("readResult", if (s.key == s.storedKey) "complete" else "decryption-error"),
  }
  action toggleRetiredFlag = s' = s.with("retiredFlag", not(s.retiredFlag))
  action idle = s' = s
  action step = any { resolve, persist, clearCache, restart, read, toggleRetiredFlag, idle }
  val ProductionNeedsConfiguredKey = s.production and s.phase == "resolved" implies s.key == "configured"
  val NoHistoricalKey = s.key != "historical" and s.storedKey != "historical"
  val CompleteReadNeedsSameKey = s.readResult == "complete" implies s.key == s.storedKey
  temporal PolicySettles = (s.phase == "unresolved").leadsTo(s.phase != "unresolved")
  temporal FairPolicySettlement = resolve.weakFair(s) implies PolicySettles
  run missingProductionRefused = initial(true, "missing", true).then(resolve).expect(s.phase == "refused")
  run historicalProductionRefused = initial(true, "historical", true).then(resolve).expect(s.phase == "refused")
  run configuredRestartReadable = initial(true, "explicit", true).then(resolve).then(persist).then(restart).then(resolve).then(read).expect(s.readResult == "complete")
  run developmentCacheClearKeepsKey = initial(false, "missing", true).then(resolve).then(persist).then(clearCache).then(resolve).then(read).expect(s.readResult == "complete")
  run developmentRestartDoesNotInventSuccess = initial(false, "historical", true).then(resolve).then(persist).then(restart).then(resolve).then(read).expect(s.readResult == "decryption-error")
}

module McpStdioPolicy {
  var s: { stdio: bool, valid: bool, configured: bool, header: str,
    body: str, retiredFlag: bool, phase: str, result: str }
  action initial(stdio: bool, valid: bool, configured: bool, header: str, body: str, flag: bool): bool = s' = {
    stdio: stdio, valid: valid, configured: configured, header: header,
    body: body, retiredFlag: flag, phase: "received", result: "none",
  }
  action init = {
    nondet stdio = Set(false, true).oneOf()
    nondet valid = Set(false, true).oneOf()
    nondet configured = Set(false, true).oneOf()
    nondet header = Set("absent", "matching", "other").oneOf()
    nondet body = Set("absent", "matching", "other").oneOf()
    nondet flag = Set(false, true).oneOf()
    initial(stdio, valid, configured, header, body, flag)
  }
  val matchingCredential = (if (s.header != "absent") s.header else s.body) == "matching"
  val permitted = s.valid and (not(s.stdio) or (s.configured and matchingCredential))
  action decide = all {
    s.phase == "received",
    s' = s.with("phase", "settled").with("result",
      if (not(s.valid)) "invalid"
      else if (not(s.stdio)) "allowed"
      else if (not(s.configured)) "forbidden"
      else if (not(matchingCredential)) "unauthorized" else "allowed"),
  }
  action toggleRetiredFlag = s' = s.with("retiredFlag", not(s.retiredFlag))
  action idle = s' = s
  action step = any { decide, toggleRetiredFlag, idle }
  val AdmissionNeedsCurrentCredential = s.result == "allowed" implies permitted
  val RefusalCannotGrant = s.phase == "settled" and not(permitted) implies s.result != "allowed"
  temporal PolicySettles = (s.phase == "received").leadsTo(s.phase == "settled")
  temporal FairPolicySettlement = decide.weakFair(s) implies PolicySettles
  run retiredOverrideCannotConfigureStdio = initial(true, true, false, "absent", "absent", true).then(decide).expect(s.result == "forbidden")
  run matchingBodyCanConfigure = initial(true, true, true, "absent", "matching", true).then(decide).expect(s.result == "allowed")
  run wrongHeaderOverridesMatchingBody = initial(true, true, true, "other", "matching", true).then(decide).expect(s.result == "unauthorized")
  run matchingHeaderCanConfigure = initial(true, true, true, "matching", "absent", false).then(decide).expect(s.result == "allowed")
  run nonStdioKeepsExistingPolicy = initial(false, true, false, "absent", "absent", true).then(decide).expect(s.result == "allowed")
  run invalidConfigurationNeverAdmitted = initial(false, false, true, "matching", "matching", true).then(decide).expect(s.result == "invalid")
}

module DashboardBootstrapPolicy {
  var s: { tokenPresent: bool, retiredFlag: bool, phase: str,
    introducedApiToken: bool, localStorageWrite: bool, publicFields: bool }
  action initial(tokenPresent: bool, flag: bool): bool = s' = {
    tokenPresent: tokenPresent, retiredFlag: flag, phase: "requested",
    introducedApiToken: false, localStorageWrite: false, publicFields: false,
  }
  action init = {
    nondet tokenPresent = Set(false, true).oneOf()
    nondet flag = Set(false, true).oneOf()
    initial(tokenPresent, flag)
  }
  action render = all {
    s.phase == "requested",
    s' = s.with("phase", "served").with("publicFields", true),
  }
  action toggleRetiredFlag = s' = s.with("retiredFlag", not(s.retiredFlag))
  action idle = s' = s
  action step = any { render, toggleRetiredFlag, idle }
  val NoNewApiCapability = not(s.introducedApiToken) and not(s.localStorageWrite)
  val PublicBootstrapRemains = s.phase == "served" implies s.publicFields
  temporal PolicySettles = (s.phase == "requested").leadsTo(s.phase == "served")
  temporal FairPolicySettlement = render.weakFair(s) implies PolicySettles
  run retiredOverrideDoesNotPublishApiToken = initial(true, true).then(render).expect(NoNewApiCapability and PublicBootstrapRemains)
  run ordinaryBootstrapRetained = initial(false, false).then(render).expect(PublicBootstrapRemains)
}
