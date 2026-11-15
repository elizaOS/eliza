// LocalSpeechBridgePlugin publishes a prepared clip on Android's main thread.
module PreparedSpeechPublication {
  // Playback: 0 empty, 1 prepared clip, 2 stream.
  // Request: 0 idle, 1 admitted, 2 busy, 3 published, 4 cancelled.
  type State = { playback: int, phase: int, replace: bool, cancelled: bool,
    playbackAtPublication: int, interrupted: bool }
  var s: State
  action init = s' = { playback: 0, phase: 0, replace: false, cancelled: false,
    playbackAtPublication: 0, interrupted: false }
  action admit(replace: bool): bool = all {
    s.phase == 0, s' = { ...s, phase: 1, replace: replace }
  }
  action playback(kind: int): bool = all {
    s.phase <= 1, s' = { ...s, playback: kind }
  }
  action cancel = all { s.phase == 1, s' = { ...s, cancelled: true } }
  action publish = all {
    s.phase == 1,
    s' = if (s.cancelled)
      { ...s, phase: 4, playbackAtPublication: s.playback }
    else if (s.playback != 0 and not(s.replace))
      { ...s, phase: 2, playbackAtPublication: s.playback }
    else
      { ...s, phase: 3, playback: 1, playbackAtPublication: s.playback,
        interrupted: s.playback != 0 }
  }
  action step = any {
    { nondet replace = Set(false, true).oneOf() admit(replace) },
    { nondet kind = 0.to(2).oneOf() playback(kind) },
    cancel, publish, s' = s
  }
  val BusyRetainsPlayback = (s.phase == 2) implies s.playback == s.playbackAtPublication
  val CancellationRetainsPlayback = (s.phase == 4) implies s.playback == s.playbackAtPublication
  val InterruptsOnlyWithReplacement = s.interrupted implies (s.phase == 3 and s.replace and not(s.cancelled))
  temporal PublicationSettles = publish.weakFair(s).implies(
    always((s.phase == 1).implies(eventually(s.phase != 1))))

  run streamAtPublicationTest = init.then(admit(false)).then(playback(2)).then(publish)
    .expect(s.phase == 2 and s.playback == 2 and not(s.interrupted))
  run emptyPlaybackTest = init.then(admit(false)).then(publish).expect(s.phase == 3 and s.playback == 1)
  run clipAtPublicationTest = init.then(admit(false)).then(playback(1)).then(publish)
    .expect(s.phase == 2 and s.playback == 1 and not(s.interrupted))
  run cancelledPublicationTest = init.then(admit(false)).then(playback(2)).then(cancel).then(publish)
    .expect(s.phase == 4 and s.playback == 2 and not(s.interrupted))
  run replacementTest = init.then(admit(true)).then(playback(2)).then(publish)
    .expect(s.phase == 3 and s.playback == 1 and s.interrupted)
}
