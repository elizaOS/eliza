import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createSecureServer } from "node:http2";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import { microphonePlatform } from "./speech-pipeline/local-microphone-platform.mjs";

// Shared native speech pipeline (ai.eliza.voice): bounded streamed playback, audio focus, VAD
// segmentation, capture admission/ownership, latency trials and the serial speech owner. Host-JVM
// checks of the pure classes plus an Android 36 compile of the whole library. These are not
// AudioTrack, AudioRecord, device audio, model or latency evidence.
const here = path.dirname(fileURLToPath(import.meta.url));
const voice = path.resolve(
  here,
  "../../../../plugins/plugin-local-inference/native/android/src/main/java/ai/eliza/voice",
);
const bridge = path.resolve(
  here,
  "../../../../plugins/plugin-local-inference/native/android/speech-bridge/src/main/java/ai/eliza/voice",
);
const fixtures = path.join(here, "speech-pipeline");
const java = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;

test("speech bootstrap and WebSocket reuse one TLS connection with the production client", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "speech-http-reuse-"));
  const servers = [];
  const sockets = new Set();
  const run = promisify(execFile);
  try {
    const certificate = path.join(folder, "certificate.pem");
    const key = path.join(folder, "key.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        certificate,
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "pipe" },
    );
    const source = fs.readFileSync(
      path.join(bridge, "SpeechStreamBridgePlugin.java"),
      "utf8",
    );
    const prefix = "private final OkHttpClient http=";
    const begin = source.indexOf(prefix);
    assert.ok(begin >= 0);
    const initializer = source.slice(
      begin + prefix.length,
      source.indexOf(";", begin),
    );
    const harness = fs
      .readFileSync(path.join(fixtures, "SpeechHttpReuseTest.java.in"), "utf8")
      .replace("__PRODUCTION_CLIENT__", initializer);
    const javaFile = path.join(folder, "SpeechHttpReuseTest.java");
    fs.writeFileSync(javaFile, harness);
    const okhttp = await dependency("okhttpJvm");
    const classpath = [
      folder,
      okhttp,
      await dependency("okio"),
      await dependency("kotlin"),
    ].join(path.delimiter);
    execFileSync(
      java("javac"),
      ["--release", "21", "-cp", classpath, "-d", folder, javaFile],
      { timeout: 30000 },
    );
    const observations = [];
    for (const mode of ["before", "production", "production-closed"]) {
      const calls = [];
      const server = createSecureServer({
        key: fs.readFileSync(key),
        cert: fs.readFileSync(certificate),
        allowHTTP1: true,
      });
      servers.push(server);
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      server.on("request", (request, response) => {
        calls.push({
          path: request.url,
          version: request.httpVersion,
          port: request.socket.remotePort,
        });
        assert.equal(request.headers.authorization, "Bearer synthetic-owner");
        request.resume();
        response.writeHead(200, {
          "content-type": "application/json",
          ...(mode === "production-closed" ? { connection: "close" } : {}),
        });
        response.end("{}");
      });
      server.on("upgrade", (request, socket) => {
        calls.push({
          path: request.url,
          version: request.httpVersion,
          port: socket.remotePort,
        });
        const accept = createHash("sha1")
          .update(
            `${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
          )
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        socket.write(Buffer.from([0x81, 5, ...Buffer.from("ready")]));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const result = await run(
        java("java"),
        [
          "-cp",
          classpath,
          "SpeechHttpReuseTest",
          `https://127.0.0.1:${address.port}`,
          certificate,
          mode,
        ],
        { timeout: 20000 },
      );
      assert.match(result.stdout, /^PASS /);
      assert.deepEqual(
        calls.map((call) => call.path),
        [
          "/api/v1/voice/speech/consent",
          "/api/v1/voice/speech/session",
          "/api/v1/voice/speech/ws?sessionId=synthetic",
        ],
      );
      assert.deepEqual(
        calls.map((call) => call.version),
        mode === "before" ? ["2.0", "2.0", "1.1"] : ["1.1", "1.1", "1.1"],
      );
      const connections = new Set(calls.map((call) => call.port)).size;
      assert.equal(
        connections,
        mode === "before" ? 2 : mode === "production" ? 1 : 3,
      );
      observations.push({
        mode,
        tlsConnections: connections,
        protocols: calls.map((call) => call.version),
      });
    }
    const output = testOutputPath("speech-http-reuse");
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(
      path.join(output, "connections.json"),
      `${JSON.stringify(observations, null, 2)}\n`,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(resolve))),
    );
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// Resolve only the declared compile artifacts. Cold shards need no ambient Gradle cache.
const dependencyManifest = JSON.parse(
  fs.readFileSync(
    new URL("./speech-compile-dependencies.json", import.meta.url),
    "utf8",
  ),
);
const dependencyDirectory = path.resolve(
  process.env.ELIZA_SPEECH_COMPILE_DEPS_DIR ??
    testOutputPath("speech-pipeline-dependencies"),
);
const artifact = (id) => {
  const entry = dependencyManifest.artifacts.find(
    (candidate) => candidate.id === id,
  );
  assert.ok(entry, `Undeclared speech compile dependency: ${id}`);
  return entry;
};
function verifyDependency(entry, bytes) {
  assert.equal(
    bytes.length,
    entry.bytes,
    `${entry.file}: compile dependency size mismatch`,
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    entry.sha256,
    `${entry.file}: compile dependency SHA-256 mismatch`,
  );
}
async function dependency(id) {
  const entry = artifact(id);
  const destination = path.join(dependencyDirectory, entry.file);
  if (fs.existsSync(destination)) {
    verifyDependency(entry, fs.readFileSync(destination));
    return destination;
  }
  fs.mkdirSync(dependencyDirectory, { recursive: true });
  let bytes;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(
        new URL(entry.path, dependencyManifest.repository),
        { redirect: "error", signal: AbortSignal.timeout(30000) },
      );
      assert.ok(
        response.ok,
        `${entry.file}: dependency download HTTP ${response.status}`,
      );
      bytes = Buffer.from(await response.arrayBuffer());
      verifyDependency(entry, bytes);
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  const temporary = `${destination}.${randomUUID()}.partial`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return destination;
}
// The explicit CI jar uses the same pin; otherwise resolve it into this test's cache.
const jsonJar = process.env.ELIZA_JSON_JAR ?? (await dependency("json"));
verifyDependency(artifact("json"), fs.readFileSync(jsonJar));

