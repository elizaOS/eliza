/// Resolved host flags during one synchronous plugin initialization.
module CloudCapabilities {
  type State = { configured: bool, ready: bool, enabled: Set[str], registered: Set[str] }
  var s: State
  pure val groups = Set("embeddings", "media", "tts", "stt")
  action init = s' = { configured: false, ready: false, enabled: Set(), registered: Set() }
  action configure(embeddings: bool, media: bool, tts: bool, stt: bool): bool = all {
    not(s.configured),
    s' = {...s, configured: true, enabled: groups.filter(group =>
      (group == "embeddings" and embeddings) or (group == "media" and media) or
      (group == "tts" and tts) or (group == "stt" and stt))}
  }
  action chooseFlags = {
    nondet embeddings = Set(true, false).oneOf()
    nondet media = Set(true, false).oneOf()
    nondet tts = Set(true, false).oneOf()
    nondet stt = Set(true, false).oneOf()
    configure(embeddings, media, tts, stt)
  }
  action register = all {
    s.configured, not(s.ready),
    s' = {...s, ready: true, registered: s.enabled}
  }
  action step = any { chooseFlags, register, s' = s }
  val safety = s.registered.subseteq(groups) and
    (s.ready implies s.registered == s.enabled) and
    (not(s.ready) implies s.registered == Set())
  run defaultCapabilitiesTest = init.then(configure(true, true, true, true)).then(register)
    .expect(s.registered == groups and safety)
  run embeddingOnlyTest = init.then(configure(true, false, false, false)).then(register)
    .expect(s.registered == Set("embeddings") and safety)
  run directEmbeddingTest = init.then(configure(false, true, true, true)).then(register)
    .expect(not(s.registered.contains("embeddings")) and s.registered.contains("media") and safety)
}
