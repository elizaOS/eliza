import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Compiles the background new-mail reconciliation engine and delivery coordinator against org.json and
// runs the synthetic JVM checks: durable pagination, at-most-once notices, owner and grant fences, tap
// capture and unsupported deployments. ELIZA_ORG_JSON_JAR names the jar; otherwise the Gradle cache copy
// is used when present.
const plugin = fileURLToPath(new URL("../..", import.meta.url));
const sources = path.join(
  plugin,
  "android/src/main/java/ai/eliza/plugins/notifications",
);
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

test("mail history reconciliation and background delivery fences", {
  skip: jar ? false : "org.json jar unavailable (set ELIZA_ORG_JSON_JAR)",
}, (t) => {
  if (!jar) return;
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), "mail-background-"));
  t.after(() => fs.rmSync(classes, { recursive: true, force: true }));
  /** @param {string} name */
  const bin = (name) =>
    process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", name)
      : name;
  execFileSync(
    bin("javac"),
    [
      "-cp",
      jar,
      "-d",
      classes,
      path.join(sources, "MailHistoryReconciliation.java"),
      path.join(sources, "MailBackgroundDelivery.java"),
      path.join(plugin, "test/native-host/MailHistoryReconciliationTest.java"),
      path.join(plugin, "test/native-host/MailBackgroundDeliveryTest.java"),
    ],
    { timeout: 60000 },
  );
  const run = (/** @type {string} */ main) =>
    execFileSync(bin("java"), ["-cp", [classes, jar].join(path.delimiter), main], {
      timeout: 60000,
      encoding: "utf8",
    });
  assert.match(run("MailHistoryReconciliationTest"), /^PASS mail durable/);
  assert.match(run("MailBackgroundDeliveryTest"), /^\d+ assertions passed/);
});
