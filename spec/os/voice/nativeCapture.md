# Native live capture lifecycle

One native live capture, reserved for one host epoch: the assistant process
that admitted it. Its start runs in two steps, a native start and a start
report to the host. A phone call may block new starts without revoking
delivery to the host that already admitted this capture. A host that
changes epoch never becomes the original epoch again. The capture feeds a
[live session](./liveSession.md); [voice capture](./capture.md) owns the
turn around it.

## Story: Keep a live capture's ending even when a call interrupts it

> As a person whose call interrupts live dictation, I want the assistant to
> learn that the capture ended, and a capture that never really started to
> leave no trace.

### A start the host never heard about is discarded

A native start goes ahead only while the host is open and starts are
allowed, and it counts as started only once it is reported to that same
host. A start blocked before its report is refused and discarded, never
reported.

```quint
type NativeCapturePhase = CaptureReserved | CaptureStarting | CaptureRunning | EndPending | CaptureEnded | StartRefused
type NativeCapture = { phase: NativeCapturePhase, hostOpen: bool, startAllowed: bool, reported: bool,
  discarded: bool, delivered: bool, deliveryRequired: bool, consumed: bool }
pure val initial: NativeCapture = { phase: CaptureReserved, hostOpen: true, startAllowed: true, reported: false,
  discarded: false, delivered: false, deliveryRequired: false, consumed: false }
pure def canNativeStart(c: NativeCapture): bool = c.phase == CaptureReserved
pure def nativeStart(c: NativeCapture): NativeCapture =
  if (c.hostOpen and c.startAllowed) { ...c, phase: CaptureStarting } else { ...c, phase: StartRefused, discarded: true }
pure def canReportStart(c: NativeCapture): bool = c.phase == CaptureStarting
pure def reportStart(c: NativeCapture): NativeCapture =
  if (c.hostOpen and c.startAllowed) { ...c, phase: CaptureRunning, reported: true }
  else { ...c, phase: StartRefused, discarded: true }
pure def canBlockStarts(c: NativeCapture): bool = c.startAllowed
pure def blockStarts(c: NativeCapture): NativeCapture = { ...c, startAllowed: false }
pure def canAllowStarts(c: NativeCapture): bool = not(c.startAllowed)
pure def allowStarts(c: NativeCapture): NativeCapture = { ...c, startAllowed: true }
pure def canRetireHost(c: NativeCapture): bool = c.hostOpen
pure def retireHost(c: NativeCapture): NativeCapture = { ...c, hostOpen: false }
pure def alwaysRefusedStartDiscarded(c: NativeCapture): bool =
  c.phase == StartRefused implies c.discarded and not(c.reported)
pure def alwaysReportFollowsStart(c: NativeCapture): bool =
  ((c.phase == CaptureReserved or c.phase == CaptureStarting) implies not(c.reported) and not(c.discarded)) and
  ((c.phase == CaptureRunning or c.phase == EndPending or c.phase == CaptureEnded) implies c.reported and not(c.discarded))
pure def sometimesLateBlockDiscards(c: NativeCapture): bool = c.phase == StartRefused and c.hostOpen
```

### An admitted capture's end reaches its still-current host

An interruption of a reported capture is owed to the host as an end event;
an interruption before the report discards the capture. The end is
delivered to the host that admitted the capture whenever that host is still
open, even while new starts are blocked by a call. A host that changed
epoch is not sent it.

```quint
pure def canInterruptCapture(c: NativeCapture): bool =
  c.phase == CaptureReserved or c.phase == CaptureStarting or c.phase == CaptureRunning
pure def interruptCapture(c: NativeCapture): NativeCapture =
  if (c.reported) { ...c, phase: EndPending } else { ...c, phase: StartRefused, discarded: true }
pure def canDeliverEnd(c: NativeCapture): bool = c.phase == EndPending
pure def deliverEnd(c: NativeCapture): NativeCapture =
  { ...c, phase: CaptureEnded, consumed: true, deliveryRequired: c.hostOpen, delivered: c.hostOpen }
pure def alwaysTerminalDelivered(c: NativeCapture): bool = c.consumed and c.deliveryRequired implies c.delivered
pure def alwaysNoUnreportedEnd(c: NativeCapture): bool = c.delivered implies c.reported and not(c.discarded)
pure def sometimesEndDeliveredDuringCall(c: NativeCapture): bool = c.delivered and not(c.startAllowed)
pure def sometimesRetiredHostNotSent(c: NativeCapture): bool = c.phase == CaptureEnded and not(c.delivered)
pure val fair_deliverEnd = "weak"
pure def leadsToEndSettles(c: NativeCapture, later: NativeCapture): bool =
  c.phase == EndPending implies (later.delivered or not(later.hostOpen))
```
