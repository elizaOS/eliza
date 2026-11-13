// Consent may retry one connection reset before allocation; Stop cancels either attempt.
// Seconds abstract timer delivery. Upgrade and relay readiness have separate budgets.
module CloudSpeechConsentDeadline {
  var phase: str
  var elapsed: int
  var allocations: int
  var attempts: int
  action init = all {phase'="consent",elapsed'=0,allocations'=0,attempts'=1}
  val deadline = if (phase == "consent") 30 else if (phase == "upgrade") 10 else 5
  action tick = all {elapsed<deadline,elapsed'=elapsed+1,phase'=phase,allocations'=allocations,attempts'=attempts}
  action consent = all {phase=="consent",elapsed<30,phase'="mint",elapsed'=elapsed,allocations'=allocations,attempts'=attempts}
  action mint = all {phase=="mint",phase'="upgrade",elapsed'=0,allocations'=allocations+1,attempts'=attempts}
  action upgrade = all {phase=="upgrade",elapsed<10,phase'="hello",elapsed'=0,allocations'=allocations,attempts'=attempts}
  action ready = all {phase=="hello",elapsed<5,phase'="ready",elapsed'=elapsed,allocations'=allocations,attempts'=attempts}
  action stop = all {phase'="closed",elapsed'=elapsed,allocations'=allocations,attempts'=attempts}
  action expire = all {(phase=="consent" or phase=="upgrade" or phase=="hello"),elapsed>=deadline,phase'="closed",elapsed'=elapsed,allocations'=allocations,attempts'=attempts}
  action lateResult = all {phase=="closed",phase'=phase,elapsed'=elapsed,allocations'=allocations,attempts'=attempts}
  action retryConsent = all {phase=="consent",attempts==1,elapsed<30,phase'=phase,elapsed'=elapsed,allocations'=allocations,attempts'=2}
  action step = any {tick,consent,mint,upgrade,ready,stop,expire,lateResult,retryConsent}
  val safety = attempts>=1 and attempts<=2 and allocations<=1 and (phase=="consent" implies allocations==0)
  run coldConsent = init.then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(consent).then(mint).then(upgrade).then(ready).expect(phase=="ready" and allocations==1 and safety)
  run cancelledConsent = init.then(tick).then(stop).then(lateResult).expect(allocations==0 and phase=="closed" and safety)
  run coldUpgrade = init.then(consent).then(mint).then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(upgrade).then(ready).expect(phase=="ready" and allocations==1 and safety)
  run cancelledUpgrade = init.then(consent).then(mint).then(stop).then(lateResult).expect(allocations==1 and phase=="closed" and safety)
  run resetConsent = init.then(retryConsent).then(consent).then(mint).then(upgrade).then(ready).expect(phase=="ready" and allocations==1 and attempts==2 and safety)
  run cancelledRetry = init.then(retryConsent).then(stop).then(lateResult).expect(phase=="closed" and allocations==0 and attempts==2 and safety)
}
