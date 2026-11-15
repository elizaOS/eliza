// Finite renderer/host/relay boundary projection. Paid settlement is composed
// with speech_continuity; this model never assumes an acknowledgement arrives.
module CloudSpeechLeaseBridge {
  type State = {
    phase: str, owner: int, boundOwner: int, requests: int,
    negotiated: bool, paid: int, host: int, client: int,
    pending: int, allocated: Set[int], stt: Set[int], tts: Set[int],
    capture: bool, retired: bool
  }
  var s: State
  action init = s' = {
    phase: "consent", owner: 0, boundOwner: 0, requests: 1,
    negotiated: false, paid: 0, host: 0, client: 0,
    pending: 0, allocated: Set(), stt: Set(), tts: Set(),
    capture: false, retired: false
  }
  action reset = all {
    s.phase == "consent",
    s' = if (s.requests == 1) s.with("requests", 2)
      else s.with("phase", "closed")
  }
  action consent = all {
    s.phase == "consent", s.owner == s.boundOwner,
    s' = s.with("phase", "admitted")
  }
  action mint = all {
    s.phase == "admitted", s.owner == s.boundOwner,
    s' = s.with("phase", "await-mint").with("paid", 1).with("allocated", Set(1))
  }
  action mintAck = all {
    s.phase == "await-mint", s.owner == s.boundOwner,
    s' = s.with("phase", "minted")
  }
  action ready(supports: bool): bool = all {
    s.phase == "minted", s.owner == s.boundOwner,
    s' = s.with("phase", "live").with("host", 1).with("client", 1)
      .with("negotiated", supports).with("capture", true)
  }
  action reserve = all {
    s.phase == "live", s.negotiated, s.owner == s.boundOwner,
    s.paid < 3, s.pending == 0,
    s' = s.with("pending", s.paid + 1)
      .with("allocated", s.allocated.union(Set(s.paid + 1)))
  }
  action grant = all {
    s.phase == "live", s.owner == s.boundOwner, s.pending > 0,
    s' = s.with("paid", s.pending).with("pending", 0)
  }
  // Wrong session, duplicate, reordered and post-Stop frames are harmless.
  action hostAck(session: int, window: int): bool =
    s' = if (s.phase == "live" and s.owner == s.boundOwner and
      s.negotiated and session == 0 and window > s.host and
      window <= s.host + 1 and window <= s.paid)
      s.with("host", window) else s
  action clientAck(session: int, window: int): bool =
    s' = if (s.phase == "live" and s.owner == s.boundOwner and
      s.negotiated and session == 0 and window > s.client and
      window <= s.client + 1 and window <= s.host)
      s.with("client", window) else s
  action stop = s' = s.with("phase", "closed").with("capture", false)
  action ownerChange = all {
    s.owner == 0,
    s' = s.with("owner", 1).with("phase", "closed").with("capture", false)
  }
  // The host's retained deadline still closes a session after a lost relay ack.
  action expiry = all {
    s.phase.in(Set("await-mint", "minted", "live")),
    s' = s.with("phase", "closed").with("capture", false)
  }
  action settleStt(window: int): bool = all {
    s.phase == "closed", s.allocated.contains(window),
    s' = s.with("stt", s.stt.union(Set(window)))
  }
  action settleTts(window: int): bool = all {
    s.phase == "closed", s.allocated.contains(window),
    s' = s.with("tts", s.tts.union(Set(window)))
  }
  action confirm = all {
    s.phase == "closed", s.allocated.subseteq(s.stt), s.allocated.subseteq(s.tts),
    s' = s.with("retired", true)
  }
  action lostAck = s' = s
  action step = {
    nondet session = 0.to(1).oneOf()
    nondet window = 1.to(4).oneOf()
    any {
      reset, consent, mint, mintAck, ready(true), ready(false), reserve, grant,
      hostAck(session, window), clientAck(session, window), stop, ownerChange,
      expiry, settleStt(window), settleTts(window), confirm, lostAck
    }
  }
  val WindowAuthority = s.client <= s.host and s.host <= s.paid and s.paid <= 3
  val NoForeignCapture = s.capture implies (s.phase == "live" and s.owner == s.boundOwner)
  val NoUnfundedWindow = 1.to(s.paid).subseteq(s.allocated)
  val RetainedSettlement = s.retired implies
    (s.phase == "closed" and s.allocated.subseteq(s.stt) and s.allocated.subseteq(s.tts))
  val ConsentResetBound = s.requests <= 2 and (s.phase == "consent" implies s.paid == 0)
  val safety = WindowAuthority and NoForeignCapture and NoUnfundedWindow and RetainedSettlement and ConsentResetBound
  temporal ClosedEventuallyRetires = always(s.phase == "closed" implies eventually(s.retired))
  temporal FairClosedRetires = (
    settleStt(1).weakFair(s) and settleStt(2).weakFair(s) and settleStt(3).weakFair(s) and
    settleTts(1).weakFair(s) and settleTts(2).weakFair(s) and settleTts(3).weakFair(s) and
    confirm.weakFair(s)
  ) implies ClosedEventuallyRetires
  run resetThenOneMintTest = init.then(reset).then(consent).then(mint).then(mintAck).then(ready(true))
    .expect(s.requests == 2 and s.paid == 1 and s.capture)
  run repeatedResetNeverPaysTest = init.then(reset).then(reset)
    .expect(s.phase == "closed" and s.allocated == Set())
  run lostMintAckRetainsPaidReceiptTest = init.then(consent).then(mint).then(lostAck).then(expiry)
    .expect(s.allocated == Set(1) and not(s.capture) and not(s.retired))
  run lostHostAckUsesOldDeadlineTest = init.then(consent).then(mint).then(mintAck).then(ready(true))
    .then(reserve).then(grant).then(lostAck).then(expiry)
    .expect(s.host == 1 and s.paid == 2 and not(s.capture) and not(s.retired))
  run wrongSessionCannotExtendTest = init.then(consent).then(mint).then(mintAck).then(ready(true))
    .then(reserve).then(grant).then(hostAck(1, 2)).then(clientAck(1, 2))
    .expect(s.host == 1 and s.client == 1)
  run delayedAckCannotRegressTest = init.then(consent).then(mint).then(mintAck).then(ready(true))
    .then(reserve).then(grant).then(hostAck(0, 2)).then(clientAck(0, 2))
    .then(reserve).then(grant).then(hostAck(0, 3)).then(clientAck(0, 3)).then(clientAck(0, 2))
    .expect(s.host == 3 and s.client == 3)
  run stoppedReservationStillNeedsBothReceiptsTest = init.then(consent).then(mint).then(mintAck).then(ready(true))
    .then(reserve).then(stop).then(settleStt(1)).then(settleTts(1))
    .expect(s.allocated == Set(1, 2) and not(s.retired) and safety)
  run ownerChangeRejectsLateAckTest = init.then(consent).then(mint).then(mintAck).then(ready(true))
    .then(reserve).then(grant).then(ownerChange).then(hostAck(0, 2)).then(clientAck(0, 2))
    .expect(s.host == 1 and s.client == 1 and not(s.capture))
  run unsupportedClientRetainsOneWindowTest = init.then(consent).then(mint).then(mintAck).then(ready(false))
    .then(hostAck(0, 2)).then(clientAck(0, 2))
    .expect(s.host == 1 and s.client == 1 and s.allocated == Set(1))
}