// Host-JVM doubles of the Android types OnDeviceRecognizer uses (speech-pipeline/android-api).
const androidApi = path.join(fixtures, "android-api");
const javaFiles = (directory) =>
  fs
    .readdirSync(directory, { recursive: true })
    .filter((name) => name.endsWith(".java"))
    .map((name) => path.join(directory, name));

function run(
  classes,
  fixture,
  expected,
  { json = false, android = false } = {},
) {
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
        ...(android ? javaFiles(androidApi) : []),
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
    ["LiveCaptureResource", "LocalMicrophoneLease"],
    "LiveCaptureResourceTest",
    /^PASS live capture resource/,
  ));
test("capture admission fences permission, blocked start, pause and stale stop", () =>
  run(
    ["LiveCaptureAdmission"],
    "LiveCaptureAdmissionTest",
    /^PASS live capture admission/,
  ));
test("live segment pipe bounds queued audio and fences cutoff, cancellation and re-enrollment", () =>
  run(["LiveSegmentPipe"], "LiveSegmentPipeTest", /^PASS live segment pipe/, {
    json: true,
  }));
test("buffered stream exchange has its own deadline, response bound and enrollment fence", () =>
  run(
    ["BufferedStreamExchange"],
    "BufferedStreamExchangeTest",
    /^PASS buffered stream exchange/,
    { json: true },
  ));
test("speech request gate admits one request, drains cancellation and refuses after destroy", () =>
  run(
    ["SpeechRequestGate"],
    "SpeechRequestGateTest",
    /^PASS speech request gate/,
  ));
test("recognizer availability keeps answers, retries unanswered probes and holds demotes", () =>
  run(
    ["RecognizerAvailability"],
    "RecognizerAvailabilityTest",
    /^PASS recognizer availability/,
  ));
test("the on-device recognizer keeps a late answer and never reads an unanswered probe as no model", () =>
  run(
    [
      "OnDeviceRecognizer",
      "RecognizerAvailability",
      "RecognizerUnavailable",
      "NativeAsr",
      "VoiceNative",
    ],
    "OnDeviceRecognizerProbeTest",
    /^PASS on-device recognizer probe wiring/,
    { android: true },
  ));
