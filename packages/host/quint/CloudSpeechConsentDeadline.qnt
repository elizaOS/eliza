// One unallocated consent request and its immediate owner cancellation.
// Seconds abstract timer delivery. Mint retains its separate existing deadline.
module CloudSpeechConsentDeadline {
  var phase: str
  var elapsed: int
  var allocations: int
  action init = all {phase'="consent",elapsed'=0,allocations'=0}
  action tick = all {elapsed<30,elapsed'=elapsed+1,phase'=phase,allocations'=allocations}
  action consent = all {phase=="consent",elapsed<30,phase'="mint",elapsed'=elapsed,allocations'=allocations}
  action mint = all {phase=="mint",phase'="ready",elapsed'=elapsed,allocations'=allocations+1}
  action stop = all {phase'="closed",elapsed'=elapsed,allocations'=allocations}
  action expire = all {phase=="consent",elapsed>=30,phase'="closed",elapsed'=elapsed,allocations'=allocations}
  action lateResult = all {phase=="closed",phase'=phase,elapsed'=elapsed,allocations'=allocations}
  action step = any {tick,consent,mint,stop,expire,lateResult}
  val safety = allocations<=1 and (phase=="consent" implies allocations==0)
  run coldConsent = init.then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(consent).then(mint).expect(phase=="ready" and allocations==1 and safety)
  run cancelledConsent = init.then(tick).then(stop).then(lateResult).expect(allocations==0 and phase=="closed" and safety)
}
