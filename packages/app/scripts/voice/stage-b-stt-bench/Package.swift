// swift-tools-version: 5.9
import PackageDescription

// Stage-B on-device STT benchmark harness for elizaOS issue #9958.
//
// Measures Apple `SFSpeechRecognizer` (the iOS/macOS ANE-backed "Stage-B
// confirm" recognizer claimed in `packages/ui/src/voice/VOICE_UX.md` §7)
// against labelled speech: per-utterance recognition latency, real-time
// factor, and the recognised hypothesis (WER is scored by the Node driver so
// it matches the repo's existing `asr_bench.ts` word-edit metric).
//
// STT-side only. Kokoro TTS is unchanged.
let package = Package(
    name: "StageBSttBench",
    platforms: [
        .macOS(.v13),
    ],
    targets: [
        .executableTarget(
            name: "stage-b-stt-bench",
            path: "Sources/StageBSttBench"
        ),
    ]
)
