// Auth runtime owns the login-webhook-delivery registration. Core keeps one
// interval for that registration and an independently attached task adapter.
// Closing the listener precedes aborting the worker. A claimed delivery keeps
// the database until its transport and durable receipt settle.
module LoginWebhookTimer {
  pure val Jobs = Set("first", "next")
  var s: {
    auth: str, generation: int, storageOpen: bool, adapter: bool, registered: bool,
    timer: bool, callback: str, current: str, result: str, queue: str -> str,
    claims: int, claimsAtAbort: int
  }
  action init = s' = {
    auth: "off", generation: 0, storageOpen: false, adapter: false, registered: false,
    timer: false, callback: "idle", current: "none", result: "none",
    queue: Jobs.mapBy(_ => "pending"), claims: 0, claimsAtAbort: 0
  }
  action attachAdapter = all {
    not(s.adapter), s' = { ...s, adapter: true, timer: true }
  }
  action detachAdapter = all {
    s.adapter, s' = { ...s, adapter: false, timer: s.registered }
  }
  action startAuth = all {
    s.auth.in(Set("off", "closed")), s.generation < 2,
    s' = { ...s, auth: "serving", generation: s.generation + 1,
      storageOpen: true, registered: true, timer: true }
  }
  action stopAuth = all {
    s.auth == "serving", s' = { ...s, auth: "closing-listener" }
  }
  action retireWorker = all {
    s.auth == "closing-listener",
    s' = { ...s, auth: "draining", registered: false, timer: s.adapter,
      claimsAtAbort: s.claims }
  }
  val due = Jobs.filter(job => s.queue.get(job) == "pending")
  action queueCallback = all {
    s.timer, s.registered, s.callback == "idle", due.size() > 0,
    s' = { ...s, callback: "queued" }
  }
  action startCallback = all {
    s.callback == "queued", s.registered, s' = { ...s, callback: "scan" }
  }
  action finishCallback = all {
    (s.callback == "queued" and not(s.registered)) or
      (s.callback == "scan" and (not(s.registered) or due.size() == 0)),
    s' = { ...s, callback: "idle" }
  }
  action beginClaim(job: str): bool = all {
    s.callback == "scan", s.registered, due.contains(job),
    s' = { ...s, callback: "claim", current: job, claims: s.claims + 1 }
  }
  action claimCommitted = all {
    s.callback == "claim",
    s' = { ...s, callback: "send", queue: s.queue.set(s.current, "processing") }
  }
  action settleDelivery(ok: bool): bool = all {
    s.callback == "send",
    s' = { ...s, callback: "receipt", result: if (ok) "delivered" else "failed" }
  }
  action commitReceipt = all {
    s.callback == "receipt", s.storageOpen,
    s' = { ...s, callback: "scan", queue: s.queue.set(s.current, s.result),
      current: "none", result: "none" }
  }
  action closeAuth = all {
    s.auth == "draining", s.callback == "idle",
    s' = { ...s, auth: "closed", storageOpen: false }
  }
  action finishWork = any { startCallback, finishCallback, claimCommitted,
    settleDelivery(true), settleDelivery(false), commitReceipt }
  action beginAnyClaim = { nondet job = Jobs.oneOf(); beginClaim(job) }
  action progressWork = any { queueCallback, beginAnyClaim, finishWork }
  action step = any { attachAdapter, detachAdapter, startAuth, stopAuth,
    retireWorker, closeAuth, progressWork, s' = s }

  val TimerFollowsOwners = s.timer == (s.adapter or s.registered)
  val StorageOutlivesCallback = s.callback != "idle" implies s.storageOpen
  val WorkerStopsAdmitting = s.auth == "draining" implies s.claims == s.claimsAtAbort
  val AuthOwnsRegistration = s.registered == s.auth.in(Set("serving", "closing-listener"))
  temporal CloseWithoutFairness = s.auth.in(Set("closing-listener", "draining"))
    .leadsTo(s.auth == "closed")
  temporal CloseCompletes = (retireWorker.weakFair(s) and finishWork.weakFair(s)
    and closeAuth.weakFair(s)).implies(CloseWithoutFairness)
  temporal DetachedDeliveryProgress = progressWork.weakFair(s).implies(Jobs.forall(job =>
    (s.auth == "serving" and not(s.adapter) and s.queue.get(job) == "pending")
      .leadsTo(s.auth != "serving" or s.queue.get(job).in(Set("delivered", "failed")))))

  run detachThenDrainAndRestartTest = init.then(attachAdapter).then(startAuth).then(detachAdapter)
    .expect(s.timer and not(s.adapter) and TimerFollowsOwners)
    .then(queueCallback).then(startCallback).then(beginClaim("first")).then(claimCommitted)
    .then(stopAuth).then(retireWorker).expect(not(s.timer) and s.storageOpen and s.callback == "send")
    .then(settleDelivery(true)).then(commitReceipt).then(finishCallback).then(closeAuth)
    .expect(s.queue.get("first") == "delivered" and s.queue.get("next") == "pending")
    .then(startAuth).then(queueCallback).then(startCallback).then(beginClaim("next")).then(claimCommitted)
    .then(settleDelivery(true)).then(commitReceipt).then(finishCallback)
    .expect(s.generation == 2 and s.queue.get("next") == "delivered")
  run failedReceiptKeepsAdapterTimerTest = init.then(attachAdapter).then(startAuth)
    .then(queueCallback).then(startCallback).then(beginClaim("first")).then(claimCommitted)
    .then(stopAuth).then(retireWorker).then(settleDelivery(false)).then(commitReceipt)
    .then(finishCallback).then(closeAuth)
    .expect(s.timer and s.adapter and s.queue.get("first") == "failed" and s.queue.get("next") == "pending")
  run queuedCallbackAbortsBeforeInvocationTest = init.then(startAuth).then(queueCallback)
    .then(stopAuth).then(retireWorker).then(finishCallback).then(closeAuth)
    .expect(s.claims == 0 and Jobs.forall(job => s.queue.get(job) == "pending"))
}

