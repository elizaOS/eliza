import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../../..");
const source = path.join(
  root,
  "packages/app/platforms/android/sense/src/main/java/ai/eliza/sense",
);
const fixtures = path.join(import.meta.dirname, "sense-fixtures");
const chip = path.join(root, "packages/os/android/sense/systemui/chip/source");
const java = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
const sources = (dir) =>
  fs
    .readdirSync(dir, { recursive: true })
    .filter((name) => name.endsWith(".java"))
    .map((name) => path.join(dir, name));
const config =
  'package ai.eliza.sense; public final class BuildConfig { public static final String APPLICATION_ID="ai.eliza.sense", SENSE_HOST_PACKAGE="ai.eliza", SENSE_ASSIST_ACTIVITY="ai.eliza.AssistActivity", SENSE_APP_NAME="Eliza", SENSE_WAKE_LABEL="alpha", SENSE_WAKE_NAMES="alpha", SENSE_COMPONENT_PACKAGE="ai.eliza.sense", SENSE_STORAGE_NAME="listener-settings"; }';
function compile(files, run, { android = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shared-sense-"));
  try {
    const buildConfig = path.join(temp, "BuildConfig.java");
    fs.writeFileSync(buildConfig, config);
    execFileSync(
      java("javac"),
      ["--release", android ? "21" : "11", "-d", temp, ...files, buildConfig],
      { timeout: 60000 },
    );
    if (run)
      assert.match(
        execFileSync(java("java"), ["-cp", temp, run], {
          encoding: "utf8",
          timeout: 15000,
        }),
        /PASS/,
      );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
for (const [name, classes, runner] of [
  [
    "policy, crash loop, speech gate and configured wake phrase",
    ["ListenerPolicy", "CrashLoopBreaker", "SpeechGate", "WakePhrase"],
    "ListenerPolicyTest",
  ],
  [
    "lease renewal, expiry, binder death, lock and AOD transitions",
    ["ListenerPolicy", "IndicatorLease", "CrashLoopBreaker"],
    "ListenerLeaseTest",
  ],
  [
    "stop, resume and stale queued invocation",
    ["ListeningEpoch"],
    "ListeningEpochTest",
  ],
])
  test(name, () =>
    compile(
      [
        ...classes.map((name) => path.join(source, `${name}.java`)),
        path.join(fixtures, `${runner}.java`),
      ],
      `ai.eliza.sense.${runner}`,
    ),
  );
test("persistence failure and restart cannot revive stale consent", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sense-store-"));
  try {
    for (const [name, text] of Object.entries(
      JSON.parse(
        fs.readFileSync(
          path.join(fixtures, "listener-store-stubs.json"),
          "utf8",
        ),
      ),
    )) {
      const file = path.join(temp, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    compile(
      [
        ...sources(temp),
        ...[
          "ListenerStore",
          "ListenerPolicy",
          "CrashLoopBreaker",
          "ListeningEpoch",
        ].map((name) => path.join(source, `${name}.java`)),
      ],
      "ai.eliza.sense.ListenerStoreFailureTest",
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
test("SystemUI signer, owner, pause-only capability and independent visibility policy", () =>
  compile(
    [
      path.join(chip, "SenseListeningPolicy.java"),
      path.join(source, "ListenerActionContract.java"),
      path.join(fixtures, "ListenerSystemUiPolicyTest.java"),
    ],
    "ai.eliza.sense.ListenerSystemUiPolicyTest",
  ));
test("shared SystemUI source compiles and lease/acknowledgement fixtures execute", () => {
  const files = [
    ...sources(path.join(fixtures, "systemui-chip-jvm")),
    ...sources(chip),
    path.join(source, "IndicatorLease.java"),
    path.join(source, "ListenerPolicy.java"),
    path.join(fixtures, "SystemUiLeaseClientTest.java"),
    path.join(fixtures, "SystemUiAcknowledgementTest.java"),
  ];
  for (const runner of [
    "SystemUiLeaseClientTest",
    "SystemUiAcknowledgementTest",
  ])
    compile(files, `com.android.systemui.privacy.${runner}`);
});
test("all shared listener classes compile against Android 36", () => {
  const sdk = path.join(
    process.env.ANDROID_HOME ?? path.join(os.homedir(), "Android/Sdk"),
    "platforms/android-36/android.jar",
  );
  assert.ok(fs.existsSync(sdk), "Android 36 platform required");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sense-android-"));
  try {
    fs.writeFileSync(path.join(temp, "BuildConfig.java"), config);
    fs.writeFileSync(
      path.join(temp, "R.java"),
      "package ai.eliza.sense; public final class R { public static final class drawable { public static final int ic_listening=1; }}",
    );
    fs.writeFileSync(
      path.join(temp, "NativeAsr.java"),
      "package ai.eliza.voice; public interface NativeAsr extends AutoCloseable { String transcribe(float[] samples); void cancel(); void close(); }",
    );
    fs.writeFileSync(
      path.join(temp, "VoiceAssets.java"),
      "package ai.eliza.voice; public final class VoiceAssets { public static VoiceAssets install(android.content.Context context){return null;} public NativeAsr openAsr(){return null;} }",
    );
    execFileSync(
      java("javac"),
      [
        "--release",
        "21",
        "-cp",
        sdk,
        "-d",
        path.join(temp, "out"),
        ...sources(temp),
        ...sources(source),
      ],
      { timeout: 60000 },
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("shared capture manifest retains network and capability boundaries", () => {
  const manifest = fs
    .readFileSync(
      path.join(
        root,
        "packages/app/platforms/android/sense/src/main/AndroidManifest.xml",
      ),
      "utf8",
    )
    .replace(/<!--[\s\S]*?-->/g, "");
  const requested = [
    ...manifest.matchAll(
      /<uses-permission android:name="([^"]+)"(?![^>]*tools:node="remove")/g,
    ),
  ]
    .map((row) => row[1])
    .sort();
  assert.deepEqual(
    requested,
    [
      "CAPTURE_AUDIO_HOTWORD",
      "START_ACTIVITIES_FROM_BACKGROUND",
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_MICROPHONE",
      "RECORD_AUDIO",
      "POST_NOTIFICATIONS",
      "HIDE_OVERLAY_WINDOWS",
    ]
      .map((name) => `android.permission.${name}`)
      .sort(),
  );
  assert.match(manifest, /INTERNET" tools:node="remove"/);
  assert.match(manifest, /ACCESS_NETWORK_STATE" tools:node="remove"/);
  assert.match(manifest, /android:protectionLevel="signature"/);
  assert.match(
    manifest,
    /android:permission="android.permission.STATUS_BAR_SERVICE"/,
  );
  const service = fs.readFileSync(
    path.join(source, "ListeningService.java"),
    "utf8",
  );
  assert.match(service, /VoiceAssets.install\(this\).openAsr\(\)/);
  assert.doesNotMatch(service, /SpeechRecognizer|sherpa|onnx/i);
  assert.match(service, /active.cancel\(\)/);
  assert.match(service, /Listener.epoch.invalidate\(\)/);
  assert.match(service, /Arrays.fill\(samples,0f\)/);
  assert.match(
    service,
    /ListenerPolicy.mayInvokeAssistant\(keyguard==null\|\|keyguard.isKeyguardLocked\(\)\)/,
  );
});
