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

/**
 * @param {import("node:test").TestContext} t
 * @param {string[]} sources
 * @param {string} main
 */
function run(t, sources, main) {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), "permitted-media-"));
  t.after(() => fs.rmSync(classes, { recursive: true, force: true }));
  execFileSync(
    bin("javac"),
    [
      "-d",
      classes,
      ...sources.map((name) => path.join(media, `${name}.java`)),
      path.join(plugin, `test/native-host/${main}.java`),
    ],
    { timeout: 60000 },
  );
  return execFileSync(bin("java"), ["-cp", classes, main], {
    timeout: 60000,
    encoding: "utf8",
  });
}

test("permitted-library identities, video copy rules and host placement", (t) => {
  assert.match(
    run(
      t,
      ["MediaLibraryKey", "VideoEditSpec", "OwnedMediaConfig"],
      "PermittedMediaTest",
    ),
    /^\d+ assertions passed/,
  );
});

test("exact selected-photo copies, document bytes and source references", (t) => {
  assert.match(
    run(
      t,
      ["SelectedPhotoCopy", "DocumentBytes", "SourceReferences"],
      "SelectedDocumentsTest",
    ),
    /^\d+ assertions passed/,
  );
});
