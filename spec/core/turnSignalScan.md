# Synchronous turn signal scans

[Turn controller scans](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/turn-controller.ts#L122-L168)
iterate the actual array captured for a room. This is the scan of one such
array within the [turn event stack](./turnEventStack.md). The outer registry
owns array identities and the ordered snapshot for global abort. Its
telemetry dispatch starts only after this scan returns a changed result.

## Story: Resume the correct scan after a signal listener reenters

As a host I want the cursor of an abort scan to survive synchronous signal
callbacks. A nested abort can take ownership of a later turn. Starting a
turn in the same array can extend the scan while it is still on the stack.

### Each scan advances through the live captured array

A room scan excludes the captured calling turn. A global scan uses no
exclusion in its room array. Every cursor advances over the next slot.
For an eligible turn, the controller first stores its abort reason and
begins native signal delivery. A nested scan can see that reason and skip
the controller. The outer loop cannot advance while its delivery runs.

```quint
import turnControllers as T from "./turnControllers"
type SignalTurn = {turnId: int, aborted: bool, reason: str}
type ScanFrame = {scanId: int, cursor: int, excluded: int, reason: str, notifying: int, changed: bool}
type ScanReturn = {scanId: int, changed: bool}
type TurnSignalScan = {turns: List[SignalTurn], frames: List[ScanFrame], returned: List[ScanReturn], nextScan: int}
pure val initial: TurnSignalScan = {turns: List(), frames: List(), returned: List(), nextScan: 1}
pure val turnIdValues = T::turnIdValues
pure val excludedValues = T::selfIdValues
pure val reasonValues = Set("room-abort", "global-abort", "")
pure val emptyFrame: ScanFrame = {scanId: 0, cursor: 0, excluded: 0, reason: "", notifying: 0, changed: false}
pure val emptyTurn: SignalTurn = {turnId: 0, aborted: false, reason: ""}
pure def topScan(s: TurnSignalScan): ScanFrame = s.frames.nthOr(s.frames.length() - 1, emptyFrame)
pure def replaceScanTop(frame: ScanFrame, s: TurnSignalScan): List[ScanFrame] =
  s.frames.removeAt(s.frames.length() - 1).append(frame)
pure def mayEnterFromHost(s: TurnSignalScan): bool = s.frames.length() == 0 or topScan(s).notifying > 0
pure def canAppendSignalTurn(s: TurnSignalScan, turnId: int): bool =
  mayEnterFromHost(s) and turnId > 0 and not(s.turns.some(t => t.turnId == turnId))
pure def appendSignalTurn(s: TurnSignalScan, turnId: int, aborted: bool, reason: str): TurnSignalScan =
  { ...s, turns: s.turns.append({turnId: turnId, aborted: aborted, reason: if (aborted) reason else ""}) }
pure def canBeginSignalScan(s: TurnSignalScan, excluded: int): bool = mayEnterFromHost(s) and excluded >= 0
pure def beginSignalScan(s: TurnSignalScan, excluded: int, reason: str): TurnSignalScan =
  { ...s, frames: s.frames.append({scanId: s.nextScan, cursor: 0, excluded: excluded, reason: reason, notifying: 0, changed: false}), nextScan: s.nextScan + 1 }
pure def canVisitSignalTurn(s: TurnSignalScan): bool =
  s.frames.length() > 0 and topScan(s).notifying == 0 and topScan(s).cursor >= 0 and topScan(s).cursor < s.turns.length()
pure def visitSignalTurn(s: TurnSignalScan): TurnSignalScan = {
  val frame = topScan(s)
  val target = s.turns.nthOr(frame.cursor, emptyTurn)
  val eligible = target.turnId > 0 and not(target.aborted) and target.turnId != frame.excluded
  { ...s,
    turns: if (eligible) s.turns.listMap(t => if (t.turnId == target.turnId and not(t.aborted)) { ...t, aborted: true, reason: frame.reason } else t) else s.turns,
    frames: replaceScanTop({ ...frame, cursor: frame.cursor + 1, notifying: if (eligible) target.turnId else 0, changed: eligible or frame.changed }, s) }
}
pure def alwaysScanCursorValid(s: TurnSignalScan): bool = s.frames.every(f => f.cursor >= 0 and f.cursor <= s.turns.length())
pure def stepExistingAbortReasonsRetained(before: TurnSignalScan, after: TurnSignalScan): bool =
  before.turns.every(t => t.aborted implies after.turns.includes(t))
```

### The top delivery returns before its parent scan can resume

The current native signal delivery may append a turn or begin another scan.
Each scan owns its own result. Finish the top scan only after its delivery
returns and its cursor reaches the current end of the array. Later arrivals
and their signal reasons remain owned by the registry.

```quint
pure def canReturnSignalDelivery(s: TurnSignalScan): bool = s.frames.length() > 0 and topScan(s).notifying > 0
pure def returnSignalDelivery(s: TurnSignalScan): TurnSignalScan =
  { ...s, frames: replaceScanTop({ ...topScan(s), notifying: 0 }, s) }
pure def canFinishSignalScan(s: TurnSignalScan): bool =
  s.frames.length() > 0 and topScan(s).notifying == 0 and topScan(s).cursor == s.turns.length()
pure def finishSignalScan(s: TurnSignalScan): TurnSignalScan = {
  val frame = topScan(s)
  { ...s, frames: s.frames.removeAt(s.frames.length() - 1), returned: s.returned.append({scanId: frame.scanId, changed: frame.changed}) }
}
pure def alwaysNativeDeliveryOwnsAbortedTurn(s: TurnSignalScan): bool =
  s.frames.every(frame => frame.notifying != 0 implies frame.changed and s.turns.some(t => t.turnId == frame.notifying and t.aborted and t.reason == frame.reason))
pure def sometimesNativeDeliveryReenters(s: TurnSignalScan): bool =
  s.frames.length() >= 2 and s.frames.some(frame => frame.notifying > 0 and frame.scanId != topScan(s).scanId)
pure def sometimesRoomExclusionSurvives(s: TurnSignalScan): bool =
  s.frames.length() == 1 and topScan(s).changed and topScan(s).cursor == s.turns.length() and
    s.turns.some(t => t.turnId == topScan(s).excluded and not(t.aborted))
```
