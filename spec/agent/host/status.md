# Status and readiness

The owner's client and the device's updater both ask the host whether it is
healthy. Readiness is reported only from evidence gathered on the runtime
binding that is current: when a new runtime is bound, the old evidence no
longer counts. Reading status is a pure query: it never starts inference
and never reads the logs. The device updater's use of this answer is in the
[device image's runtime health check](../../os/update/runtimeHealth.md).

## Story: Report health and readiness to the owner and the device updater

> As the owner, and as the updater on my device, I can ask whether my agent
> is ready and get an answer about the runtime that is actually running,
> without that question costing a model call.

### Readiness comes from evidence of the runtime binding that is current

```quint
type Status = { binding: int, evidenceFrom: int, ready: bool, inferenceRuns: int, logReads: int, statusReads: int, warms: int }
pure val initial: Status = { binding: 0, evidenceFrom: -1, ready: false, inferenceRuns: 0, logReads: 0, statusReads: 0, warms: 0 }
pure def bindRuntime(s: Status): Status = { ...s, binding: s.binding + 1, ready: false }
pure def canReportReady(s: Status): bool = not(s.ready)
pure def reportReady(s: Status): Status = { ...s, ready: true, evidenceFrom: s.binding }
pure def alwaysReadinessFromCurrentBinding(s: Status): bool = s.ready implies s.evidenceFrom == s.binding
pure def sometimesReadyAfterRebinding(s: Status): bool = s.ready and s.binding >= 1
```

### Reading status never starts inference or reads the logs

```quint
pure def readStatus(s: Status): Status = { ...s, statusReads: s.statusReads + 1 }
pure def runTurn(s: Status): Status = { ...s, inferenceRuns: s.inferenceRuns + 1 }
pure def readLogs(s: Status): Status = { ...s, logReads: s.logReads + 1 }
pure def stepStatusReadIsAQuery(before: Status, via: str, after: Status): bool =
  via == "readStatus" implies after.inferenceRuns == before.inferenceRuns and after.logReads == before.logReads and after.ready == before.ready
pure def sometimesStatusReadWhileServing(s: Status): bool = s.statusReads > 0 and s.inferenceRuns > 0
```

## Story: Warm my cloud connection before I talk, without spending a model call

> As the owner, when I open the chat or start talking my client asks the
> agent to warm its cloud inference connection, so my first reply comes
> sooner; the warming never runs a model, never delays my own request and
> never turns into background traffic.

### Warming opens the cloud connection only, at most once a minute per endpoint and credential

The warm route answers warmed only when the agent's text models are served
by its cloud account and it holds that account's credential, no warm of
that endpoint and credential was attempted in the last minute, and the
cloud answered.
Without a cloud text model or credential it answers that there is nothing to
warm; within the minute it answers debounced; otherwise unreachable. Every
answer is advisory: warming runs no turn and no model, reads no logs and
does not change readiness. The client's own debounce is the
[cloud client's warmup rule](../../cloud/client.md).

```quint
type WarmReply = Warmed | NothingToWarm | WarmDebounced | WarmUnreachable
pure def warmReply(cloudText: bool, credential: bool, recentlyWarmed: bool, reachable: bool): WarmReply =
  if (not(cloudText and credential)) NothingToWarm else if (recentlyWarmed) WarmDebounced else if (reachable) Warmed else WarmUnreachable
pure def lawWarmedNeedsACloudTextModel(cloudText: bool, credential: bool, recentlyWarmed: bool, reachable: bool): bool =
  warmReply(cloudText, credential, recentlyWarmed, reachable) == Warmed implies (cloudText and credential and not(recentlyWarmed))
pure def lawRecentWarmIsNotRepeated(cloudText: bool, credential: bool, reachable: bool): bool =
  warmReply(cloudText, credential, true, reachable) != Warmed
pure def warmCloud(s: Status): Status = { ...s, warms: s.warms + 1 }
pure def stepWarmingIsNotATurn(before: Status, via: str, after: Status): bool =
  via == "warmCloud" implies (after.inferenceRuns == before.inferenceRuns and after.logReads == before.logReads and after.ready == before.ready and after.evidenceFrom == before.evidenceFrom)
pure def sometimesWarmedBeforeATurn(s: Status): bool = s.warms > 0 and s.inferenceRuns > 0
```
