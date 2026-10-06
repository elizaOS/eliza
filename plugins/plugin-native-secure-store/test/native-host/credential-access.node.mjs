import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const plugin = fileURLToPath(new URL("../..", import.meta.url));
test("device credential grants fence stale results and expire by elapsed time", (t) => {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), "credential-access-"));
  t.after(() => fs.rmSync(classes, { recursive: true, force: true }));
  const bin = (name) =>
    process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", name)
      : name;
  execFileSync(
    bin("javac"),
    [
      "-d",
      classes,
      path.join(
        plugin,
        "android/src/main/java/ai/eliza/plugins/securestore/nativeonly/CredentialAccessSession.java",
      ),
      path.join(plugin, "test/native-host/CredentialAccessSessionTest.java"),
    ],
    { timeout: 60000 },
  );
  const output = execFileSync(
    bin("java"),
    ["-cp", classes, "CredentialAccessSessionTest"],
    { timeout: 60000, encoding: "utf8" },
  );
  assert.match(output, /27 assertions passed/);
});
