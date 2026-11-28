# Native wake detection

Swabble owns the app-local wake detection and speech callback surface. [Android wake listening](../os/voice/listener.md) owns device service permissions, microphone ownership and consent. Session lifecycle transitions for start, pause, resume, device switch and stop live in [wake session lifecycle](./session.md).

## Story: Listen for a wake phrase only during the current authorized session

> As the owner, I want an explicit start, pause and stop to control wake recognition, with old callbacks discarded after changing audio devices or closing the listener.

### Wake observations and transcripts are bound to a current microphone lease

The runtime may configure a phrase, language and audio input. A start requires the operating-system permission and the owner's choice. Stopping or switching input retires the recognizer that held the prior lease.

```quint
type WakeObservation = WakePhrase | InterimWakeTranscript | FinalWakeTranscript | WakeMicState
type WakeLease = { leaseId: str, enabled: bool, microphoneGranted: bool, ownerEnabled: bool }
pure def mayReportWakeObservation(lease: WakeLease, callbackId: str, observation: WakeObservation): bool =
  lease.leaseId != "" and callbackId == lease.leaseId and lease.enabled and lease.ownerEnabled and
  (observation == WakeMicState or lease.microphoneGranted)
pure def lawRetiredWakeCannotPublish(lease: WakeLease, callbackId: str, observation: WakeObservation): bool =
  callbackId != lease.leaseId implies not(mayReportWakeObservation(lease, callbackId, observation))
pure def lawWakeTranscriptNeedsMicrophone(lease: WakeLease, callbackId: str): bool =
  mayReportWakeObservation(lease, callbackId, FinalWakeTranscript) implies lease.microphoneGranted
pure val leaseValues = Set(
  { leaseId: "listener1", enabled: true, microphoneGranted: true, ownerEnabled: true },
  { leaseId: "listener1", enabled: true, microphoneGranted: false, ownerEnabled: true },
  { leaseId: "listener2", enabled: false, microphoneGranted: true, ownerEnabled: true })
pure val callbackIdValues = Set("", "listener1", "listener2")
```
