# Native embedded runtime bridge

The source package exposes a Bun-shaped app bridge with platform startup, messaging and local speech diagnostics. The Android [runtime payload](../os/build/runtimePayload.md) governs what Eliza ships with Node. The compatibility surface need not share an executable with the source package.

## Story: Send messages and request local speech through the running embedded runtime

> As a host, I want startup and local speech readiness reported independently, with no reply accepted from a stopped process.

### Messages and RPC calls need a running generation and speech needs a verified local engine

Synthesis, readiness and diagnostics distinguish availability, model loading and failed output. Status reads are available before startup. The shell owns runtime launch, process I/O and byte-level audio decoding.

```quint
type RuntimeHealth = EmbeddedStopped | EmbeddedStarting | EmbeddedRunning | EmbeddedFailed
type LocalSpeechStatus = LocalSpeechUnavailable | LocalSpeechLoading | LocalSpeechReady
type RuntimeSnapshot = { health: RuntimeHealth, launchId: str, speech: LocalSpeechStatus }
type RuntimeOperation = RuntimeStatus | EmbeddedMessage | EmbeddedCall | SpeechStatus | SpeechDiagnostics | SynthesizeSpeech
pure def mayUseRuntime(snapshot: RuntimeSnapshot, op: RuntimeOperation, launchId: str): bool =
  op == RuntimeStatus or op == SpeechStatus or
  (snapshot.health == EmbeddedRunning and launchId != "" and snapshot.launchId == launchId and
   (op != SynthesizeSpeech or snapshot.speech == LocalSpeechReady))
pure def acceptRuntimeReply(snapshot: RuntimeSnapshot, launchId: str): bool =
  snapshot.health == EmbeddedRunning and launchId != "" and snapshot.launchId == launchId
pure def lawSpeechNeedsReadyEngine(snapshot: RuntimeSnapshot, launchId: str): bool =
  mayUseRuntime(snapshot, SynthesizeSpeech, launchId) implies
    snapshot.health == EmbeddedRunning and snapshot.speech == LocalSpeechReady
pure def lawPriorRuntimeCannotReply(snapshot: RuntimeSnapshot, launchId: str): bool =
  launchId != snapshot.launchId implies not(acceptRuntimeReply(snapshot, launchId))
pure val snapshotValues = Set(
  { health: EmbeddedRunning, launchId: "42", speech: LocalSpeechReady },
  { health: EmbeddedRunning, launchId: "43", speech: LocalSpeechLoading },
  { health: EmbeddedStopped, launchId: "42", speech: LocalSpeechUnavailable })
pure val launchIdValues = Set("", "42", "43")
```
