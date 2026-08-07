// Stage-B on-device STT benchmark — Apple SFSpeechRecognizer arm (issue #9958).
//
// Loads labelled WAV utterances, runs each through `SFSpeechRecognizer` with
// `requiresOnDeviceRecognition = true` (the ANE-backed "Stage-B confirm" path
// claimed in VOICE_UX.md §7), and reports per-utterance recognition latency,
// real-time factor, and the recognised hypothesis. The Node driver
// (`packages/scripts/stage-b-stt-bench.mjs`) scores WER from the hypotheses so
// the metric matches the repo's existing `asr_bench.ts` word-edit distance.
//
// Output is a single JSON document on stdout (and optionally `--out <file>`).
// If Speech authorization or the on-device model is unavailable the harness
// exits non-zero with an explicit machine-readable `unavailable` document so a
// caller records a real `skip`, never a false `pass`.

import AVFoundation
import Foundation
import Speech

struct UtteranceInput {
    let id: String
    let reference: String
    let wavPath: String
}

struct UtteranceResult {
    let id: String
    let reference: String
    let hypothesis: String
    let audioDurationSec: Double
    let latencyMs: Double
    let realTimeFactor: Double
    let recognized: Bool
    let error: String?
}

func fail(_ reason: String, code: Int32, extra: [String: Any] = [:]) -> Never {
    var doc: [String: Any] = [
        "schema": "eliza_stage_b_stt_apple_v1",
        "status": "unavailable",
        "reason": reason,
    ]
    for (k, v) in extra { doc[k] = v }
    if let data = try? JSONSerialization.data(withJSONObject: doc, options: [.prettyPrinted]),
        let json = String(data: data, encoding: .utf8)
    {
        print(json)
    }
    exit(code)
}

// ---- argument parsing -------------------------------------------------------

var manifestPath: String?
var outPath: String?
var localeId = "en-US"
var onDevice = true

var argi = 1
let argv = CommandLine.arguments
while argi < argv.count {
    let token = argv[argi]
    switch token {
    case "--manifest": argi += 1; manifestPath = argi < argv.count ? argv[argi] : nil
    case "--out": argi += 1; outPath = argi < argv.count ? argv[argi] : nil
    case "--locale": argi += 1; localeId = argi < argv.count ? argv[argi] : localeId
    case "--no-on-device": onDevice = false
    case "--on-device": onDevice = true
    default: break
    }
    argi += 1
}

guard let manifestPath else {
    fail("missing --manifest <path-to-utterances.json>", code: 2)
}

// ---- manifest ---------------------------------------------------------------

guard let manifestData = FileManager.default.contents(atPath: manifestPath) else {
    fail("manifest not readable at \(manifestPath)", code: 2)
}
guard
    let manifestJson = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
    let rawUtterances = manifestJson["utterances"] as? [[String: Any]]
else {
    fail("manifest missing utterances[]", code: 2)
}

let manifestDir = (manifestPath as NSString).deletingLastPathComponent
let utterances: [UtteranceInput] = rawUtterances.compactMap { row in
    guard
        let id = row["id"] as? String,
        let reference = row["reference"] as? String,
        let wav = row["wav"] as? String
    else { return nil }
    let resolved =
        (wav as NSString).isAbsolutePath
        ? wav : (manifestDir as NSString).appendingPathComponent(wav)
    return UtteranceInput(id: id, reference: reference, wavPath: resolved)
}

if utterances.isEmpty {
    fail("no valid utterances in manifest", code: 2)
}

// ---- authorization ----------------------------------------------------------

let authSem = DispatchSemaphore(value: 0)
var authStatus: SFSpeechRecognizerAuthorizationStatus = .notDetermined
SFSpeechRecognizer.requestAuthorization { status in
    authStatus = status
    authSem.signal()
}
_ = authSem.wait(timeout: .now() + 20)

