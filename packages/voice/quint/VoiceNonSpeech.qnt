// One active reply and one recognized segment. Classification is checked by source tests.
module VoiceNonSpeech {
  var active: bool
  var dispatches: int
  var meteredFinals: int
  var annotationDispatched: bool
  action init = all { active' = false, dispatches' = 0, meteredFinals' = 0, annotationDispatched' = false }
  action annotation = all { meteredFinals < 2, active' = active, dispatches' = dispatches, meteredFinals' = meteredFinals + 1, annotationDispatched' = false }
  action speech = all { not(active), dispatches < 2, active' = true, dispatches' = dispatches + 1, meteredFinals' = meteredFinals, annotationDispatched' = false }
  action complete = all { active, active' = false, dispatches' = dispatches, meteredFinals' = meteredFinals, annotationDispatched' = false }
  action step = any { annotation, speech, complete, all { active' = active, dispatches' = dispatches, meteredFinals' = meteredFinals, annotationDispatched' = annotationDispatched } }
  val safety = not(annotationDispatched) and dispatches >= 0 and dispatches <= 2 and meteredFinals >= 0 and meteredFinals <= 2
  run annotationThenSpeech = init.then(annotation).then(speech).expect(active and dispatches == 1 and meteredFinals == 1)
  run annotationKeepsReply = init.then(speech).then(annotation).expect(active and dispatches == 1)
}
