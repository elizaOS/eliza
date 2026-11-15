// Hosted McpService temporarily connects to discover HTTP tool schemas. Stop
// fences the remaining discovery, removes lazy metadata and unregisters its tools.
module McpHostedDiscovery {
  var s: { service: str, discovery: str, transport: bool, tools: str, runtimeAction: str }

  action init = s' = {
    service: "running", discovery: "discovering", transport: true,
    tools: "none", runtimeAction: "none"
  }

  val discoveryDone = Set("ready", "failed", "canceled").contains(s.discovery)

  action discoveryReply(success: bool): bool = all {
    s.service == "running", s.discovery == "discovering",
    s' = if (success)
      s.with("discovery", "discovered").with("tools", "connected").with("runtimeAction", "mcp")
    else s.with("discovery", "failed")
  }

  action finishDiscovery = any { discoveryReply(true), discoveryReply(false) }

  action beginTemporaryClose = all {
    s.service == "running", s.discovery == "discovered",
    s' = s.with("discovery", "temporary-close").with("tools", "none").with("runtimeAction", "none")
  }

  action closeTransport = all {
    s.transport, s.service == "stopping" or s.discovery == "temporary-close",
    s' = s.with("transport", false)
      .with("discovery", if (s.discovery == "temporary-close") "temporary-closed"
        else s.discovery)
  }

  action publishLazy = all {
    s.service == "running", s.discovery == "temporary-closed",
    s' = s.with("discovery", "ready").with("tools", "lazy").with("runtimeAction", "mcp")
  }

  action replaceRuntimeAction = all {
    s.tools == "lazy", s.runtimeAction == "mcp",
    s' = s.with("runtimeAction", "replacement")
  }

  action requestStop = all {
    s.service == "running",
    s' = s.with("service", "stopping").with("tools", "none")
      .with("runtimeAction", if (s.runtimeAction == "mcp") "none" else s.runtimeAction)
  }

  action acknowledgeStop = all {
    s.service == "stopping", not(s.transport),
    s' = s.with("service", "stopped")
  }

  action cancelDiscovery = all {
    s.service != "running", not(discoveryDone),
    s' = s.with("discovery", "canceled")
  }

  action step = any {
    finishDiscovery, beginTemporaryClose, closeTransport, publishLazy,
    replaceRuntimeAction, requestStop, acknowledgeStop, cancelDiscovery, s' = s
  }

  val StopWithdrawsTools = s.service != "running" implies
    (s.tools == "none" and s.runtimeAction != "mcp")
  val AcknowledgedStopRetiresTransport = s.service == "stopped" implies not(s.transport)
  val LazyToolsRequireTemporaryClose =
    s.tools == "lazy" implies (s.discovery == "ready" and not(s.transport))

  temporal ReplacementActionRetained =
    always((s.runtimeAction == "replacement" implies next(s.runtimeAction) == "replacement").orKeep(s))

  temporal StopSettles = (s.service == "stopping").leadsTo(s.service == "stopped")
  temporal FairStopSettles =
    (closeTransport.weakFair(s) and acknowledgeStop.weakFair(s)) implies StopSettles
  temporal FairDiscoverySettles =
    (finishDiscovery.weakFair(s) and beginTemporaryClose.weakFair(s)
      and closeTransport.weakFair(s) and publishLazy.weakFair(s)
      and cancelDiscovery.weakFair(s)) implies eventually(discoveryDone)

  run StopWithdrawsPreviouslyLazyToolsTest = init.then(discoveryReply(true))
    .then(beginTemporaryClose).then(closeTransport).then(publishLazy)
    .expect(s.tools == "lazy" and LazyToolsRequireTemporaryClose)
    .then(requestStop).then(acknowledgeStop)
    .expect(s.service == "stopped" and StopWithdrawsTools)

  run DiscoveryCanSettleAfterStopTest = init.then(requestStop).then(closeTransport)
    .then(acknowledgeStop).then(cancelDiscovery)
    .expect(s.discovery == "canceled" and StopWithdrawsTools and AcknowledgedStopRetiresTransport)

  run ClosedTemporaryConnectionCannotPublishAfterStopTest = init.then(discoveryReply(true))
    .then(beginTemporaryClose).then(closeTransport).then(requestStop)
    .then(acknowledgeStop).then(cancelDiscovery)
    .expect(s.discovery == "canceled" and StopWithdrawsTools)

  run StopKeepsReplacementActionTest = init.then(discoveryReply(true))
    .then(beginTemporaryClose).then(closeTransport).then(publishLazy)
    .then(replaceRuntimeAction).then(requestStop).then(acknowledgeStop)
    .expect(s.runtimeAction == "replacement" and StopWithdrawsTools)

  run FailedDiscoveryStillRetiresTransportTest = init.then(discoveryReply(false))
    .then(requestStop).then(closeTransport).then(acknowledgeStop)
    .expect(s.discovery == "failed" and AcknowledgedStopRetiresTransport)
}