if authStatus != .authorized {
    fail(
        "Speech recognition not authorized (status=\(authStatus.rawValue); 0=notDetermined 1=denied 2=restricted 3=authorized). Grant Speech Recognition in System Settings > Privacy, or run on a device/host with TCC consent.",
        code: 3,
        extra: ["authStatus": authStatus.rawValue]
    )
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
    fail("no SFSpeechRecognizer for locale \(localeId)", code: 4)
}
if !recognizer.isAvailable {
    fail("SFSpeechRecognizer for \(localeId) is not available", code: 4)
}
if onDevice && !recognizer.supportsOnDeviceRecognition {
    fail(
        "on-device recognition unsupported for \(localeId); the on-device model is not installed",
        code: 4,
        extra: ["supportsOnDeviceRecognition": false]
    )
}

// ---- recognition ------------------------------------------------------------

func audioDurationSec(_ path: String) -> Double {
    guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)) else { return 0 }
    let frames = Double(file.length)
    let rate = file.fileFormat.sampleRate
    return rate > 0 ? frames / rate : 0
}

func recognizeOne(_ utt: UtteranceInput) -> UtteranceResult {
    let url = URL(fileURLWithPath: utt.wavPath)
    let duration = audioDurationSec(utt.wavPath)
    if !FileManager.default.fileExists(atPath: utt.wavPath) {
        return UtteranceResult(
            id: utt.id, reference: utt.reference, hypothesis: "", audioDurationSec: duration,
            latencyMs: 0, realTimeFactor: 0, recognized: false, error: "wav missing")
    }

    let request = SFSpeechURLRecognitionRequest(url: url)
    request.shouldReportPartialResults = false
    request.requiresOnDeviceRecognition = onDevice
    if #available(macOS 13, *) { request.addsPunctuation = false }

    var hypothesis = ""
    var taskError: String?
    var done = false
    let started = CFAbsoluteTimeGetCurrent()
    var finishedAt = started

    // `SFSpeechURLRecognitionRequest` delivers its result on the main run loop,
    // so pump the run loop while waiting rather than blocking the thread.
    let task = recognizer.recognitionTask(with: request) { result, error in
        if let error {
            taskError = error.localizedDescription
            finishedAt = CFAbsoluteTimeGetCurrent()
            done = true
            return
        }
        guard let result else { return }
        if result.isFinal {
            hypothesis = result.bestTranscription.formattedString
            finishedAt = CFAbsoluteTimeGetCurrent()
            done = true
        }
    }

    let deadline = Date().addingTimeInterval(60)
    while !done && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    if !done {
        task.cancel()
        finishedAt = CFAbsoluteTimeGetCurrent()
        taskError = "recognition timed out after 60s"
    }

    let latencyMs = (finishedAt - started) * 1000.0
    let rtf = duration > 0 ? (latencyMs / 1000.0) / duration : 0
    return UtteranceResult(
        id: utt.id, reference: utt.reference, hypothesis: hypothesis,
        audioDurationSec: duration, latencyMs: latencyMs, realTimeFactor: rtf,
        recognized: taskError == nil && !hypothesis.isEmpty, error: taskError)
}

var results: [UtteranceResult] = []
for utt in utterances {
    results.append(recognizeOne(utt))
}

// ---- emit -------------------------------------------------------------------

let host = ProcessInfo.processInfo.hostName
var model = "unknown"
if #available(macOS 14, *) {} // version gate only; model id is not public API

let resultDocs: [[String: Any]] = results.map { r in
    [
        "id": r.id,
        "reference": r.reference,
        "hypothesis": r.hypothesis,
        "audioDurationSec": r.audioDurationSec,
        "latencyMs": r.latencyMs,
        "realTimeFactor": r.realTimeFactor,
        "recognized": r.recognized,
        "error": r.error as Any,
    ]
}

let doc: [String: Any] = [
    "schema": "eliza_stage_b_stt_apple_v1",
    "status": "ok",
    "backend": "apple-sfspeechrecognizer",
    "locale": localeId,
    "requiresOnDeviceRecognition": onDevice,
    "supportsOnDeviceRecognition": recognizer.supportsOnDeviceRecognition,
    "host": host,
    "model": model,
    "utteranceCount": results.count,
    "utterances": resultDocs,
]

let data = try JSONSerialization.data(withJSONObject: doc, options: [.prettyPrinted, .sortedKeys])
let json = String(data: data, encoding: .utf8) ?? "{}"
print(json)
if let outPath {
    try? json.write(toFile: outPath, atomically: true, encoding: .utf8)
}
