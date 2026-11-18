// One held reply and the recognizer segments that arrive while it is active.
// A segment is classified only by its final; an interim prefix may still become a sound annotation.
module VoiceNonSpeech {
  // What a final transcript is: caller words, a whole sound annotation such as *music*, or nothing.
  val FinalKinds = Set("speech", "annotation", "empty")
  // What an interim transcript is: caller words, or a prefix such as *Dramatic Mus.
  val PartialKinds = Set("speech", "annotationPrefix")

  var active: bool
  var turns: int
  var meteredFinals: int
  // Set when a sound annotation started a turn or cancelled the held reply.
  var annotationTookOver: bool

  // session.ts commitTurn: isNonSpeechVoiceTranscript commits an annotation final as an empty one.
  pure def finalStartsTurn(kind: str): bool = kind == "speech"
  // session.ts interruptForConfirmedSpeech(partial): mayBecomeNonSpeechVoiceTranscript waits for the final.
  pure def partialInterrupts(kind: str): bool = kind == "speech"

  action init = all { active' = false, turns' = 0, meteredFinals' = 0, annotationTookOver' = false }

  // Every final settles its metering once; a final that starts a turn takes over any held reply.
  action finalWith(kind: str, starts: bool): bool = all {
    meteredFinals < 3, if (starts) turns < 2 else true,
    active' = if (starts) true else active,
    turns' = if (starts) turns + 1 else turns,
    meteredFinals' = meteredFinals + 1,
    annotationTookOver' = if (starts) annotationTookOver or kind == "annotation" else annotationTookOver,
  }
  action final(kind: str): bool = finalWith(kind, finalStartsTurn(kind))

  action partialWith(kind: str, stops: bool): bool = all {
    active,
    active' = if (stops) false else true,
    turns' = turns,
    meteredFinals' = meteredFinals,
    annotationTookOver' = if (stops) annotationTookOver or kind == "annotationPrefix" else annotationTookOver,
  }
  action partial(kind: str): bool = partialWith(kind, partialInterrupts(kind))

  action complete = all { active, active' = false, turns' = turns, meteredFinals' = meteredFinals,
    annotationTookOver' = annotationTookOver }
  action stutter = all { active' = active, turns' = turns, meteredFinals' = meteredFinals,
    annotationTookOver' = annotationTookOver }

  action anyFinal = {
    nondet kind = FinalKinds.oneOf()
    final(kind)
  }
  action anyPartial = {
    nondet kind = PartialKinds.oneOf()
    partial(kind)
  }
  action step = any { anyFinal, anyPartial, complete, stutter }

  val TypeOK = turns >= 0 and turns <= 2 and meteredFinals >= 0 and meteredFinals <= 3
  val NoAnnotationTakeover = not(annotationTookOver)

  run annotationThenSpeechTest = init.then(final("annotation")).then(final("speech"))
    .expect(active and turns == 1 and meteredFinals == 2 and NoAnnotationTakeover)
  run annotationKeepsReplyTest = init.then(final("speech")).then(partial("annotationPrefix")).then(final("annotation"))
    .expect(active and turns == 1 and NoAnnotationTakeover)
  run speechPartialInterruptsTest = init.then(final("speech")).then(partial("speech"))
    .expect(not(active) and NoAnnotationTakeover)

  // Witnesses: without either classifier guard an annotation takes over, so NoAnnotationTakeover can fail.
  run unclassifiedFinalWitness = init.then(final("speech")).then(finalWith("annotation", true))
    .expect(not(NoAnnotationTakeover))
  run unclassifiedPartialWitness = init.then(final("speech")).then(partialWith("annotationPrefix", true))
    .expect(not(NoAnnotationTakeover) and not(active))
}