// A verified request can publish immediate delivery work outside its tenant
// transaction. The tracked fan-out joins all destination promises before Auth
// shutdown releases the database, including when a sibling fails before insert.
module LoginRequestWebhookFanout {
  var s: {
    auth: str, tracked: bool, healthy: str, unreadable: str,
    receipt: str, result: str, fanout: str, responded: bool
  }
  action init = s' = {
    auth: "serving", tracked: false, healthy: "none", unreadable: "none",
    receipt: "none", result: "none", fanout: "none", responded: false
  }
  action emit = all {
    s.auth == "serving", s.fanout == "none",
    s' = { ...s, tracked: true, healthy: "preparing", unreadable: "preparing", fanout: "pending" }
  }
  action respond = all {
    s.auth == "serving", s.fanout != "none", not(s.responded),
    s' = { ...s, responded: true }
  }
  action rejectUnreadable = all {
    s.unreadable == "preparing", s' = { ...s, unreadable: "rejected" }
  }
  action enqueueHealthy = all {
    s.healthy == "preparing", s.auth != "closed",
    s' = { ...s, healthy: "queued", receipt: "pending" }
  }
  action claimHealthy = all {
    s.healthy == "queued", s.auth != "closed",
    s' = { ...s, healthy: "sending", receipt: "processing" }
  }
  action receiveHealthy(ok: bool): bool = all {
    s.healthy == "sending",
    s' = { ...s, healthy: "writing", result: if (ok) "delivered" else "failed" }
  }
  action commitHealthy = all {
    s.healthy == "writing", s.auth != "closed",
    s' = { ...s, healthy: "settled", receipt: s.result }
  }
  val siblingsSettled = s.healthy == "settled" and s.unreadable == "rejected"
  action joinFanout = all {
    s.tracked, siblingsSettled,
    s' = { ...s, tracked: false, fanout: "failed" }
  }
  action requestStop = all {
    s.auth == "serving", s' = { ...s, auth: "closing-listener" }
  }
  action beginDrain = all {
    s.auth == "closing-listener", s' = { ...s, auth: "draining" }
  }
  action closeAuth = all {
    s.auth == "draining", not(s.tracked), s' = { ...s, auth: "closed" }
  }
  action settleBranches = any { rejectUnreadable, enqueueHealthy, claimHealthy,
    receiveHealthy(true), receiveHealthy(false), commitHealthy, joinFanout }
  action step = any { emit, respond, requestStop, beginDrain, settleBranches, closeAuth, s' = s }
  val siblingsActive = s.fanout != "none" and not(siblingsSettled)
  val StorageOutlivesSiblings = siblingsActive implies s.auth != "closed"
  val FanoutTracksSiblings = siblingsActive implies s.tracked
  val FailureFollowsSiblings = s.fanout == "failed" implies siblingsSettled and not(s.tracked)
  temporal CloseCompletes = (beginDrain.weakFair(s) and settleBranches.weakFair(s)
    and closeAuth.weakFair(s)).implies(
      s.auth.in(Set("closing-listener", "draining")).leadsTo(s.auth == "closed"))
  temporal CloseWithoutFairness = (s.auth == "draining" and s.healthy == "sending")
    .leadsTo(s.auth == "closed")

  // Promise.all used to release the parent receipt on the first rejection.
  action legacyFailFast = all {
    s.tracked, s.unreadable == "rejected",
    s' = { ...s, tracked: false, fanout: "failed" }
  }
  run failedConfigKeepsHealthyReceiptTest = init.then(emit).then(rejectUnreadable)
    .then(enqueueHealthy).then(claimHealthy).then(respond).then(requestStop).then(beginDrain)
    .expect(s.tracked and s.responded and s.receipt == "processing" and StorageOutlivesSiblings)
    .then(receiveHealthy(true)).then(commitHealthy).then(joinFanout).then(closeAuth)
    .expect(s.receipt == "delivered" and s.fanout == "failed" and FailureFollowsSiblings)
  run failFastCloseWitnessTest = init.then(emit).then(enqueueHealthy).then(claimHealthy)
    .then(rejectUnreadable).then(legacyFailFast).then(requestStop).then(beginDrain).then(closeAuth)
    .expect(not(StorageOutlivesSiblings) and not(FanoutTracksSiblings) and s.receipt == "processing")
}
