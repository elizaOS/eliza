// At most two unallocated consent attempts and its immediate owner cancellation.
// Seconds abstract timer delivery. Mint retains its separate existing deadline.
module CloudSpeechConsentDeadline {
  var phase: str
  var elapsed: int
  var allocations: int
  var requests: int
  action init = all {phase'="consent",elapsed'=0,allocations'=0,requests'=1}
  action tick = all {elapsed<30,elapsed'=elapsed+1,phase'=phase,allocations'=allocations,requests'=requests}
  action consent = all {phase=="consent",elapsed<30,phase'="mint",elapsed'=elapsed,allocations'=allocations,requests'=requests}
  action mint = all {phase=="mint",phase'="ready",elapsed'=elapsed,allocations'=allocations+1,requests'=requests}
  action stop = all {phase'="closed",elapsed'=elapsed,allocations'=allocations,requests'=requests}
  action expire = all {phase=="consent",elapsed>=30,phase'="closed",elapsed'=elapsed,allocations'=allocations,requests'=requests}
  action lateResult = all {phase=="closed",phase'=phase,elapsed'=elapsed,allocations'=allocations,requests'=requests}
  action reset = all {phase=="consent",elapsed<30,requests'=if (requests==1) 2 else requests,phase'=if (requests==1) phase else "closed",elapsed'=elapsed,allocations'=allocations}
  action step = any {reset,tick,consent,mint,stop,expire,lateResult}
  val safety = requests<=2 and allocations<=1 and (phase=="consent" implies allocations==0)
  run resetThenMint = init.then(reset).then(consent).then(mint).expect(requests==2 and allocations==1 and safety)
  run secondReset = init.then(reset).then(reset).expect(phase=="closed" and allocations==0 and safety)
  run coldConsent = init.then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(consent).then(mint).expect(phase=="ready" and allocations==1 and safety)
  run cancelledConsent = init.then(tick).then(stop).then(lateResult).expect(allocations==0 and phase=="closed" and safety)
}
