import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Synthetic JVM checks of the export rules and isolated-PDF bounds, plus source checks of where
// the Android classes apply them. Not Android, provider, PdfRenderer or isolated-process evidence.
const plugin = fileURLToPath(new URL("../..", import.meta.url));
const media = path.join(plugin, "android/src/main/java/ai/eliza/plugins/media");
/** @param {string} name */
const bin = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
/** @param {string} name */
const source = (name) =>
  fs.readFileSync(path.join(media, `${name}.java`), "utf8");

test("export rules and isolated PDF bounds", (t) => {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), "document-export-"));
  t.after(() => fs.rmSync(classes, { recursive: true, force: true }));
  execFileSync(
    bin("javac"),
    [
      "-d",
      classes,
      path.join(media, "DocumentExport.java"),
      path.join(media, "PdfPageLimits.java"),
      path.join(plugin, "test/native-host/DocumentExportTest.java"),
    ],
    { timeout: 60000 },
  );
  const output = execFileSync(
    bin("java"),
    ["-cp", classes, "DocumentExportTest"],
    { timeout: 60000, encoding: "utf8" },
  );
  assert.match(output, /^\d+ assertions passed/);
});

test("the renderer runs only isolated and the viewer checks every reply before mapping", () => {
  const service = source("IsolatedPdfRenderService");
  assert.match(
    service,
    /onBind\(Intent intent\) \{\s*return Process\.isIsolated\(\) \? endpoint\.getBinder\(\) : null;/,
  );
  assert.match(service, /PdfPageLimits\.admitsRequest\(request, page\)/);
  assert.match(
    service,
    /PdfPageLimits\.requireSource\(descriptor\.getStatSize\(\)\)/,
  );
  assert.match(service, /shared\.setProtect\(OsConstants\.PROT_READ\)/);
  assert.match(
    service,
    /protected boolean stallFixture\(Bundle request\) \{\s*return false;/,
    "release hosts cannot stall the renderer",
  );
  const viewer = source("IsolatedPdfViewerActivity");
  const reply = viewer.indexOf("PdfPageLimits.requireReply(");
  const map = viewer.indexOf("pixels.mapReadOnly()");
  assert.ok(
    reply > 0 && map > reply,
    "the reply is checked before pixels are mapped",
  );
  assert.match(
    viewer,
    /!"content"\.equals\(source\.getScheme\(\)\) \|\| !admits\(source\)/,
  );
  assert.ok(
    !/PdfRenderer/.test(viewer),
    "the viewer process never parses the PDF",
  );
  const manifest = fs.readFileSync(
    path.join(plugin, "android/src/main/AndroidManifest.xml"),
    "utf8",
  );
  assert.ok(
    !/<service|<activity|<provider/.test(manifest),
    "the library declares no component; hosts declare their subclasses",
  );
});

test("handoff copies are single, revoked and admitted only under their provider path", () => {
  const handoff = source("ReviewedFileHandoff");
  const write = handoff.slice(handoff.indexOf("public File write("));
  assert.ok(
    write.indexOf("cleanup();") < write.indexOf("new FileOutputStream"),
  );
  assert.match(write, /out\.getFD\(\)\.sync\(\);/);
  assert.match(
    handoff,
    /context\.revokeUriPermission\(uri\(file\), Intent\.FLAG_GRANT_READ_URI_PERMISSION\)/,
  );
  assert.match(
    handoff,
    /authority\.equals\(uri\.getAuthority\(\)\)[\s\S]*DocumentExport\.handoffPath\(segments, pathName\)/,
  );
  const destinations = source("DocumentDestinations");
  const opened = destinations.indexOf("opened = true;");
  assert.ok(
    opened > 0 && opened < destinations.indexOf("out.write(content);"),
    "a write that reached the provider is never reported as failed",
  );
  assert.match(
    destinations,
    /DocumentExport\.verify\(in, content, content\.length\)/,
  );
});
