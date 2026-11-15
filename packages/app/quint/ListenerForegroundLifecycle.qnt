// One native listener service's delivered start and its guarded foreground/stop transition.
// Android token/FGS semantics are represented by explicit controlled host ports.
module ListenerForegroundLifecycle {
 type State = { pending: int, delivered: int, owed: bool, policy: bool,
   refused: bool, foreground: bool, capture: bool, stopped: bool,
   phase: str, attempted: bool, diagnosed: bool }
 var s: State
 action initialize(policy: bool, refused: bool): bool = s' = {
   pending: 1, delivered: 0, owed: false, policy: policy, refused: refused,
   foreground: false, capture: false, stopped: false,
   phase: "pending", attempted: false, diagnosed: false }
 action init = any { initialize(true, false), initialize(true, true),
   initialize(false, false), initialize(false, true) }
 action revoke = all { s.policy, s' = s.with("policy", false) }
 action queueNewer = all { s.pending == 1, s.delivered == 1,
   s' = s.with("pending", 2).with("stopped", false) }
 action deliver = all { s.delivered < s.pending,
   s' = s.with("delivered", s.pending).with("owed", true)
     .with("phase", "applying").with("attempted", false) }
 action reapply = all { s.phase == "settled", not(s.stopped),
   s' = s.with("phase", "applying").with("attempted", false) }
 action foregroundAttempt = all { s.phase == "applying", s.policy or s.owed,
   s' = s.with("owed", false).with("attempted", true)
     .with("foreground", not(s.refused)).with("diagnosed", s.diagnosed or s.refused)
     .with("phase", if (s.policy and not(s.refused)) "capture" else "stopping") }
 action noForegroundOwed = all { s.phase == "applying", not(s.policy), not(s.owed),
   s' = s.with("phase", "stopping") }
 action startCapture = all { s.phase == "capture", s.policy, s.foreground,
   s' = s.with("capture", true).with("phase", "settled") }
 action captureRetired = all { s.phase == "capture", not(s.policy),
   s' = s.with("phase", "stopping") }
 action stop = all { s.phase == "stopping",
   s' = s.with("capture", false).with("foreground", false)
     .with("stopped", s.delivered == s.pending).with("phase", "settled") }
 action progress = any { deliver, foregroundAttempt, noForegroundOwed,
   startCapture, captureRetired, stop }
 action step = any { progress, revoke, queueNewer, reapply, s' = s }
 val CaptureNeedsForeground = s.capture implies s.foreground
 val StoppedOwnsNoCapture = s.stopped implies not(s.capture)
 val OldStartCannotStopNewer = s.delivered < s.pending implies not(s.stopped)
 val RefusalIsExplicit = s.attempted and s.refused implies s.diagnosed
 temporal FairStartSettles = progress.weakFair(s) implies
   (s.phase != "settled").leadsTo(s.phase == "settled")
 temporal StartSettles = (s.phase != "settled").leadsTo(s.phase == "settled")
 run refusedStopStillSettlesTest = initialize(false, true).then(deliver)
   .then(foregroundAttempt).then(stop).expect(s.stopped and s.diagnosed and not(s.capture))
 run newerPendingStartRetainedTest = initialize(true, false).then(deliver)
   .then(foregroundAttempt).then(startCapture).then(queueNewer).then(revoke)
   .then(reapply).then(noForegroundOwed).then(stop).expect(not(s.stopped))
   .then(deliver).then(foregroundAttempt).then(stop).expect(s.stopped)
 run admittedCaptureNeedsForegroundTest = initialize(true, false).then(deliver)
   .then(foregroundAttempt).then(startCapture).expect(CaptureNeedsForeground)
}
