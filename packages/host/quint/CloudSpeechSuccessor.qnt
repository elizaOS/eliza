// Source: prepareSuccessor/acquireCloud and createCloudSpeechRelayPorts.
// One owner, predecessor and at most one current successor. Consent creates only a recoverable
// ledger; recovery, mint and socket opening wait for exact retirement.
module CloudSpeechSuccessor {
  var s: { old: str, preparation: str, owner: bool, matching: bool, configuration: bool, linked: bool,
    cancelled: bool, expired: bool, released: bool, recovered: bool,
    minted: bool, socket: bool, ledgerClosed: bool }
  action init = s' = { old: "live", preparation: "none", owner: true,
    matching: true, configuration: true, linked: false, cancelled: false, expired: false, released: false,
    recovered: false, minted: false, socket: false, ledgerClosed: false }
  val valid = s.owner and s.matching and s.configuration and not(s.cancelled) and not(s.expired)
  action prepare = all { valid, s.preparation == "none", s.old == "live", not(s.linked),
    s' = s.with("preparation", "known").with("linked", true) }
  // A lost consent response may leave a server-expiring ledger, never a provider.
  action loseConsent = all { valid, s.preparation == "none", s.old == "live",
    s' = s.with("preparation", "unknown").with("linked", false) }
  action beginRetirement = all { s.old == "live", s' = s.with("old", "retiring") }
  action unknownRetirement = all { s.old == "retiring", s' = s.with("old", "unknown") }
  action confirmRetirement = all { Set("retiring", "unknown").contains(s.old),
    s' = s.with("old", "retired") }
  action release = all { valid, s.old == "retired", s.preparation == "known",
    not(s.ledgerClosed), s' = s.with("released", true) }
  action recover = all { valid, s.released, not(s.ledgerClosed),
    s' = s.with("recovered", true) }
  action mint = all { valid, s.released, s.recovered, not(s.ledgerClosed),
    s.preparation == "known", s' = s.with("minted", true) }
  action openSocket = all { valid, s.minted, not(s.ledgerClosed),
    s' = s.with("socket", true) }
  action cancel = s' = s.with("cancelled", true).with("socket", false).with("linked", false)
  action expire = s' = s.with("expired", true).with("socket", false).with("linked", false)
  action ownerChanges = s' = s.with("owner", false).with("socket", false)
  action successorMismatch = s' = s.with("matching", false).with("socket", false)
  action configurationChanges = s' = s.with("configuration", false).with("socket", false)
  // A new explicit request is permitted only after the exact prior link cleared.
  // A known prior ledger must have confirmed cleanup before this bounded retry.
  action explicitRetry = all { s.old == "live", s.owner, s.matching, s.configuration,
    not(s.linked), s.ledgerClosed or s.preparation == "unknown",
    s' = s.with("preparation", "none").with("cancelled", false).with("expired", false)
      .with("ledgerClosed", false) }
  action confirmCleanup = all { s.preparation == "known", not(valid),
    s' = s.with("ledgerClosed", true).with("socket", false) }
  action step = any { prepare, loseConsent, beginRetirement, unknownRetirement,
    confirmRetirement, release, recover, mint, openSocket, cancel, expire,
    ownerChanges, successorMismatch, configurationChanges, explicitRetry, confirmCleanup, s' = s }
  val safety = and {
    (s.released or s.recovered or s.minted or s.socket) implies s.old == "retired",
    s.minted implies s.preparation == "known",
    s.socket implies (valid and s.minted and not(s.ledgerClosed))
  }
  run warmThenRotateTest = init.then(prepare).expect(s.old == "live" and not(s.minted))
    .then(beginRetirement).then(confirmRetirement).then(release).then(recover)
    .then(mint).then(openSocket).expect(safety and s.socket)
  run stopWhileWarmTest = init.then(prepare).then(cancel).then(confirmCleanup)
    .expect(safety and s.ledgerClosed and not(s.recovered) and not(s.minted))
  run unknownRetirementBlocksTest = init.then(prepare).then(beginRetirement)
    .then(unknownRetirement).expect(safety and not(s.released) and not(s.minted))
  run unknownConsentBlocksTest = init.then(loseConsent).then(beginRetirement)
    .then(confirmRetirement).expect(safety and not(s.minted))
  run mismatchBlocksTest = init.then(prepare).then(successorMismatch)
    .then(beginRetirement).then(confirmRetirement).then(confirmCleanup)
    .expect(safety and not(s.minted))
  run routeChangeBlocksTest = init.then(prepare).then(configurationChanges)
    .then(beginRetirement).then(confirmRetirement).then(confirmCleanup)
    .expect(safety and not(s.minted))
  run explicitRetryAfterCancellationTest = init.then(prepare).then(cancel).then(confirmCleanup)
    .then(explicitRetry).then(prepare).expect(safety and s.linked and s.old == "live")
  run explicitRetryAfterFailureTest = init.then(loseConsent).then(explicitRetry)
    .then(prepare).expect(safety and s.linked and not(s.minted))
  run expiryBlocksTest = init.then(prepare).then(expire).then(confirmCleanup)
    .expect(safety and not(s.minted))
}
