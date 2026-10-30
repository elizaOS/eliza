import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Compiles the Photos bridge rules against org.json and runs the synthetic JVM checks, then checks
// the shape of the Capacitor bindings that apply them. ELIZA_ORG_JSON_JAR names the jar; otherwise
// the Gradle cache copy is used when present. Not Android or MediaStore evidence.
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
/** @param {string} name */
const source = (name) =>
  fs.readFileSync(path.join(media, `${name}.java`), "utf8");

test("Photos bridge rules: scope, aliases, listings, bounds and changes", {
  skip: jar ? false : "org.json jar unavailable (set ELIZA_ORG_JSON_JAR)",
}, (t) => {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), "photo-access-"));
  t.after(() => fs.rmSync(classes, { recursive: true, force: true }));
  execFileSync(
    bin("javac"),
    [
      "-cp",
      String(jar),
      "-d",
      classes,
      path.join(media, "PhotoLibraryAccess.java"),
      path.join(plugin, "test/native-host/PhotoLibraryAccessTest.java"),
    ],
    { timeout: 60000 },
  );
  const out = execFileSync(
    bin("java"),
    ["-cp", `${classes}${path.delimiter}${jar}`, "PhotoLibraryAccessTest"],
    { timeout: 60000, encoding: "utf8" },
  );
  assert.match(out, /^\d+ photo library access checks passed/);
});

test("the Photos plugins are host-registered bindings with no product names", () => {
  const photos = source("PhotosPlugin");
  const library = source("DeviceLibraryPlugin");
  for (const body of [photos, library]) {
    assert.match(body, /^public abstract class \w+ extends Plugin \{/m);
    assert.doesNotMatch(
      body,
      /^@CapacitorPlugin\(/m,
      "the host names the plugin",
    );
    assert.doesNotMatch(body, /alpha/i);
    assert.match(body, /requireLibraryAliases\(this\)/);
  }
  assert.match(photos, /protected abstract OwnedMediaConfig mediaConfig\(\);/);
  assert.match(photos, /protected abstract String playbackPath\(\);/);
  assert.match(library, /protected abstract String photosPluginName\(\);/);
  // Access is requested only from the explicit control, through the launcher guard.
  assert.match(
    photos,
    /ask\(call, \(\) -> requestPermissionForAliases\(aliases, call, "libraryPermissionResult"\)\)/,
  );
  assert.match(
    library,
    /requestPermissionForAliases\(aliases, call, "libraryPermissionResult"\);\n {4}\} catch \(IllegalStateException closed\)/,
  );
  // Every permitted read is published only under the ticket it started with.
  assert.match(photos, /permitted\.publish\(call, value, ticket\)/);
  assert.equal((library.match(/catalog\.publish\(call,/g) || []).length, 3);
  // Foreground cancellation: pausing cancels video copies and stops observation.
  assert.match(
    photos,
    /handleOnPause\(\) \{\n {4}if \(videoCopies != null\) videoCopies\.cancel\(null\);\n {4}if \(permitted != null\) \{\n {6}permitted\.watch\("photos", false\);\n {6}permitted\.foreground\(false\);/,
  );
  // Destructive changes to other apps' media go through the native review only.
  for (const body of [photos, library])
    assert.doesNotMatch(
      body,
      /createDeleteRequest|createTrashRequest|createFavoriteRequest/,
    );
  assert.match(library, /Manage permanent deletion in Android Photos\./);
  // The recovery of a closed failed video copy is native-only.
  assert.match(photos, /protected final void preserveClosedFailure\(/);
  assert.doesNotMatch(
    photos,
    /@PluginMethod\s+public void preserveClosedFailure/,
  );
});
