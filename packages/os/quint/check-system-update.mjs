import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
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
        "run.verifying = unapplied;\n            VerifiedPayload payload = PackageVerifier.verify(",
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

async function checkScratch({ includeHeld, heldOnly, heldBefore }) {
  const updater = "packages/os/android/system-updater";
  const javaSources = `${updater}/src/ai/eliza/systemupdater`;
  const fixture = `${updater}/test/ai/eliza/systemupdater/ScratchReplay.java`;
  const runner = `${updater}/host/ai/eliza/systemupdater/UpdateRunner.java`;
  const model = "packages/os/quint/SystemUpdateHost.qnt";
  const sources = [
    `${javaSources}/PackageVerifier.java`,
    `${javaSources}/VerifiedPayload.java`,
    `${javaSources}/UpdateJournal.java`,
    fixture,
    runner,
    model,
    "packages/os/quint/SystemUpdateHost.cases.json",
    "packages/os/quint/check-system-update.mjs",
  ];
  const readSources = async () =>
    Object.fromEntries(
      await Promise.all(
        sources.map(async (file) => [
          file,
          createHash("sha256")
            .update(await readFile(path.join(root, file)))
            .digest("hex"),
        ]),
      ),
    );
  const sourceHashes = await readSources();
  const runnerSource = await readFile(path.join(root, runner), "utf8");
  const verifierSource = await readFile(path.join(root, sources[0]), "utf8");
  assert.match(
    runnerSource,
    /if \(!current\.targetBuild\.equals\(candidate\.fingerprint\)\s+\|\| !current\.packageSha256\.equals\(candidate\.sha256\)\) \{[^}]+return;\s+\}\s+boolean unapplied = current\.isUnapplied\(\);\s+Path scratch = unapplied\s+\? PackageVerifier\.reclaimExtractionScratch\(directory\.toPath\(\)\) : null;[\s\S]*?channel\.download\(candidate, directory\);[\s\S]*?run\.verifying = unapplied;[\s\S]*?PackageVerifier\.verify\([\s\S]*?R\.string\.os_update_ota_certificate\), scratch\);/,
  );
  assert.match(
    verifierSource,
    /hasRetainedPayload\(destination\);\s+if \(!retained && scratch == null\) throw new IOException\([^)]*\);\s+requirePayloadSpace\(outputDirectory, destination, size\);[\s\S]*?createExtractionScratch\(scratch\);/,
  );

  // Compile the exact verifier. Android trust and engine ports are never called here.
  const ports = {
    "android/os/Build.java": `package android.os;
public final class Build { public static long TIME; public static String FINGERPRINT;
 public static final class VERSION { public static String SECURITY_PATCH; } }`,
    "android/os/RecoverySystem.java": `package android.os;
public final class RecoverySystem { public static void verifyPackage(java.io.File file, Object a, Object b) {
 throw new AssertionError("Android package verification is outside this replay"); } }`,
    "android/os/ParcelFileDescriptor.java": `package android.os;
public final class ParcelFileDescriptor { public static final int MODE_READ_ONLY = 0;
 public static ParcelFileDescriptor open(java.io.File file, int mode) {
 throw new AssertionError("Engine descriptor is outside this replay"); } }`,
    "android/content/res/AssetFileDescriptor.java": `package android.content.res;
public final class AssetFileDescriptor { public AssetFileDescriptor(android.os.ParcelFileDescriptor fd, long offset, long size) {
 throw new AssertionError("Engine descriptor is outside this replay"); } }`,
  };
  const portFiles = [];
  for (const [name, bytes] of Object.entries(ports)) {
    const file = path.join(out, "scratch-ports", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    portFiles.push(file);
  }
  const tool = (name) =>
    process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", name)
      : name;
  if (includeHeld || heldOnly) {
    await checkHeldVerification({
      tool,
      portFiles,
      runner,
      model,
      javaSources,
      heldBefore,
    });
  }
  if (heldOnly) return;
  const classes = path.join(out, "scratch-classes");
  await mkdir(classes);
  run(tool("javac"), [
    "--release",
    "17",
    "-d",
    classes,
    ...portFiles,
    ...sources.slice(0, 4),
  ]);
  const actual = (dir, action, code = 0) => {
    const result = spawnSync(
      tool("java"),
      ["-cp", classes, "ai.eliza.systemupdater.ScratchReplay", dir, action],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    assert.equal(
      result.status,
      code,
      result.stdout + result.stderr + (result.error ?? ""),
    );
    return result.stdout.trim();
  };

  const slotName = "pre-apply-payload-scratch-v1";
  const protectedBytes = "keep these bytes";
  const owned = await mkdir(path.join(out, "scratch-owned")).then(() =>
    path.join(out, "scratch-owned"),
  );
  const legacy = await mkdir(path.join(out, "scratch-legacy")).then(() =>
    path.join(out, "scratch-legacy"),
  );
  const slot = path.join(owned, slotName);
  const partial = path.join(slot, "payload.partial");
  const protectedNames = [
    "payload-legacy.partial",
    `${"b".repeat(64)}.payload`,
    `${"b".repeat(64)}.zip`,
  ];
  for (const name of protectedNames)
    await writeFile(path.join(owned, name), protectedBytes);
  // A death after directory creation but before marker creation leaves an empty slot.
  await mkdir(slot);
  const checkpoints = [];
  for (let i = 0; i < 2; i++) {
    actual(owned, "cut", 73);
    assert.deepEqual((await readdir(slot)).sort(), [
      "owner",
      "payload.partial",
    ]);
    assert.equal((await stat(partial)).size, 4096);
    assert.ok(!(await readdir(owned)).includes("candidate.payload"));
    checkpoints.push({
      stage: "crash",
      ownedScratchBytes: (await stat(partial)).size,
    });
    actual(legacy, "legacy-cut", 73);
  }
  assert.equal(
    (await readdir(legacy)).filter((name) => /^payload-.*\.partial$/.test(name))
      .length,
    2,
  );
  assert.equal(actual(owned, "publish"), "published");
  assert.deepEqual(await readdir(slot), ["owner"]);
  assert.equal((await stat(path.join(owned, "candidate.payload"))).size, 65536);
  checkpoints.push({ stage: "verified", ownedScratchBytes: 0 });

  const unknown = path.join(out, "scratch-unknown");
  const unknownSlot = path.join(unknown, slotName);
  const unknownPartial = path.join(unknownSlot, "payload.partial");
  await mkdir(unknownSlot, { recursive: true });
  await writeFile(unknownPartial, protectedBytes);
  assert.equal(actual(unknown, "refuse"), "refused");
  assert.equal(await readFile(unknownPartial, "utf8"), protectedBytes);
  await rm(unknownPartial);
  await writeFile(path.join(unknownSlot, "owner"), "");
  await symlink(path.join(owned, protectedNames[1]), unknownPartial);
  assert.equal(actual(unknown, "refuse"), "refused");
  assert.equal(await readFile(unknownPartial, "utf8"), protectedBytes);
  assert.deepEqual((await readdir(unknownSlot)).sort(), [
    "owner",
    "payload.partial",
  ]);
  await rm(unknownPartial);
  await writeFile(unknownPartial, protectedBytes);
  const unrelated = path.join(unknownSlot, "unrelated");
  await writeFile(unrelated, protectedBytes);
  assert.equal(actual(unknown, "refuse"), "refused");
  assert.equal(await readFile(unknownPartial, "utf8"), protectedBytes);
  assert.equal(await readFile(unrelated, "utf8"), protectedBytes);
  const danglingDir = path.join(out, "scratch-dangling-final");
  const dangling = path.join(danglingDir, "candidate.payload");
  await mkdir(danglingDir);
  await symlink("absent", dangling);
  assert.equal(actual(danglingDir, "refuse-final"), "refused final");
  assert.equal(await readlink(dangling), "absent");
  for (const name of protectedNames)
    assert.equal(
      await readFile(path.join(owned, name), "utf8"),
      protectedBytes,
    );
  checkpoints.push({ stage: "refused", foreignBytesPreserved: true });

  const importPath = path
    .relative(out, path.join(root, model))
    .replaceAll(path.sep, "/")
    .replace(/\.qnt$/, "");
  const [firstCrash, secondCrash, verified, refused] = checkpoints;
  const ownership = ({ ownedScratchBytes }) =>
    ownedScratchBytes > 0 ? "owned" : "none";
  const wrapper = path.join(out, "ScratchSourceConformance.qnt");
  await writeFile(
    wrapper,
    `module ScratchSourceConformance {
    import SystemUpdateHost as M from ${JSON.stringify(importPath)}
    run sourceScratchRecoveryTest = M::init.then(M::start).then(M::download)
      .then(M::writeScratch).then(M::crash)
      .expect(M::s.scratch == "${ownership(firstCrash)}" and not(M::s.writing) and M::s.applyCalls == 0)
      .then(M::start).then(M::reclaimScratch).then(M::writeScratch).then(M::crash)
      .expect(M::s.scratch == "${ownership(secondCrash)}" and not(M::s.writing) and M::s.applyCalls == 0)
      .then(M::start).then(M::reclaimScratch).then(M::writeScratch).then(M::verify)
      .expect(M::s.scratch == "${ownership(verified)}" and M::s.phase == "${verified.stage}" and M::s.applyCalls == 0)
    run sourceScratchRefusalTest = M::foreignScratchInit.then(M::start).then(M::download).then(M::refuseScratch)
      .expect((M::s.scratch == "foreign") == ${refused.foreignBytesPreserved} and M::s.phase == "downloading" and not(M::s.active) and M::s.applyCalls == 0)
  }\n`,
  );
  const replay = run(process.execPath, [
    cli,
    "test",
    wrapper,
    "--main=ScratchSourceConformance",
    "--backend=typescript",
    "--match=^sourceScratch.*Test$",
    "--verbosity=1",
  ]);
  assert.match(replay, /\b2 passing/);
  assert.deepEqual(await readSources(), sourceHashes);
  await writeFile(
    path.join(out, "scratch-observations.json"),
    `${JSON.stringify(
      {
        schema: "eliza-system-update-scratch-trace/v1",
        sourceHashes,
        checkpoints,
        scope:
          "Exact Java extraction and scratch filesystem methods in separate host processes. Android trust, full job execution, reboot-ready extraction and power-loss durability are not exercised.",
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`PASS scratch restart, publish and refusal: ${out}\n`);
}

async function checkHeldVerification({
  tool,
  portFiles,
  runner,
  model,
  javaSources,
  heldBefore,
}) {
  const fixture =
    "packages/os/android/system-updater/test/ai/eliza/systemupdater/HeldVerificationReplay.java";
  const read = async (file) =>
    heldBefore
      ? run("git", ["show", `${heldBefore}:${file}`])
      : await readFile(path.join(root, file), "utf8");
  const runnerSource = await read(runner);
  const engine = `${javaSources}/EngineInstaller.java`;
  const verifier = `${javaSources}/PackageVerifier.java`;
  const journal = `${javaSources}/UpdateJournal.java`;
  const payload = `${javaSources}/VerifiedPayload.java`;
  const production = [runner, engine, verifier, journal, payload];
  const harness = [
    fixture,
    model,
    "packages/os/quint/SystemUpdateHost.cases.json",
    "packages/os/quint/check-system-update.mjs",
  ];
  const readSources = async () =>
    Object.fromEntries(
      await Promise.all(
        [...production, ...harness].map(async (file) => [
          file,
          createHash("sha256")
            .update(
              production.includes(file)
                ? await read(file)
                : await readFile(path.join(root, file)),
            )
            .digest("hex"),
        ]),
      ),
    );
  const sourceHashes = await readSources();
  const verifierSource = await read(verifier);
  const start = runnerSource.indexOf(
    "            if (!current.targetBuild.equals(candidate.fingerprint)",
  );
  const end = runnerSource.indexOf(
    "            if (current.phase != UpdateJournal.Phase.VERIFIED",
    start,
  );
  assert.ok(
    start >= 0 && end > start,
    "Missing exact verification and reboot branch",
  );
  const dispatch = runnerSource.slice(start, end);
  assert.match(
    dispatch,
    /PackageVerifier\.verify\([\s\S]*if \(current\.phase == UpdateJournal\.Phase\.REBOOT_READY\) \{\s+rebootIfAllowed\(run, store, channel, candidate\); return;/,
  );
  const runnerMethods = [
    "private void rebootIfAllowed(",
    "private static boolean same(",
    "private void failure(",
    "private synchronized void finish(",
  ]
    .map((signature) => member(runnerSource, signature))
    .join("\n");
  const trustPath = 'new ZipFile("/system/etc/security/otacerts.zip")';
  assert.ok(verifierSource.includes(trustPath));
  const compiled = {
    "UpdateRunner.java": `package ai.eliza.systemupdater;
import java.io.*;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import static ai.eliza.systemupdater.HeldVerificationReplay.*;
final class UpdateRunner {
    final Context context;
    final Handler main = new Handler(Looper.getMainLooper());
    Run active;
    UpdateRunner(Context context) { this.context = context; }
    static void status(Context context, String message) { context.status = message; }
    boolean installAllowed() { return context.eligible; }
    void replay(JournalStore store, UpdateChannel channel, UpdateChannel.Candidate candidate) {
        Run run = active = new Run(context);
        File directory = context.getFilesDir();
        UpdateJournal current = store.read();
        try {
${dispatch}
            throw new AssertionError("Held candidate reached apply dispatch");
        } catch (Exception failure) { failure(run, failure); }
    }
${runnerMethods}
}
`,
    "EngineInstaller.java": `package ai.eliza.systemupdater;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import static ai.eliza.systemupdater.HeldVerificationReplay.*;
final class EngineInstaller {
${member(await read(engine), "static int observeStatus(")}
}
`,
    "PackageVerifier.java": verifierSource.replace(
      trustPath,
      'new ZipFile(System.getProperty("fixture.otacerts"))',
    ),
    "UpdateJournal.java": await read(journal),
    "VerifiedPayload.java": await read(payload),
    "android/os/RecoverySystem.java": `package android.os;
public final class RecoverySystem { public static void verifyPackage(java.io.File file, Object a, Object b) { } }`,
  };
  const classes = path.join(out, "held-classes");
  await mkdir(classes);
  const files = [];
  for (const [name, source] of Object.entries(compiled)) {
    const file = path.join(out, "held-source", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, source);
    files.push(file);
  }
  const key = path.join(out, "held-fixture.p12"),
    cert = path.join(out, "held-fixture.x509");
  run(tool("keytool"), [
    "-genkeypair",
    "-alias",
    "fixture",
    "-keyalg",
    "RSA",
    "-storetype",
    "PKCS12",
    "-keystore",
    key,
    "-storepass",
    "fixture-pass",
    "-dname",
    "CN=Fixture",
    "-validity",
    "2",
    "-noprompt",
  ]);
  run(tool("keytool"), [
    "-exportcert",
    "-alias",
    "fixture",
    "-keystore",
    key,
    "-storepass",
    "fixture-pass",
    "-file",
    cert,
  ]);
  await rm(key);
  run(tool("javac"), [
    "--release",
    "17",
    "-d",
    classes,
    ...files,
    ...portFiles.filter((file) => !file.endsWith("/RecoverySystem.java")),
    fixture,
  ]);
  const data = path.join(out, "held-fixtures");
  await mkdir(data);
  const actual = run(tool("java"), [
    "-cp",
    classes,
    "ai.eliza.systemupdater.HeldVerificationReplay",
    data,
    cert,
    heldBefore ? "before" : "after",
  ]);
  process.stdout.write(actual);
  const results = actual.trim().split("\n");
  if (heldBefore) {
    assert.deepEqual(results, [
      "before: missing payload was recreated before engine status",
    ]);
  } else {
    assert.deepEqual(results, [
      "missing REBOOT_READY 0 0",
      "invalid REBOOT_READY 0 0",
      "symlink REBOOT_READY 0 0",
      "missing-archive REBOOT_READY 0 0",
      "changed REBOOT_READY 0 0",
      "ineligible REBOOT_READY 0 0",
      "engine-idle REBOOT_READY 1 0",
      "ready REBOOT_INTENT 1 1",
    ]);
    const importPath = path
      .relative(out, path.join(root, model))
      .replaceAll(path.sep, "/")
      .replace(/\.qnt$/, "");
    const wrapper = path.join(out, "HeldSourceConformance.qnt");
    await writeFile(
      wrapper,
      `module HeldSourceConformance {
      import SystemUpdateHost as M from ${JSON.stringify(importPath)}
      action prepared = M::init.then(M::start).then(M::download).then(M::verify).then(M::apply).then(M::callback).then(M::start)
      run sourceMissingHeldTest = prepared.then(M::checkHeld(false))
        .expect(M::s.phase == "ready" and M::s.reboots == ${Number(results[0].at(-1))} and not(M::s.writing))
      run sourceEngineIdleTest = prepared.then(M::checkHeld(true)).then(M::holdEngine)
        .expect(M::s.phase == "ready" and M::s.reboots == ${Number(results[6].at(-1))})
      run sourceReadyHeldTest = prepared.then(M::checkHeld(true)).then(M::reboot)
        .expect(M::s.phase == "reboot-intent" and M::s.reboots == ${Number(results[7].at(-1))})
    }\n`,
    );
    const replay = run(process.execPath, [
      cli,
      "test",
      wrapper,
      "--main=HeldSourceConformance",
      "--backend=typescript",
      "--match=^source.*Test$",
      "--verbosity=1",
    ]);
    assert.match(replay, /\b3 passing/);
    process.stdout.write(replay);
  }
  assert.deepEqual(await readSources(), sourceHashes);
  await writeFile(
    path.join(out, "held-observations.json"),
    `${JSON.stringify(
      {
        beforeCommit: heldBefore ?? null,
        sourceHashes,
        results,
        scope:
          "Exact source verification, reboot admission and engine status methods. Real temporary files, fixture trust store, controlled Android service ports and headroom.",
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`PASS held verification: ${out}\n`);
}

const storageBefore = process.argv[2] === "--storage-before";
const scratchOnly = process.argv[2] === "--scratch-only";
const beforeHeld = process.argv[2] === "--held-before";
const heldOnly = process.argv[2] === "--held-only" || beforeHeld;
const heldBefore = beforeHeld ? process.argv[3] : undefined;
const hostModel = process.argv[2]?.endsWith("/SystemUpdateHost.qnt");
if (storageBefore || hostModel) {
  if (storageBefore) assert.match(process.argv[3], /^[0-9a-f]{40}$/);
  await checkStorage(storageBefore ? process.argv[3] : undefined);
}
if (beforeHeld) assert.match(heldBefore, /^[0-9a-f]{40}$/);
if (hostModel || scratchOnly || heldOnly)
  await checkScratch({ includeHeld: hostModel, heldOnly, heldBefore });
if (storageBefore || hostModel || scratchOnly || heldOnly) {
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
