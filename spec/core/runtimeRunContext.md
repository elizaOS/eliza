# Runtime run and room logging context

The `currentRunId` and `currentRoomId` fields in `packages/core/src/runtime.ts:604-605,805-832` at `72fed7e4069ecd35d61d886ab6eec5c02c137517` belong to the runtime object, independently of AsyncLocalStorage. startRun replaces both fields; endRun clears both; getCurrentRunId lazily creates only the run ID. No previous value is restored by endRun.

## Story: Keep runtime run context explicit

As a host I select logging context on an initialized or uninitialized runtime. Starting a second run replaces its current global context, and ending a run clears the current context even if another caller most recently installed it.

### Run context setters preserve the same runtime lifecycle state

```quint
import runtime as R from "./runtime"
type RuntimeRunContext = {kernel: R::Runtime, runId: str, roomId: str}
pure val initial: RuntimeRunContext = {kernel: R::initial, runId: "", roomId: ""}
pure val runIdValues = Set("run-a", "run-b")
pure val roomIdValues = Set("", "room-a", "room-b")
pure def canStartRun(s: RuntimeRunContext, runId: str, roomId: str): bool = runId != ""
pure def startRun(s: RuntimeRunContext, runId: str, roomId: str): RuntimeRunContext = { ...s, runId: runId, roomId: roomId }
pure def endRun(s: RuntimeRunContext): RuntimeRunContext = { ...s, runId: "", roomId: "" }
pure def canGetCurrentRun(s: RuntimeRunContext, runId: str): bool = runId != ""
pure def getCurrentRun(s: RuntimeRunContext, runId: str): RuntimeRunContext = if (s.runId == "") { ...s, runId: runId } else s
pure def canBeginInitialization(s: RuntimeRunContext): bool = R::canBeginInitialization(s.kernel)
pure def beginInitialization(s: RuntimeRunContext): RuntimeRunContext = { ...s, kernel: R::beginInitialization(s.kernel) }
pure def canCompleteInitialization(s: RuntimeRunContext, ok: bool): bool = R::canCompleteInitialization(s.kernel, ok)
pure def completeInitialization(s: RuntimeRunContext, ok: bool): RuntimeRunContext = { ...s, kernel: R::completeInitialization(s.kernel, ok) }
pure def stepContextDoesNotMutateKernel(before: RuntimeRunContext, via: str, after: RuntimeRunContext): bool = (via == "startRun" or via == "endRun" or via == "getCurrentRun") implies after.kernel == before.kernel
pure def stepLookupKeepsRoom(before: RuntimeRunContext, via: str, after: RuntimeRunContext): bool = via == "getCurrentRun" implies after.roomId == before.roomId
pure def sometimesRunWithoutRoom(s: RuntimeRunContext): bool = s.runId != "" and s.roomId == ""
```
