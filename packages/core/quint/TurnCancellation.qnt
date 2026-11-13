// runWithStreamingContext and AgentRuntime.useModel: signal ownership is kept
// across a same-turn scope with no own signal. Different turns stay isolated.
module TurnCancellation {
  const SameTurn: bool
  const OwnSignal: bool
  type State = { entered: bool, rootAborted: bool, ownAborted: bool,
    inherits: bool, phase: str, attempts: int, fallbackAfterAbort: bool }
  var s: State
  action init = s' = { entered: false, rootAborted: false, ownAborted: false,
    inherits: false, phase: "idle", attempts: 0, fallbackAfterAbort: false }
  val aborted = (s.inherits and s.rootAborted) or (OwnSignal and s.ownAborted)
  action Enter = all { not(s.entered),
    s' = { ...s, entered: true, inherits: SameTurn and not(OwnSignal) } }
  action AbortRoot = all { not(s.rootAborted), s' = {...s, rootAborted: true} }
  action AbortOwn = all { OwnSignal, not(s.ownAborted), s' = {...s, ownAborted: true} }
  action Start = all { s.entered, s.phase == "idle",
    s' = {...s, phase: if (aborted) "cancelled" else "active",
      attempts: if (aborted) 0 else 1} }
  action Cancel = all { aborted, Set("active", "refused").contains(s.phase),
    s' = {...s, phase: "cancelled"} }
  action Complete = all { s.phase == "active", not(aborted), s' = {...s, phase: "complete"} }
  action Refuse = all { s.phase == "active", not(aborted),
    s' = {...s, phase: if (s.attempts == 1) "refused" else "failed"} }
  action Fallback = all { s.phase == "refused", not(aborted),
    s' = {...s, phase: "active", attempts: 2, fallbackAfterAbort: aborted} }
  action nextStep = any {Enter, AbortRoot, AbortOwn, Start, Cancel, Complete, Refuse, Fallback,
    all {Set("complete", "cancelled", "failed").contains(s.phase), s' = s}}
  action step = any {nextStep, s' = s}
  val TypeOK = and {Set("idle", "active", "refused", "complete", "cancelled", "failed").contains(s.phase),
    s.attempts >= 0, s.attempts <= 2}
  val RootSignalInherited = s.entered implies (s.inherits == (SameTurn and not(OwnSignal)))
  val NoFallbackAfterAbort = not(s.fallbackAfterAbort)
  val CancelBeforeStart = s.phase == "cancelled" and s.attempts == 0 implies aborted
  temporal CancelSettles = Cancel.weakFair(s).implies(
    (aborted and Set("active", "refused").contains(s.phase)).leadsTo(s.phase == "cancelled"))
  temporal DeadlockFree = always(enabled(nextStep))
}
module TurnCancellation_same { import TurnCancellation(SameTurn = true, OwnSignal = false).* }
module TurnCancellation_other { import TurnCancellation(SameTurn = false, OwnSignal = false).* }
module TurnCancellation_own { import TurnCancellation(SameTurn = true, OwnSignal = true).* }
