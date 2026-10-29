import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Shared native speech pipeline (ai.eliza.voice): bounded streamed playback, audio focus, VAD
// segmentation, capture admission/ownership, latency trials and the serial speech owner. Host-JVM
// checks of the pure classes plus an Android 36 compile of the whole library. These are not
// AudioTrack, AudioRecord, device audio, model or latency evidence.
const here = path.dirname(fileURLToPath(import.meta.url));
const voice = path.resolve(
  here,
  "../../../../plugins/plugin-local-inference/native/android/src/main/java/ai/eliza/voice",
);
const fixtures = path.join(here, "speech-pipeline");
const java = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;

// org.json for the JSON-carrying classes: ELIZA_JSON_JAR, else the Gradle cache's pinned jar.
// A missing jar skips locally and fails on CI.
const jsonCache = path.join(
  os.homedir(),
  ".gradle/caches/modules-2/files-2.1/org.json/json/20250517",
);
const jsonJar =
  process.env.ELIZA_JSON_JAR ||
  (fs.existsSync(jsonCache)
    ? fs
        .readdirSync(jsonCache)
        .map((hash) => path.join(jsonCache, hash, "json-20250517.jar"))
        .find((jar) => fs.existsSync(jar))
    : undefined);
const skipUnlessJsonJarInstalled =
  jsonJar || process.env.CI
    ? false
    : "Set ELIZA_JSON_JAR or install the pinned Gradle org.json dependency";

