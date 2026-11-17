# Runtime run and room logging context

The `currentRunId` and `currentRoomId` fields of the runtime object in `runtime.ts`, independent of AsyncLocalStorage and of the [runtime lifecycle](./runtime.md), which these setters never read or change.

## Story: Keep runtime run context explicit

> As a host, I want to select the logging context on an initialized or
> uninitialized runtime, so that every log line names the run and room it
> belongs to.

Starting a second run replaces the current context, and ending a run clears it even if another caller most recently installed it.

### Starting a run replaces both fields, ending one clears both, and a lookup creates only the run ID

No previous value is restored when a run ends. Looking up the current run creates a run ID only when none is set and never changes the room.

```quint
type RuntimeRunContext = {runId: str, roomId: str}
pure val initial: RuntimeRunContext = {runId: "", roomId: ""}
pure val runIdValues = Set("run-a", "run-b")
pure val roomIdValues = Set("", "room-a", "room-b")
pure def canStartRun(s: RuntimeRunContext, runId: str, roomId: str): bool = runId != ""
pure def startRun(s: RuntimeRunContext, runId: str, roomId: str): RuntimeRunContext = { runId: runId, roomId: roomId }
pure def endRun(s: RuntimeRunContext): RuntimeRunContext = initial
pure def canGetCurrentRun(s: RuntimeRunContext, runId: str): bool = runId != ""
pure def getCurrentRun(s: RuntimeRunContext, runId: str): RuntimeRunContext = if (s.runId == "") { ...s, runId: runId } else s
pure def lawStartRunReplacesBoth(s: RuntimeRunContext, runId: str, roomId: str): bool = startRun(s, runId, roomId) == {runId: runId, roomId: roomId}
pure def stepEndRunClearsBoth(before: RuntimeRunContext, via: str, after: RuntimeRunContext): bool = via == "endRun" implies after.runId == "" and after.roomId == ""
pure def stepLookupCreatesOnlyRunId(before: RuntimeRunContext, via: str, after: RuntimeRunContext): bool = via == "getCurrentRun" implies after.roomId == before.roomId and after.runId != "" and (before.runId != "" implies after.runId == before.runId)
pure def sometimesRunWithoutRoom(s: RuntimeRunContext): bool = s.runId != "" and s.roomId == ""
```
