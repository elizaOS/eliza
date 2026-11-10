import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const out = await mkdtemp(
  path.join(
    await mkdir(testOutputPath("system-update-journal"), {
      recursive: true,
    }).then(() => testOutputPath("system-update-journal")),
    "run-",
  ),
);
const require = createRequire(import.meta.url),
  cli = path.join(
    path.dirname(require.resolve("@informalsystems/quint/package.json")),
    "dist/src/cli.js",
  );
function run(command, args) {
  const r = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stdout + "\n" + r.stderr);
  return r.stdout;
}
run(process.execPath, [
  cli,
  "run",
  "packages/os/quint/SystemUpdateJournal.qnt",
  "--main=SystemUpdateJournal",
  "--backend=typescript",
  "--seed=20261110",
  "--max-samples=50",
  "--n-traces=50",
  "--max-steps=16",
  "--invariant=invariant",
  `--out-itf=${path.join(out, "trace-{seq}.itf.json")}`,
  "--verbosity=0",
]);
const files = (await readdir(out)).filter((n) =>
  /^trace-\d+\.itf\.json$/.test(n),
);
assert.equal(files.length, 50);
const lines = [];
for (const name of files) {
  const t = JSON.parse(await readFile(path.join(out, name), "utf8"));
  assert.equal(t.vars.length, 1);
  for (const row of t.states) {
    const s = row[t.vars[0]];
    lines.push(s.operation + "\t" + s.phase);
  }
}
const vectors = path.join(out, "vectors.tsv");
await writeFile(vectors, lines.join("\n") + "\n");
const java = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, "bin/java")
    : "java",
  javac = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, "bin/javac")
    : "javac";
run(javac, [
  "--release",
  "17",
  "-d",
  out,
  "packages/os/android/system-updater/src/ai/eliza/systemupdater/UpdateJournal.java",
  "packages/os/android/system-updater/test/ai/eliza/systemupdater/JournalReplay.java",
]);
const result = run(java, [
  "-cp",
  out,
  "ai.eliza.systemupdater.JournalReplay",
  vectors,
]);
assert.match(
  result,
  new RegExp(`PASS ${lines.length} production journal states`),
);
const journalResult = {
  traces: files.length,
  states: lines.length,
  implementation: "production UpdateJournal.java",
  androidQualified: false,
};
process.stdout.write(result);

