import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
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

function member(source, signature) {
  const start = source.indexOf(`    ${signature}`);
  assert.ok(start >= 0, `Missing production member: ${signature}`);
  const end = source.indexOf("\n    }", start);
  assert.ok(end > start, `Missing production member end: ${signature}`);
  return source.slice(start, end + "\n    }".length);
}

async function checkStorage(beforeCommit) {
  const updater = "packages/os/android/system-updater";
  const sourcePaths = {
    runner: `${updater}/host/ai/eliza/systemupdater/UpdateRunner.java`,
    verifier: `${updater}/src/ai/eliza/systemupdater/PackageVerifier.java`,
    journal: `${updater}/src/ai/eliza/systemupdater/UpdateJournal.java`,
  };
  const sources = {};
  for (const [name, file] of Object.entries(sourcePaths)) {
    sources[name] = beforeCommit
      ? run("git", ["show", `${beforeCommit}:${file}`])
      : await readFile(path.join(root, file), "utf8");
  }
  let storageGuard;
  if (beforeCommit) {
    const start = sources.verifier.indexOf("            long requiredSpace = ");
    const closing = "\n            }";
    const end = sources.verifier.indexOf(closing, start);
    const block = sources.verifier.slice(start, end + closing.length);
    assert.ok(
      start >= 0 &&
        end > start &&
        block.includes(
          'throw new IOException("Insufficient space to verify the update payload");',
        ),
      "Historical capacity guard differs from the original source",
    );
    storageGuard = `static void requirePayloadSpace(File outputDirectory, File destination, long size) throws IOException {\n${block}\n}`;
  } else {
    assert.ok(
      sources.verifier.includes(
        "requirePayloadSpace(outputDirectory, destination, size);",
      ),
    );
    assert.ok(
      sources.runner.includes(
        "run.verifying = true;\n            VerifiedPayload payload = PackageVerifier.verify(",
      ),
    );
    assert.ok(
      sources.runner.includes(
        "catch (Exception error) { failure(run, error); }",
      ),
    );
    storageGuard = [
      member(sources.verifier, "static final class StorageDeferred"),
      member(sources.verifier, "static void requirePayloadSpace("),
    ].join("\n");
  }
  const runnerMethods = [
    "synchronized boolean stop(",
    "private void failure(",
    "private synchronized void finish(",
  ]
    .map((signature) => member(sources.runner, signature))
    .join("\n");
  const compiled = {
    "UpdateRunner.java": `package ai.eliza.systemupdater;
import java.security.GeneralSecurityException;
import static ai.eliza.systemupdater.StorageReplay.*;
final class UpdateRunner {
    final Context context;
    final Handler main;
    Run active;
    UpdateRunner(Context context) { this.context = context; main = new Handler(context); }
    static void status(Context context, String message) { context.message = message; }
    void report(Run run, Exception error) { failure(run, error); }
${runnerMethods}
}
`,
    "PackageVerifier.java": `package ai.eliza.systemupdater;
import java.io.File;
import java.io.IOException;
final class PackageVerifier {
${storageGuard}
}
`,
    "UpdateJournal.java": sources.journal,
  };
  for (const [file, source] of Object.entries(compiled)) {
    await writeFile(path.join(out, file), source);
  }
  const tool = (name) =>
    process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", name)
      : name;
  const fixture = `${updater}/test/ai/eliza/systemupdater/StorageReplay.java`;
  run(tool("javac"), [
    "--release",
    "17",
    "-d",
    out,
    ...Object.keys(compiled).map((name) => path.join(out, name)),
    fixture,
  ]);
  const lowRoot = process.env.ELIZA_SYSTEM_UPDATE_STORAGE_LOW_DIR;
  const low = lowRoot
    ? await mkdtemp(path.join(await realpath(lowRoot), "eliza-storage-"))
    : undefined;
  const storageDir = path.join(out, "storage");
  await mkdir(storageDir);
  const observations = path.join(out, "storage-observations.json");
  try {
    const actual = spawnSync(
      tool("java"),
      [
        "-cp",
        out,
        "ai.eliza.systemupdater.StorageReplay",
        storageDir,
        beforeCommit ? "before" : "after",
        ...(low ? [low] : []),
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    await writeFile(
      path.join(out, "storage.log"),
      `${actual.stdout ?? ""}${actual.stderr ?? ""}`,
    );
    const rows = (actual.stdout ?? "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((row) => JSON.parse(row));
    const evidence = {
      schema: "eliza-system-update-storage-trace/v1",
      beforeCommit: beforeCommit ?? null,
      measuredLowVolume: !!low,
      javaExitCode: actual.status,
      scope:
        "Exact production storage, stop, failure and finish methods with host ports and the actual UpdateJournal. Guard admission plus the verified journal transition represents successful verification. Android trust, extraction, AtomicFile and scheduling are outside this check.",
      sourceHashes: Object.fromEntries(
        Object.entries(sources).map(([name, source]) => [
          sourcePaths[name],
          createHash("sha256").update(source).digest("hex"),
        ]),
      ),
      observations: rows,
    };
    await writeFile(observations, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`Storage observations: ${observations}\n`);
    assert.equal(actual.status, 0, actual.error?.message ?? actual.stderr);
    if (beforeCommit) {
      assert.ok(
        rows.some(
          (row) =>
            row.action === "beforeStickyFailure" && row.phase === "failed",
        ),
      );
      process.stdout.write(
        "Historical storage refusal persisted terminal FAILED.\n",
      );
      return;
    }
    const cases = Map.groupBy(
      rows.filter((row) => row.case !== "already-applied-guard"),
      (row) => row.case,
    );
    assert.equal(cases.size, low ? 5 : 4);
    const wrapper = path.join(out, "StorageSourceConformance.qnt");
    const model = path
      .relative(out, path.join(root, "packages/os/quint/SystemUpdateHost.qnt"))
      .replaceAll(path.sep, "/")
      .replace(/\.qnt$/, "");
    const actions = new Set([
      "start",
      "download",
      "verify",
      "stop",
      "deferStorage",
      "reject",
    ]);
    const definitions = [...cases.values()].map((trace, index) => {
      assert.equal(trace[0].action, "init");
      const expect = ({
        phase,
        active,
        stopped,
        verified,
        checked,
        storageReady,
      }) =>
        `all { M::s.phase == ${JSON.stringify(phase)}, M::s.active == ${active}, M::s.stopped == ${stopped}, M::s.verified == ${verified}, M::s.checked == ${checked}, M::s.storageReady == ${storageReady}, M::s.applyCalls == 0, M::s.reboots == 0 }`;
      let test = `M::init.expect(${expect(trace[0])})`;
      for (const row of trace.slice(1)) {
        if (row.action === "storage")
          test += `.then(M::storage(${row.storageReady}))`;
        else if (row.action !== "observe") {
          assert.ok(
            actions.has(row.action),
            `Unexpected source action: ${row.action}`,
          );
          test += `.then(M::${row.action})`;
        }
        test += `.expect(${expect(row)})`;
      }
      return `  run sourceStorage${index}Test = ${test}`;
    });
    await writeFile(
      wrapper,
      `module StorageSourceConformance {\n  import SystemUpdateHost as M from ${JSON.stringify(model)}\n${definitions.join("\n")}\n}\n`,
    );
    const replay = run(process.execPath, [
      cli,
      "test",
      wrapper,
      "--main=StorageSourceConformance",
      "--backend=typescript",
      "--max-samples=1",
      "--seed=20261110",
      "--match=^sourceStorage[0-9]+Test$",
    ]);
    assert.match(replay, new RegExp(`\\b${cases.size} passing`));
    process.stdout.write(replay);
    process.stdout.write(
      `PASS ${cases.size} storage source traces and ${[...cases.values()].flat().length} checkpoints\n`,
    );
  } finally {
    if (low) await rm(low, { recursive: true, force: true });
  }
}

const storageBefore = process.argv[2] === "--storage-before";
if (storageBefore || process.argv[2]?.endsWith("/SystemUpdateHost.qnt")) {
  if (storageBefore) assert.match(process.argv[3], /^[0-9a-f]{40}$/);
  await checkStorage(storageBefore ? process.argv[3] : undefined);
  process.exit(0);
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
