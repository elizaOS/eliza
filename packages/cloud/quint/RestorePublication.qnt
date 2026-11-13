// Manifest-v3 restore phase contract. The serving route CAS is the point after
// which errors retry finalization rather than roll back the activated runtime.
module RestorePublication {
  var s: {
    phase: str,
    resume: str,
    previousStopped: bool,
    candidateCommitted: bool,
    attested: bool,
    probed: bool,
    routeNew: bool,
    previousRetired: bool,
    finalized: bool,
    failedAfterPublication: bool
  }
  action init = s' = {
    phase: "reserved",
    resume: "reserved",
    previousStopped: false,
    candidateCommitted: false,
    attested: false,
    probed: false,
    routeNew: false,
    previousRetired: false,
    finalized: false,
    failedAfterPublication: false
  }
  action seed = all {
    s.phase == "reserved",
    s' = s
      .with("phase", "vault_seeded")
  }
  action create = all {
    Set("reserved", "vault_seeded").contains(s.phase),
    s' = s
      .with("phase", "container_created")
  }
  action materialize = all {
    s.phase == "container_created",
    s' = s
      .with("phase", "restoring")
  }
  action commit = all {
    s.phase == "restoring",
    s' = s
      .with("phase", "committed")
      .with("candidateCommitted", true)
  }
  action boot = all {
    s.phase == "committed",
    s' = s
      .with("phase", "restart_attested")
      .with("previousStopped", true)
      .with("attested", true)
  }
  action probe = all {
    s.phase == "restart_attested",
    s' = s
      .with("phase", "probed")
      .with("probed", true)
  }
  action publish = all {
    s.phase == "probed",
    s' = s
      .with("phase", "published")
      .with("routeNew", true)
  }
  action finish = all {
    s.phase == "published",
    s' = s
      .with("phase", "finalized")
      .with("previousRetired", true)
      .with("finalized", true)
  }
  action error = all {
    not(Set("finalized", "failed_terminal", "failed_retryable").contains(s.phase)),
    s' = if (s.routeNew) s
      .with("failedAfterPublication", true)
    else if (Set("reserved", "vault_seeded", "container_created").contains(s.phase)) s
      .with("resume", s.phase)
      .with("phase", "failed_retryable")
    else s
      .with("phase", "failed_terminal")
      .with("previousStopped", false)
  }
  action resume = all {
    s.phase == "failed_retryable",
    s' = s
      .with("phase", s.resume)
  }
  action step = any {
    seed,
    create,
    materialize,
    commit,
    boot,
    probe,
    publish,
    finish,
    error,
    resume,
    s' = s
  }
  val invariant = and {
    s.routeNew implies (s.candidateCommitted and s.attested and s.probed),
    s.previousRetired implies s.routeNew,
    s.finalized implies (s.routeNew and s.previousRetired),
    (s.phase == "failed_terminal") implies not(s.routeNew),
    s.failedAfterPublication implies s.routeNew
  }
}
