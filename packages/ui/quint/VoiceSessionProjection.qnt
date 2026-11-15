// applyClientAction/applyServerEvent/beginListening/loopToListening.
// Two symbolic trace ids cover matching/stale events. Transcripts are reduced
// to empty/nonempty because this machine tests emptiness and stores the text.
module VoiceSessionProjection {
  pure val phases = Set("idle", "connecting", "ready", "listening", "transcribing", "thinking", "speaking", "interrupted", "complete")
  var s: {
    phase: str,
    trace: int,
    cancelled: int,
    progress: bool,
    finalNonempty: bool,
    interim: bool,
    error: bool,
    event: str,
    previousPhase: str,
    previousTrace: int,
    previousCancelled: int,
    incoming: int,
    progressAccepted: bool
  }
  pure val initial = {
    phase: "idle",
    trace: 0,
    cancelled: 0,
    progress: false,
    finalNonempty: false,
    interim: false,
    error: false,
    event: "init",
    previousPhase: "idle",
    previousTrace: 0,
    previousCancelled: 0,
    incoming: 0,
    progressAccepted: false
  }
  action init = s' = initial
  action event(e: str, trace: int): bool = {
    val b = s
      .with("event", e)
      .with("previousPhase", s.phase)
      .with("previousTrace", s.trace)
      .with("previousCancelled", s.cancelled)
      .with("incoming", trace)
      .with("progressAccepted", false)
    s' = if (e == "reset") initial
    else if (e == "connect") (if (s.phase == "idle") b
      .with("phase", "connecting")
      .with("error", false) else b)
    else if (e == "barge") b
      .with("phase", if (s.phase == "speaking") "listening" else s.phase)
      .with("progress", false)
      .with("cancelled", s.trace)
    else if (e == "listen") (if (Set("ready", "complete").contains(s.phase)) b
      .with("phase", "listening")
      .with("progress", false) else b)
    else if (e == "loop") (if (Set("complete", "interrupted").contains(s.phase)) b
      .with("phase", "listening")
      .with("progress", false) else b)
    else if (e == "ready") b
      .with("phase", "ready")
      .with("progress", false)
      .with("trace", trace)
      .with("error", false)
    else if (e == "partial") b
      .with("phase", "transcribing")
      .with("trace", trace)
      .with("progress", false)
      .with("interim", true)
    else if (e == "emptyFinal") b
      .with("phase", "complete")
      .with("trace", trace)
      .with("finalNonempty", false)
      .with("interim", false)
    else if (e == "final") b
      .with("phase", if (s.phase == "speaking") "speaking" else "thinking")
      .with("trace", trace)
      .with("finalNonempty", true)
      .with("interim", false)
      .with("progress", false)
    else if (e == "llm") b
      .with("phase", if (s.phase == "speaking") "speaking" else "thinking")
      .with("trace", trace)
    else if (e == "speakingStart") b
      .with("phase", "speaking")
      .with("trace", trace)
    else if (e == "speakingEnd") b
      .with("phase", "complete")
      .with("trace", trace)
      .with("progress", false)
    else if (e == "interrupted") b
      .with("phase", "interrupted")
      .with("trace", trace)
      .with("progress", false)
    else if (e == "progress") (if (s.trace == trace and s.cancelled != trace and Set("thinking", "speaking").contains(s.phase)) b
      .with("progress", true)
      .with("progressAccepted", true) else b)
    else if (e == "terminal") (if (s.trace == trace) b
      .with("progress", false)
      .with("phase", if (s.phase == "speaking") "speaking" else "complete") else b)
    else if (e == "usage") (if (s.trace == trace) b
      .with("progress", false)
      .with("phase", if (s.phase == "thinking") "complete" else s.phase) else b)
    else if (e == "error") b
      .with("error", true)
      .with("progress", false)
    else if (e == "diagnostic") b
      .with("trace", trace)
    else b
  }
  action step = {
    nondet e = Set("reset", "connect", "barge", "listen", "loop", "ready", "partial", "emptyFinal", "final", "llm", "speakingStart", "speakingEnd", "interrupted", "progress", "terminal", "usage", "error", "diagnostic", "replyComplete").oneOf();
    nondet trace = Set(1, 2).oneOf();
    event(e, trace)
  }
  val invariant = and {
    phases.contains(s.phase),
    s.progressAccepted implies (s.previousTrace == s.incoming and s.previousCancelled != s.incoming and Set("thinking", "speaking").contains(s.previousPhase)),
    (Set("terminal", "usage").contains(s.event) and s.previousTrace != s.incoming) implies s.phase == s.previousPhase,
    (s.event == "usage" and s.previousPhase == "speaking") implies s.phase == "speaking",
    (s.event == "emptyFinal") implies (s.phase == "complete" and not(s.finalNonempty)),
    (s.event == "barge") implies not(s.progress)
  }
}
