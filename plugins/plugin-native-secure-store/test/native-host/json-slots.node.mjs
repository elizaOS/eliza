import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const plugin = fileURLToPath(new URL("../..", import.meta.url));
const native = path.join(
  plugin,
  "android-nativeonly/src/main/java/ai/eliza/plugins/securestore/nativeonly/JsonCredentialSlots.java",
);

test("JSON slots preserve authenticated 32 MiB values and CAS within a 192 MiB heap", (t) => {
  const cache = path.join(
    os.homedir(),
    ".gradle/caches/modules-2/files-2.1/org.json/json/20250517",
  );
  const jar =
    process.env.ELIZA_JSON_JAR ||
    (fs.existsSync(cache)
      ? fs.readdirSync(cache).flatMap((dir) =>
          fs
            .readdirSync(path.join(cache, dir))
            .filter((name) => name === "json-20250517.jar")
            .map((name) => path.join(cache, dir, name)),
        )[0]
      : undefined);
  assert.ok(
    jar,
    "Set ELIZA_JSON_JAR to org.json:json:20250517 or resolve its Gradle dependency",
  );
  const classes = fs.mkdtempSync(
    path.join(os.tmpdir(), "json-credential-slots-"),
  );
  t.after(() => fs.rmSync(classes, { recursive: true, force: true }));
  const bin = (name) =>
    process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", name)
      : name;
  let source = fs
    .readFileSync(native, "utf8")
    .replace("import android.security.keystore.KeyGenParameterSpec;", "")
    .replace("import android.security.keystore.KeyProperties;", "");
  // Adapt only Android key acquisition. Encryption, authentication, byte limits,
  // JSON validation, committed-byte checks and CAS execute the actual source.
  const start = source.indexOf(" private SecretKey key()"),
    end = source.indexOf(" private static Object parseJson", start);
  assert.ok(start > 0 && end > start, "The key-acquisition region exists");
  source =
    source.slice(0, start) +
    ' private SecretKey key(){return new javax.crypto.spec.SecretKeySpec(new byte[32],"AES");}\n' +
    source.slice(end);
  const staged = path.join(classes, "JsonCredentialSlots.java");
  fs.writeFileSync(staged, source);
  execFileSync(
    bin("javac"),
    [
      "--release",
      "11",
      "-cp",
      jar,
      "-d",
      classes,
      staged,
      path.join(plugin, "test/native-host/android/util/AtomicFile.java"),
      path.join(plugin, "test/native-host/JsonCredentialSlotsMemoryTest.java"),
    ],
    { timeout: 60000 },
  );
  const output = execFileSync(
    bin("java"),
    [
      "-Xmx192m",
      "-cp",
      classes + path.delimiter + jar,
      "JsonCredentialSlotsMemoryTest",
      path.join(classes, "slots"),
    ],
    { timeout: 600000, encoding: "utf8" },
  );
  assert.match(
    output,
    /PASS 32 MiB authenticated write\/read\/CAS with 192 MiB heap/,
  );
});
