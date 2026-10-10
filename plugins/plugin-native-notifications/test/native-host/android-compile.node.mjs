import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Compiles every Android source against the SDK platform jar. This is a compile check, not a
// device test: it proves the module builds against the framework API it targets.
const plugin = fileURLToPath(new URL("../..", import.meta.url));
const sources = path.join(
  plugin,
  "android/src/main/java/ai/eliza/plugins/notifications",
);
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const platform = (() => {
  if (!sdk) return null;
  const root = path.join(sdk, "platforms");
  if (!fs.existsSync(root)) return null;
  const versions = fs
    .readdirSync(root)
    .map((name) => /^android-(\d+)$/.exec(name))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]))
    .filter(
      (level) =>
        level >= 33 &&
        fs.existsSync(path.join(root, `android-${level}`, "android.jar")),
    )
    .sort((a, b) => b - a);
  return versions.length
    ? path.join(root, `android-${versions[0]}`, "android.jar")
    : null;
})();
/** @param {string} name */
const bin = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
test("android sources compile against the SDK platform", (t) => {
  assert.ok(
    platform,
    "ANDROID_HOME/ANDROID_SDK_ROOT with an android-33+ platform is required",
  );
  const classes = fs.mkdtempSync(
    path.join(os.tmpdir(), "notification-mirror-android-"),
  );
  t.after(() => fs.rmSync(classes, { recursive: true, force: true }));
  const files = fs
    .readdirSync(sources)
    .filter((name) => name.endsWith(".java"))
    .map((name) => path.join(sources, name));
  execFileSync(
    bin("javac"),
    [
      "--release",
      "17",
      "-Xlint:-options",
      "-classpath",
      platform,
      "-d",
      classes,
      ...files,
    ],
    { timeout: 180000 },
  );
  for (const name of [
    "NotificationMirror",
    "NotificationMirrorConfig",
    "NotificationMirrorPolicy",
    "NotificationMirrorListenerService",
  ]) {
    assert.ok(
      fs.existsSync(
        path.join(classes, "ai/eliza/plugins/notifications", `${name}.class`),
      ),
      name,
    );
  }
});
