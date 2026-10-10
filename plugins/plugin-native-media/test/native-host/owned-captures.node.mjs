import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const plugin = fileURLToPath(new URL("../..", import.meta.url));
const media = path.join(plugin, "android/src/main/java/ai/eliza/plugins/media");
/** @param {string} name */
const bin = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;

test("capture admission and owned-media selections", (t) => {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), "owned-captures-"));
  t.after(() => fs.rmSync(classes, { recursive: true, force: true }));
  execFileSync(
    bin("javac"),
    [
      "-d",
      classes,
      ...["CaptureAdmission", "OwnedMediaSelection"].map((name) =>
        path.join(media, `${name}.java`),
      ),
      path.join(plugin, "test/native-host/OwnedCapturesTest.java"),
    ],
    { timeout: 60000 },
  );
  const output = execFileSync(
    bin("java"),
    ["-cp", classes, "OwnedCapturesTest"],
    {
      timeout: 60000,
      encoding: "utf8",
    },
  );
  assert.match(output, /^\d+ assertions passed/);
});
