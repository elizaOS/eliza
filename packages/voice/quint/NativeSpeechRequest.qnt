// createNativeSpeechRequests. Binding changes are permanent for this request.
// Work must obey the documented interrupted/owned cancellation contract.
module NativeSpeechRequest {
  var s: {
    phase: str,
    binding: bool,
    callerAborted: bool,
    ownedAborted: bool,
    watching: bool,
    returned: bool,
    cancelCount: int
  }
  action init = s' = {
    phase: "initial",
    binding: true,
    callerAborted: false,
    ownedAborted: false,
    watching: false,
    returned: false,
    cancelCount: 0
  }
  action start = all {
    s.phase == "initial",
    s' = if (s.binding and not(s.callerAborted)) s
      .with("phase", "running")
      .with("watching", true) else s
      .with("phase", "rejected")
  }
  action invalidate = s' = s
    .with("binding", false)
    .with("ownedAborted", s.ownedAborted or s.watching)
    .with("cancelCount", s.cancelCount + (if (s.watching and not(s.ownedAborted)) 1 else 0))
  action abort = s' = s
    .with("callerAborted", true)
    .with("ownedAborted", s.ownedAborted or s.watching)
    .with("cancelCount", s.cancelCount + (if (s.watching and not(s.ownedAborted)) 1 else 0))
  action settle = all {
    s.phase == "running",
    s' = if (s.binding and not(s.callerAborted) and not(s.ownedAborted)) s
      .with("phase", "returned")
      .with("returned", true)
      .with("watching", false) else s
      .with("phase", "rejected")
      .with("watching", false)
  }
  action failWork = all {
    s.phase == "running",
    s' = s
      .with("phase", "rejected")
      .with("watching", false)
  }
  action step = any {
    start,
    invalidate,
    abort,
    settle,
    failWork,
    s' = s
  }
  val invariant = and {
    s.cancelCount <= 1,
    s.returned implies s.phase == "returned",
    Set("returned", "rejected").contains(s.phase) implies not(s.watching),
    s.ownedAborted implies not(s.phase == "running" and s.returned)
  }
}