function run(classes, fixture, expected, { json = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "speech-pipeline-"));
  const classpath = json ? ["-cp", jsonJar] : [];
  try {
    execFileSync(
      java("javac"),
      [
        "--release",
        "11",
        ...classpath,
        "-d",
        temp,
        ...classes.map((name) => path.join(voice, `${name}.java`)),
        path.join(fixtures, `${fixture}.java`),
      ],
      { stdio: "pipe", timeout: 120000 },
    );
    const output = execFileSync(
      java("java"),
      [
        "-cp",
        json ? `${temp}${path.delimiter}${jsonJar}` : temp,
        `ai.eliza.voice.${fixture}`,
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.match(output, expected);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test("bounded PCM queue, streamed writer, cancellation, focus policy and chunk validation", () =>
  run(
    [
      "VoiceLatencyTrials",
      "SpeechPcmQueue",
      "StreamingSpeechPlayback",
      "SpeechAudioFocusPolicy",
      "SpeechStreamValidation",
    ],
    "StreamingSpeechTest",
    /^PASS streaming speech/,
  ));
test("serial speech owner reuses, cancels, releases and round-trips PCM", () =>
  run(["LocalSpeechEngine"], "LocalSpeechEngineTest", /^PASS local speech/));
test("VAD gate opens, holds and closes speech segments", () =>
  run(["LiveVadGate"], "LiveVadGateTest", /^PASS live vad gate/));
test("capture source keeps recognition audio unless echo cancellation is available", () =>
  run(
    ["LiveCaptureSource"],
    "LiveCaptureSourceTest",
    /^PASS live capture source/,
  ));
test("capture resource serializes stop with release", () =>
  run(
    ["LiveCaptureResource"],
    "LiveCaptureResourceTest",
    /^PASS live capture resource/,
  ));
test("capture admission fences permission, blocked start, pause and stale stop", () =>
  run(
    ["LiveCaptureAdmission"],
    "LiveCaptureAdmissionTest",
    /^PASS live capture admission/,
  ));
test(
  "live segment pipe bounds queued audio and fences cutoff, cancellation and re-enrollment",
  { skip: skipUnlessJsonJarInstalled },
  () =>
    run(["LiveSegmentPipe"], "LiveSegmentPipeTest", /^PASS live segment pipe/, {
      json: true,
    }),
);
test(
  "buffered stream exchange has its own deadline, response bound and enrollment fence",
  { skip: skipUnlessJsonJarInstalled },
  () =>
    run(
      ["BufferedStreamExchange"],
      "BufferedStreamExchangeTest",
      /^PASS buffered stream exchange/,
      { json: true },
    ),
);
test("speech request gate admits one request, drains cancellation and refuses after destroy", () =>
  run(
    ["SpeechRequestGate"],
    "SpeechRequestGateTest",
    /^PASS speech request gate/,
  ));
test("latency trials link one turn from last user audio to audible playback", () =>
  run(
    ["LiveVadGate", "VoiceLatencyTrials"],
    "VoiceLatencyTrialsTest",
    /^PASS voice latency trials/,
  ));

test("validated speech over the shared session: bounds, silence, streamed chunks and client-scoped release", () => {
  const sdk = path.join(
    process.env.ANDROID_HOME ?? path.join(os.homedir(), "Android/Sdk"),
    "platforms/android-36/android.jar",
  );
  assert.ok(fs.existsSync(sdk), "Android 36 platform required");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "session-speech-"));
  try {
    execFileSync(
      java("javac"),
      [
        "--release",
        "21",
        "-cp",
        sdk,
        "-d",
        temp,
        ...[
          "ParadeeVoice",
          "NativeAsr",
          "InferenceSession",
          "VoiceAssets",
          "VoiceBundleAssets",
          "LocalSpeechEngine",
          "SpeechStreamValidation",
          "SessionSpeech",
        ].map((name) => path.join(voice, `${name}.java`)),
        path.join(here, "stream-contract/VoiceNative.java"),
        path.join(fixtures, "SessionSpeechContract.java"),
      ],
      { stdio: "pipe", timeout: 120000 },
    );
    // android.jar only satisfies the Context signature; no Android method runs.
    const output = execFileSync(
      java("java"),
      [
        "-cp",
        `${temp}${path.delimiter}${sdk}`,
        "ai.eliza.voice.SessionSpeechContract",
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.match(output, /^PASS session speech validation/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("live capture controller orders the agent session, microphone, cancellation and teardown", {
  skip: skipUnlessJsonJarInstalled,
}, () => {
  const sdk = path.join(
    process.env.ANDROID_HOME ?? path.join(os.homedir(), "Android/Sdk"),
    "platforms/android-36/android.jar",
  );
  assert.ok(fs.existsSync(sdk), "Android 36 platform required");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "live-capture-"));
  // org.json precedes android.jar so the real implementation replaces its stubs.
  const classpath = `${jsonJar}${path.delimiter}${sdk}`;
  try {
    const sources = fs
      .readdirSync(voice)
      .filter((name) => name.endsWith(".java"))
      .map((name) => path.join(voice, name));
    execFileSync(
      java("javac"),
      [
        "--release",
        "21",
        "-cp",
        classpath,
        "-d",
        temp,
        ...sources,
        path.join(fixtures, "LiveCaptureControllerTest.java"),
      ],
      { stdio: "pipe", timeout: 120000 },
    );
    // android.jar only satisfies signatures; the fake source never reaches an Android method.
    const output = execFileSync(
      java("java"),
      [
        "-cp",
        `${temp}${path.delimiter}${classpath}`,
        "ai.eliza.voice.LiveCaptureControllerTest",
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.match(output, /^PASS live capture controller/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("the shared speech library compiles against Android 36", () => {
  const sdk = path.join(
    process.env.ANDROID_HOME ?? path.join(os.homedir(), "Android/Sdk"),
    "platforms/android-36/android.jar",
  );
  assert.ok(fs.existsSync(sdk), "Android 36 platform required");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "speech-android-"));
  try {
    const sources = fs
      .readdirSync(voice)
      .filter((name) => name.endsWith(".java"))
      .map((name) => path.join(voice, name));
    execFileSync(
      java("javac"),
      ["--release", "21", "-cp", sdk, "-d", temp, ...sources],
      { stdio: "pipe", timeout: 120000 },
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("live capture uses the shared session's VAD and never a platform recognizer", () => {
  const strip = (name) =>
    fs
      .readFileSync(path.join(voice, name), "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const capture = strip("LiveVoiceCapture.java");
  assert.match(capture, /InferenceSession\.Vad vad=inference\.openVad\(\);/);
  assert.doesNotMatch(
    capture,
    /SpeechRecognizer|ElizaVoiceNative|nativeContextCreate/,
  );
  assert.match(
    capture,
    /if\(edge==LiveVadGate\.Edge\.SPEECH_END&&!DICTATION\.equals\(pipeline\)\)\{VoiceLatencyProbe\.TRIALS\.speechEnded\(/,
  );
  const output = strip("AudioTrackSpeechOutput.java");
  assert.match(output, /setTransferMode\(AudioTrack\.MODE_STREAM\)/);
  assert.match(output, /ENCODING_PCM_FLOAT/);
  assert.match(output, /setAudioAttributes\(SpeechAudioFocus\.ATTRIBUTES\)/);
  const focus = strip("SpeechAudioFocus.java");
  assert.match(
    focus,
    /setUsage\(AudioAttributes\.USAGE_ASSISTANT\)\.setContentType\(AudioAttributes\.CONTENT_TYPE_SPEECH\)/,
  );
  assert.match(
    focus,
    /new AudioFocusRequest\.Builder\(AudioManager\.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK\)/,
  );
  const speech = strip("SessionSpeech.java");
  assert.match(
    speech,
    /public void close\(\)\{if\(owned\)inference\.close\(\);else client\.release\(\);\}/,
  );
  assert.doesNotMatch(speech, /\.open(?:Asr|Voice)\(/);
  // Every call and cancellation goes through the backend's own client of the session.
  assert.match(speech, /public void cancel\(\)\{client\.cancel\(\);\}/);
  assert.doesNotMatch(
    speech,
    /inference\.(?:cancel|trimMemory|synthesize|transcribe|prepareSpeech|speechSampleRate)\(/,
  );
});

test("the product-subclassable speech bridge compiles with the library against Android 36", () => {
  const sdk = path.join(
    process.env.ANDROID_HOME ?? path.join(os.homedir(), "Android/Sdk"),
    "platforms/android-36/android.jar",
  );
  assert.ok(fs.existsSync(sdk), "Android 36 platform required");
  const bridge = path.resolve(
    here,
    "../../../../plugins/plugin-local-inference/native/android/speech-bridge/src/main/java/ai/eliza/voice",
  );
  // Compile-only Capacitor signatures (speech-pipeline/capacitor-api); no Capacitor code runs.
  const capacitor = path.join(fixtures, "capacitor-api");
  const javaFiles = (directory) =>
    fs
      .readdirSync(directory, { recursive: true })
      .filter((name) => name.endsWith(".java"))
      .map((name) => path.join(directory, name));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "speech-bridge-"));
  try {
    execFileSync(
      java("javac"),
      [
        "--release",
        "21",
        "-cp",
        sdk,
        "-d",
        temp,
        ...javaFiles(voice),
        ...javaFiles(bridge),
        ...javaFiles(capacitor),
      ],
      { stdio: "pipe", timeout: 120000 },
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  const strip = (file) =>
    fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const source = strip(path.join(bridge, "LocalSpeechBridgePlugin.java"));
  // Abstract and unannotated: each product registers its own @CapacitorPlugin subclass.
  assert.match(
    source,
    /public abstract class LocalSpeechBridgePlugin extends Plugin/,
  );
  assert.doesNotMatch(source, /@CapacitorPlugin/);
  for (const method of [
    "startRecording",
    "stopRecording",
    "cancelRecording",
    "getRecordingMetrics",
    "transcribeLocalRecording",
    "synthesizeLocal",
    "play",
    "stopPlayback",
    "cancel",
    "liveCaptureStatus",
    "startLiveCapture",
    "stopLiveCapture",
    "localSpeechStatus",
    "releaseLocalSpeech",
    "nativeVoiceTiming",
    "markVoiceTurn",
    "clearNativeVoiceTiming",
  ])
    assert.match(
      source,
      new RegExp(`@PluginMethod public void ${method}\\(PluginCall call\\)`),
      method,
    );
  // Owner-bound resident transport is a product port; without it nothing is routed natively.
  assert.match(
    source,
    /protected LiveCaptureController\.Route residentRoute\(String ownerId\)\{return null;\}/,
  );
  assert.match(
    source,
    /LiveCaptureController\.Route route=Boolean\.TRUE\.equals\(call\.getBoolean\("nativeAsr",false\)\)\?residentRoute\(owner\):null;/,
  );
  // Recognition reads only the selected private draft; no URL, path or provider reaches it.
  assert.match(
    source,
    /File file=capture\.selected\(required\(call\.getString\("recordingId"\),256\)\);/,
  );
  assert.doesNotMatch(source, /openConnection|new URL\(/);
});