// Exercise the production downloader against owned TLS sockets and real private files.
// Android/JSON ports below are compile-only; discovery and package verification are not invoked.
const ports = {
  "android/os/Build.java": `package android.os;
public final class Build { public static final long TIME=0; public static final String FINGERPRINT="source"; }
`,
  "android/os/SystemClock.java": `package android.os;
public final class SystemClock { public static long elapsedRealtime(){return System.nanoTime()/1_000_000L;} }
`,
  "org/json/JSONException.java": `package org.json;
public final class JSONException extends Exception { public JSONException(String message){super(message);} }
`,
  "org/json/JSONObject.java": `package org.json;
public final class JSONObject {
 public JSONObject(String value) throws JSONException {throw new JSONException("Discovery is not exercised");}
 public int getInt(String key) throws JSONException {throw new JSONException("Discovery is not exercised");}
 public String getString(String key) throws JSONException {throw new JSONException("Discovery is not exercised");}
 public Object get(String key) throws JSONException {throw new JSONException("Discovery is not exercised");}
}
`,
};
const portFiles = [];
for (const [name, bytes] of Object.entries(ports)) {
  const file = path.join(out, "download-ports", name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  portFiles.push(file);
}
run(javac, [
  "--release",
  "17",
  "--add-modules",
  "jdk.httpserver",
  "-d",
  out,
  ...portFiles,
  "packages/os/android/system-updater/src/ai/eliza/systemupdater/UpdateChannel.java",
  "packages/os/android/system-updater/test/ai/eliza/systemupdater/DownloadReplay.java",
]);
const keytool = process.env.JAVA_HOME
  ? path.join(process.env.JAVA_HOME, "bin/keytool")
  : "keytool";
const keyStore = path.join(out, "download-tls.p12");
run(keytool, [
  "-genkeypair",
  "-alias",
  "fixture",
  "-keyalg",
  "RSA",
  "-storetype",
  "PKCS12",
  "-keystore",
  keyStore,
  "-storepass",
  "fixture-pass",
  "-keypass",
  "fixture-pass",
  "-dname",
  "CN=localhost",
  "-ext",
  "SAN=dns:localhost,ip:127.0.0.1",
  "-validity",
  "2",
  "-noprompt",
]);
const observations = path.join(out, "download-observations.json");
process.stdout.write(`Download observations: ${observations}\n`);
try {
  const download = run(java, [
    "--add-modules",
    "jdk.httpserver",
    "-cp",
    out,
    "ai.eliza.systemupdater.DownloadReplay",
    path.join(out, "downloads"),
    keyStore,
    observations,
  ]);
  process.stdout.write(download);
} finally {
  // This disposable TLS fixture key has no release authority and does not enter evidence archives.
  await rm(keyStore, { force: true });
}

const observed = JSON.parse(await readFile(observations, "utf8"));
assert.equal(observed.schema, "eliza-system-update-download-trace/v1");
assert.ok(
  Number.isSafeInteger(observed.expectedBytes) && observed.expectedBytes > 0,
);
assert.match(observed.expectedSha256, /^[a-f0-9]{64}$/);
assert.match(observed.prefixSha256, /^[a-f0-9]{64}$/);
function partialClass(row) {
  if (row.partialBytes === 0) return "empty";
  assert.equal(row.partialExists, true);
  assert.match(row.partialSha256, /^[a-f0-9]{64}$/);
  if (row.partialBytes > observed.expectedBytes) return "oversized";
  if (row.partialBytes === observed.expectedBytes)
    return row.partialSha256 === observed.expectedSha256 ? "valid" : "corrupt";
  assert.equal(row.partialBytes, observed.prefixBytes);
  return row.partialSha256 === observed.prefixSha256 ? "prefix" : "bad-prefix";
}
function expectation(row) {
  const published = row.zipBytes !== 0;
  if (published) {
    assert.equal(row.zipBytes, observed.expectedBytes);
    assert.equal(row.zipSha256, observed.expectedSha256);
    assert.equal(row.partialBytes, 0);
  } else assert.equal(row.zipSha256, null);
  const outcome =
    row.operation === "initial"
      ? "ready"
      : row.operation === "seed"
        ? "seeded"
        : row.success
          ? "published"
          : "rejected";
  return `all { M::invariant, M::s.partial == ${JSON.stringify(partialClass(row))}, M::s.published == ${published}, M::s.requests == ${row.requests}, M::s.rangeRequests == ${row.rangeRequests}, M::s.outcome == ${JSON.stringify(outcome)} }`;
}
const cases = new Map();
for (const row of observed.observations) {
  if (!cases.has(row.case)) cases.set(row.case, []);
  cases.get(row.case).push(row);
}
assert.equal(cases.size, 5);
const replayDefinitions = [...cases.values()].map((rows, index) => {
  assert.equal(rows[0].operation, "initial");
  let trace = `M::init.expect(${expectation(rows[0])})`;
  for (const row of rows.slice(1)) {
    const action =
      row.operation === "seed"
        ? `M::seed(${JSON.stringify(partialClass(row))})`
        : `M::attempt("valid")`;
    trace += `.then(${action}).expect(${expectation(row)})`;
  }
  return `  run sourceDownload${index}Test = ${trace}`;
});
const downloadWrapper = path.join(out, "DownloadSourceConformance.qnt");
const modelImport = path
  .relative(out, path.join(root, "packages/os/quint/SystemUpdateDownload.qnt"))
  .replaceAll(path.sep, "/")
  .replace(/\.qnt$/, "");
await writeFile(
  downloadWrapper,
  `module DownloadSourceConformance {\n  import SystemUpdateDownload as M from ${JSON.stringify(modelImport)}\n${replayDefinitions.join("\n")}\n}\n`,
);
const compared = run(process.execPath, [
  cli,
  "test",
  downloadWrapper,
  "--main=DownloadSourceConformance",
  "--backend=typescript",
  "--max-samples=1",
  "--seed=20261110",
  "--match=^sourceDownload[0-9]+Test$",
]);
assert.match(compared, /5 passing/);
process.stdout.write(compared);
await writeFile(
  path.join(out, "result.json"),
  `${JSON.stringify({
    ...journalResult,
    download: {
      cases: cases.size,
      checkpoints: observed.observations.length,
      implementation: "production UpdateChannel.java",
      transport: "owned HTTPS server with real Range and filesystem operations",
      androidQualified: false,
    },
  })}\n`,
);
