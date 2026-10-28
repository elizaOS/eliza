import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Compiles the host notice receipts, routes, owner fence, approval coordination and journal recovery
// against org.json and runs the synthetic JVM checks. ELIZA_ORG_JSON_JAR names the jar; otherwise the
// Gradle cache copy is used when present.
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

test("host notice routes, owner fence, approval coordination, journal recovery and tap inbox", {
  skip: jar ? false : "org.json jar unavailable (set ELIZA_ORG_JSON_JAR)",
}, (t) => {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), "notice-host-"));
  t.after(() => fs.rmSync(classes, { recursive: true, force: true }));
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
      ...[
        "NoticeDelivery",
        "NoticeOwner",
        "NoticeRoutes",
        "NoticeCoordinator",
        "NoticeRecovery",
        "NoticeTapInbox",
      ].map((name) => path.join(sources, `${name}.java`)),
      path.join(plugin, "test/native-host/NoticeHostTest.java"),
      path.join(plugin, "test/native-host/NoticeTapInboxTest.java"),
    ],
    { timeout: 60000 },
  );
  for (const main of ["NoticeHostTest", "NoticeTapInboxTest"]) {
    const output = execFileSync(
      bin("java"),
      ["-cp", [classes, jar].join(path.delimiter), main],
      { timeout: 60000, encoding: "utf8" },
    );
    assert.match(output, /^\d+ assertions passed/, main);
  }
});