test("the on-device recognizer hears fed speech before finish and keeps its timeout and cancel meaning", () =>
  run(
    [
      "OnDeviceRecognizer",
      "RecognizerAvailability",
      "RecognizerUnavailable",
      "NativeAsr",
      "VoiceNative",
    ],
    "OnDeviceRecognizerSessionTest",
    /^PASS on-device recognizer session/,
    { android: true },
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

test("live capture controller orders the agent session, microphone, cancellation and teardown", () => {
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

test("local microphone owners compete before native source acquisition", async (t) => {
  const sdk = path.join(
    process.env.ANDROID_HOME ?? path.join(os.homedir(), "Android/Sdk"),
    "platforms/android-36/android.jar",
  );
  assert.ok(fs.existsSync(sdk), "Android 36 platform required");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "local-microphone-"));
  try {
    const android = `${jsonJar}${path.delimiter}${sdk}`;
    execFileSync(
      java("javac"),
      [
        "--release",
        "21",
        "-cp",
        android,
        "-d",
        temp,
        ...javaFiles(voice),
        path.join(fixtures, "LiveCaptureControllerTest.java"),
      ],
      { timeout: 120_000 },
    );
    // Compile production against Android's signatures first. Replace only the runtime ports.
    const ports = Object.entries(microphonePlatform).map(([name, contents]) => {
      const destination = path.join(temp, "platform", name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, contents);
      return destination;
    });
    const classpath = `${temp}${path.delimiter}${android}`;
    execFileSync(
      java("javac"),
      [
        "--release",
        "21",
        "-cp",
        classpath,
        "-d",
        temp,
        ...ports,
        path.join(fixtures, "ProcessLocalMicrophoneTest.java"),
      ],
      { timeout: 120_000 },
    );
    for (const scenario of [
      "two-live-hosts",
      "draft-then-live",
      "live-then-draft",
      "cancel-while-opening",
      "live-close-unconfirmed",
      "native-open-failed",
      "native-open-release-unconfirmed",
      "clock-setup-failed",
      "draft-release-retry",
      "draft-open-failed",
      "draft-stop-error",
    ]) {
      await t.test(scenario, () => {
        const cache = path.join(temp, scenario);
        fs.mkdirSync(cache);
        const result = execFileSync(
          java("java"),
          [
            "-cp",
            classpath,
            "ai.eliza.voice.ProcessLocalMicrophoneTest",
            scenario,
            cache,
          ],
          { encoding: "utf8", timeout: 20_000 },
        );
        assert.equal(result.trim(), `PASS ${scenario}`);
      });
    }
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

test("a host subclasses the inference transport through its hooks, against Android 36", () => {
  const sdk = path.join(
    process.env.ANDROID_HOME ?? path.join(os.homedir(), "Android/Sdk"),
    "platforms/android-36/android.jar",
  );
  assert.ok(fs.existsSync(sdk), "Android 36 platform required");
  const transport = path.resolve(
    here,
    "../../../../plugins/plugin-local-inference/native/android/capacitor/src/main/java/ai/eliza/voice",
  );
  const javaFiles = (directory) =>
    fs
      .readdirSync(directory, { recursive: true })
      .filter((name) => name.endsWith(".java"))
      .map((name) => path.join(directory, name));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inference-host-"));
  try {
    // A host in its own package overrides admit, configure, describe, hear, the idle and
    // hidden releases and holdsModels, and calls cancelAll and releaseModels; compile-only
    // Capacitor signatures, nothing runs.
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
        ...javaFiles(transport),
        ...javaFiles(path.join(fixtures, "capacitor-api")),
        ...javaFiles(path.join(fixtures, "host-inference")),
      ],
      { stdio: "pipe", timeout: 120000 },
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  const source = fs
    .readFileSync(path.join(transport, "ElizaInferencePlugin.java"), "utf8")
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  // The default transcription never selects a platform recognizer.
  assert.doesNotMatch(source, /OnDeviceRecognizer|SpeechRecognizer/);
  assert.match(
    source,
    /result\.put\("text", transcription\.asr\(\)\.trim\(\)\);/,
  );
  // The host's admission runs on the worker for every request, also one that waited in the queue.
  assert.match(
    source,
    /request\.check\(\);\s*if \(models\.pressure\)[^\n]*\n\s*admit\(call\);\s*lane\.active = request;\s*JSObject result = operation\.run\(request\);/,
  );
  // Transcription has its own worker and client: it never waits behind synthesis in the queue.
  assert.match(
    source,
    /submit\(call, "HEARING_FAILED", models\.hearing, request ->/,
  );
  assert.match(
    source,
    /submit\(call, "SPEECH_FAILED", models\.speech, request ->/,
  );
  assert.match(
    source,
    /final Lane hearing = new Lane\(Executors\.newSingleThreadExecutor\(\)\);/,
  );
});

test("the inference transport releases its models only when the host is hidden and idle", () => {
  // Runnable Capacitor, Android and session doubles (speech-pipeline/inference-transport): the
  // transport's queue and release policy on the host JVM. Not native memory or device evidence.
  const transport = path.resolve(
    here,
    "../../../../plugins/plugin-local-inference/native/android/capacitor/src/main/java/ai/eliza/voice",
  );
  const doubles = path.join(fixtures, "inference-transport");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inference-hidden-"));
  try {
    execFileSync(
      java("javac"),
      [
        "--release",
        "21",
        "-d",
        temp,
        path.join(transport, "ElizaInferencePlugin.java"),
        ...javaFiles(doubles),
      ],
      { stdio: "pipe", timeout: 120000 },
    );
    const output = execFileSync(
      java("java"),
      ["-cp", temp, "ai.eliza.voice.InferenceHiddenReleaseTest"],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.match(output, /^PASS inference hidden release/m);
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

test("the product-subclassable speech bridge compiles with the library against Android 36", async () => {
  const sdk = path.join(
    process.env.ANDROID_HOME ?? path.join(os.homedir(), "Android/Sdk"),
    "platforms/android-36/android.jar",
  );
  assert.ok(fs.existsSync(sdk), "Android 36 platform required");
  // Compile-only Capacitor signatures (speech-pipeline/capacitor-api); no Capacitor code runs.
  const capacitor = path.join(fixtures, "capacitor-api");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "speech-bridge-"));
  try {
    // Refuse pin drift from the actual native consumer, then resolve its compile closure.
    const consumer = fs.readFileSync(
      path.resolve(here, "../../../..", dependencyManifest.consumer),
      "utf8",
    );
    assert.ok(
      consumer.includes(
        `implementation '${dependencyManifest.consumerDependency}'`,
      ),
      "Update speech compile pins with consumer.gradle",
    );
    const okhttp = path.join(temp, "okhttp.jar");
    fs.writeFileSync(
      okhttp,
      execFileSync("unzip", ["-p", await dependency("okhttp"), "classes.jar"]),
    );
    const dependencies = [
      sdk,
      okhttp,
      await dependency("okio"),
      await dependency("kotlin"),
    ].join(path.delimiter);
    execFileSync(
      java("javac"),
      [
        "--release",
        "21",
        "-cp",
        dependencies,
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
  // Compile the actual bridge, then qualify its ownership wiring with the real
  // controller JVM lifecycle above. Platform MediaRecorder remains a device boundary.
  assert.match(source, /live\.interruptAndDrain\(CAPTURE_REPLACED,\(\)->\{/);
  assert.match(
    source,
    /public void beforeCapture\(long admitted,boolean reopen\)\{\s*if\(!reopen&&capture!=null\)capture\.finishBeforeCapture\(\);/,
  );
  assert.doesNotMatch(
    source,
    /JSONObject started=capture\.start\(limit\);\s*live\.interrupt/,
  );
  // Recognition reads only the selected private draft; no URL, path or provider reaches it.
  assert.match(
    source,
    /File file=capture\.selected\(required\(call\.getString\("recordingId"\),256\)\);/,
  );
  assert.doesNotMatch(source, /openConnection|new URL\(/);
});

test("an automatic live capture reopen never prompts: without permission it is refused first", () => {
  const source = fs
    .readFileSync(path.join(bridge, "LocalSpeechBridgePlugin.java"), "utf8")
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const start = source.indexOf(
    "@PluginMethod public void startLiveCapture(PluginCall call){",
  );
  assert.ok(start >= 0, "startLiveCapture");
  const method = source.slice(start, source.indexOf("\n }", start));
  const refusal = method.search(
    /if\(Boolean\.TRUE\.equals\(call\.getBoolean\("reopen",false\)\)&&getPermissionState\("microphone"\)!=PermissionState\.GRANTED\)\{call\.reject\("Microphone permission is not granted","permission"\);return;\}/,
  );
  assert.ok(refusal >= 0, "a reopen without permission is rejected");
  assert.ok(
    refusal < method.indexOf("live.reserve("),
    "before any reservation",
  );
  assert.ok(
    refusal < method.indexOf("requestPermissionForAlias("),
    "before any permission prompt",
  );
  // The controller receives the flag for its call and pause fence.
  assert.match(
    source,
    /live\.start\(ticket,[^;]*,Boolean\.TRUE\.equals\(call\.getBoolean\("reopen",false\)\),new LiveCaptureController\.Started\(\)\{/,
  );
});
