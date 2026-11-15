# Status and readiness

The owner's client and the device's updater both ask the host whether it is
healthy. Readiness is reported only from evidence gathered on the runtime
binding that is current: when a new runtime is bound, the old evidence no
longer counts. Reading status is a pure query: it never starts inference
and never reads the logs. The device updater's use of this answer is in
the [device image's runtime health check](../../os/update/runtimeHealth.md).
The research baseline is `packages/agent/src/api/{health-routes,status-routes}.ts`.

## Story: Report health and readiness to the owner and the device updater

> As the owner, and as the updater on my device, I can ask whether my agent
> is ready and get an answer about the runtime that is actually running,
> without that question costing a model call.

### Readiness comes from evidence of the runtime binding that is current

```quint
type Status = { binding: int, evidenceFrom: int, ready: bool, inferenceRuns: int, logReads: int, statusReads: int }
pure val initial: Status = { binding: 0, evidenceFrom: -1, ready: false, inferenceRuns: 0, logReads: 0, statusReads: 0 }
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
