import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Compiles the trash removal request against org.json and runs the synthetic JVM checks.
// ELIZA_ORG_JSON_JAR names the jar; otherwise the Gradle cache copy is used when present.
// Not Android or MediaStore evidence.
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

test("a trash removal targets everything only on an explicit intent", {
  skip: jar ? false : "org.json jar unavailable (set ELIZA_ORG_JSON_JAR)",
}, (t) => {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), "trash-request-"));
  t.after(() => fs.rmSync(classes, { recursive: true, force: true }));
  execFileSync(
    bin("javac"),
    [
      "-cp",
      String(jar),
      "-d",
      classes,
      path.join(media, "TrashDeleteRequest.java"),
      path.join(media, "OwnedMediaSelection.java"),
      path.join(plugin, "test/native-host/TrashDeleteRequestTest.java"),
    ],
    { timeout: 60000 },
  );
  const out = execFileSync(
    bin("java"),
    ["-cp", `${classes}${path.delimiter}${jar}`, "TrashDeleteRequestTest"],
    { timeout: 60000, encoding: "utf8" },
  );
  assert.match(out, /^\d+ trash request checks passed/);
});

test("the owned library never reads a missing selection as the whole trash", () => {
  const library = fs.readFileSync(
    path.join(media, "OwnedMediaLibrary.java"),
    "utf8",
  );
  assert.match(
    library,
    /prepareDeleteTrash\(JSONArray requested\)[^{]*\{\s*return prepareDeleteTrash\(TrashDeleteRequest\.named\(requested\)\)/,
  );
  assert.ok(!/requested\s*[!=]=\s*null/.test(library), "no null-means-all branch");
});
