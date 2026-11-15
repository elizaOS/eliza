// Final CONTAINER_PROVISION attempt after a generation-owned parent handoff.
// The job's terminal receipt and the app's durable READY result are distinct.
module app_deploy_ready_writeback {
  type AppPhase = Building | Deploying | Ready | AppFailed
  type JobPhase = Working | ErrorObserved | Expired | Completed | JobFailed
  type State = {
    app: AppPhase, job: JobPhase, currentGeneration: bool,
    sameTenant: bool, readyReceipt: bool,
  }
  var s: State

  action init = {
    nondet app = Set(Building, Deploying).oneOf()
    nondet sameTenant = Set(false, true).oneOf()
    s' = { app: app, job: Working, currentGeneration: true,
      sameTenant: sameTenant, readyReceipt: false }
  }
  action publishReady = all {
    s.job == Working, s.currentGeneration, s.sameTenant, s.app == Deploying,
    s' = { ...s, app: Ready, readyReceipt: true },
  }
  action acknowledge = all {
    s.job == Working, s.readyReceipt,
    s' = s.with("job", Completed),
  }
  action observeError = all {
    s.job == Working,
    s' = s.with("job", ErrorObserved),
  }
  action expire = all {
    s.job.in(Set(Working, ErrorObserved)),
    s' = s.with("job", Expired),
  }
  action supersede = all {
    s.currentGeneration, s.app.in(Set(Ready, AppFailed)),
    s' = { ...s, app: Building, currentGeneration: false },
  }
  // Ordinary exhaustion and stale-job exhaustion share the dependent SQL
  // writeback. A reported error still terminalizes its job after READY.
  pure def failJob(state: State): State = {
    ...state,
    job: JobFailed,
    app: if (state.currentGeneration and state.sameTenant and
        state.app.in(Set(Building, Deploying))) AppFailed else state.app,
  }
  action settleError = all {
    s.job == ErrorObserved,
    s' = failJob(s),
  }
  action recoverExpired = all {
    s.job == Expired,
    s' = failJob(s),
  }
  action idle = s' = s
  action step = any {
    publishReady, acknowledge, observeError, expire, supersede, settleError, recoverExpired, idle,
  }

  val ReadyMatchesReceipt = s.currentGeneration implies (s.app == Ready) == s.readyReceipt
  val FailedAppNeedsFailedJob = s.app == AppFailed implies
    s.currentGeneration and s.sameTenant and not(s.readyReceipt) and s.job == JobFailed
  val SupersededAppRemainsBuilding = not(s.currentGeneration) implies s.app == Building
  temporal ReadyReceiptIsDurable = always(and {
    s.readyReceipt implies next(s.readyReceipt),
    (s.app == Ready and next(s.currentGeneration)) implies next(s.app) == Ready,
  }.orKeep(s))

  action stableInit = {
    nondet job = Set(ErrorObserved, Expired).oneOf()
    nondet ready = Set(false, true).oneOf()
    s' = { app: if (ready) Ready else Deploying, job: job,
      currentGeneration: true, sameTenant: true, readyReceipt: ready }
  }
  action stableStep = any { settleError, recoverExpired, idle }
  temporal JobEventuallyFails = eventually(s.job == JobFailed)
  temporal FairTerminalSettlement =
    (settleError.weakFair(s) and recoverExpired.weakFair(s)) implies JobEventuallyFails

  // Fix the initial mode for the executable traces. The checker explores all
  // phase and tenant combinations from init.
  action ownedDeploy = s' = { app: Deploying, job: Working, currentGeneration: true,
    sameTenant: true, readyReceipt: false }
  run lostReadyReplyPreservesAppTest = ownedDeploy.then(publishReady)
    .then(observeError).then(settleError)
    .expect(s.job == JobFailed and s.app == Ready and s.readyReceipt)

  run preReadyErrorFailsAppTest = ownedDeploy.then(observeError).then(settleError)
    .expect(s.job == JobFailed and s.app == AppFailed and not(s.readyReceipt))

  run expiredReadyAttemptPreservesAppTest = ownedDeploy.then(publishReady)
    .then(observeError).then(expire).then(recoverExpired)
    .expect(s.job == JobFailed and s.app == Ready and s.readyReceipt)

  run oldFailureDoesNotWriteReplacementTest = ownedDeploy.then(publishReady)
    .then(supersede).then(observeError).then(settleError)
    .expect(s.job == JobFailed and SupersededAppRemainsBuilding and s.readyReceipt)
}
