import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Compiles the recording store against org.json and a host test double of AtomicFile, then runs
// the synthetic JVM checks. ELIZA_ORG_JSON_JAR names the jar; otherwise the Gradle cache copy is
// used when present. Not Android, Keystore or MediaPlayer evidence.
const plugin = fileURLToPath(new URL("../..", import.meta.url));
const media = path.join(plugin, "android/src/main/java/ai/eliza/plugins/media");
const cached = () => {
  const root = path.join(
    os.homedir(),
    ".gradle/caches/modules-2/files-2.1/org.json/json",
  );
  if (!fs.existsSync(root)) return undefined;
  for (const version of fs.readdirSync(root).sort().reverse())
    for (const hash of fs.readdirSync(path.join(root, version))) {
      const jar = path.join(root, version, hash, `json-${version}.jar`);
      if (fs.existsSync(jar)) return jar;
    }
  return undefined;
};
const jar = process.env.ELIZA_ORG_JSON_JAR || cached();
/** @param {string} name */
const bin = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;

test("recording receipts, owner fences, retention and legacy migration", {
  skip: jar ? false : "org.json jar unavailable (set ELIZA_ORG_JSON_JAR)",
}, (t) => {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), "recording-store-"));
  t.after(() => fs.rmSync(classes, { recursive: true, force: true }));
  execFileSync(
    bin("javac"),
    [
      "-cp",
      String(jar),
      "-d",
      classes,
      path.join(media, "RecordingStore.java"),
      path.join(
        plugin,
        "test/native-host/android-stubs/android/util/AtomicFile.java",
      ),
      path.join(plugin, "test/native-host/RecordingStoreTest.java"),
    ],
    { timeout: 60000 },
  );
  const out = execFileSync(
    bin("java"),
    [
      // The store syncs every commit; TMPDIR chooses where its synthetic files live.
      `-Djava.io.tmpdir=${os.tmpdir()}`,
      "-cp",
      `${classes}${path.delimiter}${jar}`,
      "ai.eliza.plugins.media.RecordingStoreTest",
    ],
    { timeout: 120000, encoding: "utf8" },
  );
  assert.match(out, /recording store checks: \d+/);
});

test("the recording store keeps paths and bytes off the bridge", () => {
  const store = fs.readFileSync(
    path.join(media, "RecordingStore.java"),
    "utf8",
  );
  assert.ok(
    !/com\.getcapacitor|JSObject|PluginCall/.test(store),
    "no bridge types",
  );
  assert.ok(
    !/put\("(?:path|file|uri)"/.test(store),
    "metadata and receipts never carry a path",
  );
});
