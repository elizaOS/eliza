# Native activity tracker

The macOS Swift collector and the Node child process are platform effects. The public bridge delivers normalized focus changes, idle samples and process termination, scoped to the desktop owner's console session.

## Story: Observe my desktop activity while my collector is running

> As the desktop owner, I want to distinguish real focus changes and idle observations from corrupt subprocess output and from a collector that has already stopped.

### Only a valid line from the current collector is an observation

The stream decoder turns a parsed JSON line into one of the tagged local values. Timestamps are measured in milliseconds and idle time is measured as integral milliseconds at the boundary. Empty application or bundle labels still mark focus changes emitted by macOS. An omitted window title stays absent in the native read adapter.

```quint
type CollectorLine = Activated({ observedAtMs: int, bundleId: str, appName: str }) |
  Deactivated({ deactivatedAtMs: int, closedBundleId: str, closedAppName: str }) |
  IdleSample({ sampledAtMs: int, idleMs: int }) | MalformedLine
type CollectorPlatform = MacCollector | OtherCollector
type CollectorState = { generation: int, running: bool }
pure val initial: CollectorState = { generation: 0, running: false }
pure def validCollectorLine(line: CollectorLine): bool = match line {
  | Activated(sample) => sample.observedAtMs >= 0
  | Deactivated(sample) => sample.deactivatedAtMs >= 0
  | IdleSample(sample) => sample.sampledAtMs >= 0 and sample.idleMs >= 0
  | MalformedLine => false
}
pure def canStartCollector(s: CollectorState, platform: CollectorPlatform, binaryPresent: bool): bool =
  not(s.running) and platform == MacCollector and binaryPresent
pure def startCollector(s: CollectorState, platform: CollectorPlatform, binaryPresent: bool): CollectorState =
  { generation: s.generation + 1, running: true }
pure def mayPublishCollectorLine(s: CollectorState, generation: int, line: CollectorLine): bool =
  s.running and generation == s.generation and validCollectorLine(line)
pure def lawMalformedLineIsIgnored(s: CollectorState, generation: int): bool =
  not(mayPublishCollectorLine(s, generation, MalformedLine))
```

### Only the current process can close the collector

Stop asks the child to exit and retires it from the current stream. A duplicate close or a late callback from a replaced process has no current stream to change. The shell delivers either the clean exit callback or a fatal error for the tracked process.

```quint
pure def canStopCollector(s: CollectorState): bool = s.running
pure def stopCollector(s: CollectorState): CollectorState = { ...s, running: false }
pure def canObserveCollectorExit(s: CollectorState, generation: int): bool =
  s.running and generation == s.generation
pure def observeCollectorExit(s: CollectorState, generation: int): CollectorState =
  { ...s, running: false }
pure def stepCollectorGenerationNeverDecreases(before: CollectorState, after: CollectorState): bool =
  before.generation <= after.generation
pure def sometimesCollectorRuns(s: CollectorState): bool = s.running
pure val generationValues = Set(0, 1, 2, 3)
```
