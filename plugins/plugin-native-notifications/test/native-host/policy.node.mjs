import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const plugin = fileURLToPath(new URL("../..", import.meta.url));
const sources = path.join(
  plugin,
  "android/src/main/java/ai/eliza/plugins/notifications",
);
/** @param {string} name */
const bin = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
test("notification mirror configuration and policy decisions", (t) => {
  const classes = fs.mkdtempSync(
    path.join(os.tmpdir(), "notification-mirror-policy-"),
  );
  t.after(() => fs.rmSync(classes, { recursive: true, force: true }));
  execFileSync(
    bin("javac"),
    [
      "-d",
      classes,
      path.join(sources, "NotificationMirrorConfig.java"),
      path.join(sources, "NotificationMirrorPolicy.java"),
      path.join(plugin, "test/native-host/NotificationMirrorPolicyTest.java"),
    ],
    { timeout: 120000 },
  );
  const output = execFileSync(
    bin("java"),
    ["-cp", classes, "NotificationMirrorPolicyTest"],
    {
      timeout: 60000,
      encoding: "utf8",
    },
  );
  assert.match(output, /^\d+ assertions passed/);
});
