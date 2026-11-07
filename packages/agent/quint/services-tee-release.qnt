// tee-{boot-gate,key-release,revocation,confidential-inference,sealed-volume}.ts:
// evidence/policy/freshness/revocation gates precede key release and use.
// Boolean predicates abstract external cryptographic verification, not prove it.
module services_tee_release {
  var s: { phase: str, evidence: bool, fresh: bool, policy: bool, revoked: bool, key: bool, used: bool }
  action init = s' = { phase: "new", evidence: false, fresh: false, policy: false, revoked: false, key: false, used: false }
  action attest(valid: bool): bool = all { s.phase == "new", s' = s.with("phase", "attested").with("evidence", valid).with("fresh", valid) }
  action evaluate(allowed: bool): bool = all { s.phase == "attested", s' = s.with("policy", allowed).with("phase", "evaluated") }
  action release = all { s.phase == "evaluated", s.evidence, s.fresh, s.policy, not(s.revoked), s' = s.with("phase", "released").with("key", true) }
  action use = all { s.key, s.fresh, not(s.revoked), s' = s.with("used", true) }
  action revoke = s' = s.with("revoked", true).with("key", false)
  action expire = s' = s.with("fresh", false).with("key", false)
  action keep = s' = s
  action step = any { attest(true), attest(false), evaluate(true), evaluate(false), release, use, revoke, expire, keep }
  val safety = all { s.key implies s.evidence and s.policy and s.fresh and not(s.revoked), s.used implies s.evidence and s.policy }
  run revokePreventsKeyUseTest = init.then(attest(true)).then(evaluate(true)).then(release).then(revoke).expect(not(s.key))
  run untrustedEvidenceHasNoKeyTest = init.then(attest(false)).then(evaluate(true)).expect(not(s.key))
}
