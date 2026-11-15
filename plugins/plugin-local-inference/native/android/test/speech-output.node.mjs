import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const java = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
test("synthesized lead-in silence is trimmed with a short pre-roll and later audio passes through", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-speech-trim-"));
  try {
    execFileSync(
      java("javac"),
      [
        "--release",
        "17",
        "-d",
        output,
        path.join(here, "../src/main/java/ai/eliza/voice/SpeechLeadTrim.java"),
        path.join(here, "speech/SpeechLeadTrimTest.java"),
      ],
      { timeout: 60000, stdio: "pipe" },
    );
    assert.match(
      execFileSync(
        java("java"),
        ["-cp", output, "ai.eliza.voice.SpeechLeadTrimTest"],
        { timeout: 60000, encoding: "utf8" },
      ),
      /^PASS speech lead trim/,
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test("the speech output warm-up is bounded, and close stops it at once, also a blocked write or a late open", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-speech-warmup-"));
  try {
    const voice = (name) =>
      path.join(here, "../src/main/java/ai/eliza/voice", name);
    const sources = [
      "SpeechOutputWarmup.java",
      "StreamingSpeechPlayback.java",
      "SpeechPcmQueue.java",
      "VoiceLatencyTrials.java",
      "SpeechAudioFocusPolicy.java",
    ].map(voice);
    execFileSync(
      java("javac"),
      [
        "--release",
        "17",
        "-d",
        output,
        ...sources,
        path.join(here, "speech/AudioTrackSpeechOutputStub.java"),
        path.join(here, "speech/SpeechOutputWarmupTest.java"),
      ],
      { timeout: 60000, stdio: "pipe" },
    );
    assert.match(
      execFileSync(
        java("java"),
        ["-cp", output, "ai.eliza.voice.SpeechOutputWarmupTest"],
        { timeout: 60000, encoding: "utf8" },
      ),
      /^PASS output warmup/,
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

// Compiles the named library classes with one JVM fixture and runs it. No Android class is involved.
function contract(classes, fixture, expected) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-speech-"));
  try {
    execFileSync(
      java("javac"),
      [
        "--release",
        "17",
        "-d",
        output,
        ...classes.map((name) =>
          path.join(here, "../src/main/java/ai/eliza/voice", `${name}.java`),
        ),
        path.join(here, `speech/${fixture}.java`),
      ],
      { timeout: 60000, stdio: "pipe" },
    );
    assert.match(
      execFileSync(java("java"), ["-cp", output, `ai.eliza.voice.${fixture}`], {
        timeout: 60000,
        encoding: "utf8",
      }),
      expected,
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
}

test("a shorter VAD end hangover closes the segment sooner, clamped to whole windows, and the barge-in run is counted", () =>
  contract(
    ["LiveVadGate", "LiveCaptureOptions"],
    "LiveVadHangoverTest",
    /^PASS live vad hangover/,
  ));

test("appended sentences play in order through one output, end once, and stop drops them all", () =>
  contract(
    [
      "StreamingSpeechPlayback",
      "SpeechPcmQueue",
      "VoiceLatencyTrials",
      "SpeechAudioFocusPolicy",
      "SpeechRequestGate",
    ],
    "SpeechAppendTest",
    /^PASS speech append/,
  ));

test("speech synthesis uses the big cores, two to eight threads", () =>
  contract(["SpeechCores"], "SpeechCoresTest", /^PASS speech cores/));

test("a conversation's hold keeps the engine only in the foreground and is one flag", () =>
  contract(
    ["SpeechEngineHold"],
    "SpeechEngineHoldTest",
    /^PASS speech engine hold/,
  ));

test("the bridge honours the engine hold on the idle timer only, and pause and trim end it", () => {
  const bridge = fs.readFileSync(
    path.join(
      here,
      "../speech-bridge/src/main/java/ai/eliza/voice/LocalSpeechBridgePlugin.java",
    ),
    "utf8",
  );
  assert.match(
    bridge,
    /localIdleRelease=\(\)->\{if\(!engineHold\.keeps\(speechForeground\)\)queueLocalRelease\(\);\};/,
  );
  assert.match(
    bridge,
    /handleOnPause\(\)\{speechForeground=false;engineHold\.release\(\);/,
  );
  assert.match(
    bridge,
    /if\(level==TRIM_MEMORY_UI_HIDDEN\)\{engineHold\.release\(\);scheduleLocalRelease\(30000\);\}/,
  );
  // Memory pressure and an explicit release unload at once, hold or not.
  assert.match(
    bridge,
    /private void releaseForMemoryPressure\(\)\{gate\.cancelAll\(\);queueLocalRelease\(\);\}/,
  );
  // The thread count is set on the speech worker before the first voice can load.
  assert.match(
    bridge,
    /new LocalSpeechEngine\(\(\)->\{useBigCores\(\);return SessionSpeech\.shared\(getContext\(\)\);\}\)/,
  );
});

test("the bridge starts the warm-up only for a foreground idle speaker outside protected surfaces and closes it on every stop path", () => {
  const bridge = fs.readFileSync(
    path.join(
      here,
      "../speech-bridge/src/main/java/ai/eliza/voice/LocalSpeechBridgePlugin.java",
    ),
    "utf8",
  );
  const body = (signature) => {
    const start = bridge.indexOf(signature);
    assert.ok(start >= 0, signature);
    return bridge.slice(start, bridge.indexOf("\n", start));
  };
  assert.match(
    bridge,
    /if\(!destroyed&&speechForeground&&!sensitiveSurfaceActive\(\)&&\(focus==null\|\|!focus\.callActive\(\)\)&&!speakerBusy\(\)\)\{closeOutputWarmup\(\);outputWarmup=new SpeechOutputWarmup\(LocalSpeechEngine\.STREAM_RATE\);\}/,
  );
  // Stop, pause, a published clip and release all go through clearPlayback; a call and focus loss through stopSpeechFor.
  assert.match(
    body("private void clearPlayback(boolean stopped){"),
    /^private void clearPlayback\(boolean stopped\)\{closeOutputWarmup\(\);/,
  );
  assert.match(
    body("private void stopSpeechFor(String reason){"),
    /^private void stopSpeechFor\(String reason\)\{closeOutputWarmup\(\);/,
  );
  assert.match(body("private void callStarted(){"), /stopSpeechFor\(/);
  assert.match(
    body("@PluginMethod public void cancel(PluginCall call){"),
    /^@PluginMethod public void cancel\(PluginCall call\)\{main\.post\(this::closeOutputWarmup\);/,
  );
  assert.match(
    body("@PluginMethod public void stopPlayback(PluginCall call){"),
    /clearPlayback\(\)/,
  );
  assert.match(
    bridge,
    /try\{closeOutputWarmup\(\);capture\.cancel\(\);\}/,
    "recording cancellation closes it",
  );
  assert.match(
    body("@Override protected void handleOnPause(){"),
    /main\.post\(this::clearPlayback\)/,
  );
  assert.match(
    bridge,
    /main\.post\(\(\)->\{closeOutputWarmup\(\);if\(focus!=null\)focus\.close\(\);\}\)/,
    "destroy closes it",
  );
  // Both the streamed and the prepared (MediaPlayer) clip paths clear playback before they play.
  assert.equal(
    (bridge.match(/clearPlayback\(\);playbackFile=file;/g) || []).length,
    2,
    "both prepared-clip publications (local and reviewed) retire the warm-up",
  );
  assert.match(
    bridge,
    /clearPlayback\(\);streamPlayback=playback/,
    "the first streamed samples retire the warm-up before publication",
  );
});
