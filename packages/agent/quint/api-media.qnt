// Content-addressed streaming publication and verified redaction.
// Hash validity abstracts SHA-256 equality; bytes and MIME parsing are implementation tests.
// Bounds: two chunks, one original and one distinct redacted variant.
module api_media {
  var s: { phase: str, chunks: int, synced: bool, complete: bool, published: bool, verified: bool, changed: bool, variant: bool }
  action init = s' = { phase: "absent", chunks: 0, synced: false, complete: false, published: false, verified: false, changed: false, variant: false }
  action open = all { s.phase == "absent", s' = s.with("phase", "pending") }
  action chunk = all { s.phase == "pending", not(s.complete), s.chunks < 2, s' = s.with("chunks", s.chunks + 1) }
  action finish = all { s.phase == "pending", s' = s.with("complete", true).with("synced", true).with("phase", "sealed") }
  action publish = all { s.phase == "sealed", s.complete, s.synced, s' = s.with("phase", "published").with("published", true) }
  action abortPublication = all { not(s.published), s' = s.with("phase", "failed").with("chunks", 0) }
  action redact = all { s.published, s' = s.with("changed", true) }
  action verify = all { s.changed, s' = s.with("verified", true) }
  action persistVariant = all { s.changed, s.verified, s' = s.with("variant", true) }
  action idle = s' = s
  action step = any { open, chunk, finish, publish, abortPublication, redact, verify, persistVariant, idle }
  val safety = all { s.published implies (s.synced and s.complete), s.variant implies (s.verified and s.changed and s.published), s.phase == "failed" implies not(s.published), s.chunks >= 0, s.chunks <= 2 }
  run partialStreamNeverPublicTest = init.then(open).then(chunk).then(abortPublication).expect(not(s.published))
  run redactionNeedsVerificationTest = init.then(open).then(chunk).then(finish).then(publish).then(redact).then(verify).then(persistVariant).expect(safety and s.variant)
}
