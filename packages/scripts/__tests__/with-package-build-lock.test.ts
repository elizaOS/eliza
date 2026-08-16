/**
 * Exercises package build-lock ownership with real wrapper and child
 * processes, including contention, stale recovery, and spawn failures.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type ChildProcessWithoutNullStreams,
  spawn,
  spawnSync,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const WRAPPER = path.resolve(SCRIPT_DIR, "../with-package-build-lock.mjs");
const LOCK_ROOT = path.join(REPO_ROOT, ".turbo", "build-locks");
const NODE_BIN = "node";
const cleanupPaths = new Set<string>();

function uniquePackageKey(label: string): string {
  return `packages/scripts/__lock-test-${label}-${randomUUID()}`;
}

function lockPathFor(packageKey: string): string {
  const relative = path.relative(
    REPO_ROOT,
    path.resolve(REPO_ROOT, packageKey),
  );
  const lockName = relative
    .replaceAll(path.sep, "__")
    .replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  const lockPath = path.join(LOCK_ROOT, lockName);
  cleanupPaths.add(lockPath);
  return lockPath;
}

function runWrapper(
  packageKey: string,
  command: string[],
  staleMs: string | null = "1000",
  timeout = 15_000,
) {
  const env = { ...process.env };
  if (staleMs === null) {
    delete env.ELIZA_PACKAGE_BUILD_LOCK_STALE_MS;
  } else {
    env.ELIZA_PACKAGE_BUILD_LOCK_STALE_MS = staleMs;
  }
  return spawnSync(NODE_BIN, [WRAPPER, packageKey, "--", ...command], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
    timeout,
  });
}

function spawnWrapper(
  packageKey: string,
  command: string[],
  staleMs = "1000",
  envOverrides: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  return spawn(NODE_BIN, [WRAPPER, packageKey, "--", ...command], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ELIZA_PACKAGE_BUILD_LOCK_STALE_MS: staleMs,
      ...envOverrides,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function collect(child: ChildProcessWithoutNullStreams) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
}

async function waitForPath(target: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(target)) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${target}`);
    await Bun.sleep(10);
  }
}

async function waitForFileContent(
  target: string,
  expected: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      if (readFileSync(target, "utf8") === expected) return;
    } catch (error) {
      // error-policy:J3 a missing file remains an explicit not-ready state.
      if (error?.code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for expected content at ${target}`);
    await Bun.sleep(10);
  }
}

afterEach(() => {
  for (const target of cleanupPaths) {
    rmSync(target, { recursive: true, force: true });
    if (!existsSync(path.dirname(target))) continue;
    for (const candidate of new Bun.Glob(`${path.basename(target)}.*`).scanSync(
      {
        cwd: path.dirname(target),
        absolute: true,
      },
    )) {
      rmSync(candidate, { recursive: true, force: true });
    }
  }
  cleanupPaths.clear();
});

describe("with-package-build-lock", () => {
  test("rejects malformed stale thresholds before acquiring a lock", () => {
    for (const value of [
      "",
      " ",
      "\t",
      "0",
      "-1",
      "+1",
      "1.5",
      "1e3",
      "1junk",
      " 1",
      "1 ",
      "NaN",
      "Infinity",
      "9007199254740992",
    ]) {
      const packageKey = uniquePackageKey("invalid-threshold");
      const lockPath = lockPathFor(packageKey);
      const result = runWrapper(packageKey, [NODE_BIN, "-e", "0"], value);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "ELIZA_PACKAGE_BUILD_LOCK_STALE_MS must be a positive decimal safe integer",
      );
      expect(result.stderr).not.toContain("at parseStaleAfterMs");
      expect(existsSync(lockPath)).toBe(false);
    }
  });

  test("accepts the unset default and complete positive safe integers", () => {
    for (const value of [null, "1", "1800000", "9007199254740991"] as const) {
      const packageKey = uniquePackageKey("valid-threshold");
      const lockPath = lockPathFor(packageKey);
      const result = runWrapper(
        packageKey,
        [NODE_BIN, "-e", "process.stdout.write('acquired')"],
        value,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("acquired");
      expect(result.stderr).toBe("");
      expect(existsSync(lockPath)).toBe(false);
    }
  });

  test("rejects workspace-root and escaping package keys without touching other locks", () => {
    mkdirSync(LOCK_ROOT, { recursive: true });
    const sentinel = path.join(LOCK_ROOT, `sentinel-${randomUUID()}`);
    cleanupPaths.add(sentinel);
    writeFileSync(sentinel, "owned elsewhere");

    for (const packageKey of [".", "..", "../outside-eliza"]) {
      const result = runWrapper(packageKey, [NODE_BIN, "-e", "0"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "package-dir must resolve below the workspace root",
      );
      expect(readFileSync(sentinel, "utf8")).toBe("owned elsewhere");
    }
  });

  test("keeps a live owner exclusive after the stale-age threshold", async () => {
    const packageKey = uniquePackageKey("live-owner");
    lockPathFor(packageKey);
    const evidenceDir = mkdtempSync(path.join(tmpdir(), "eliza-lock-live-"));
    cleanupPaths.add(evidenceDir);
    const readyPath = path.join(evidenceDir, "ready");
    const donePath = path.join(evidenceDir, "done");
    const observationPath = path.join(evidenceDir, "second");

    const first = spawnWrapper(
      packageKey,
      [
        NODE_BIN,
        "-e",
        `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(readyPath)},"ready");setTimeout(()=>fs.writeFileSync(${JSON.stringify(donePath)},"done"),500);`,
      ],
      "50",
    );
    const firstResult = collect(first);
    await waitForPath(readyPath);
    await Bun.sleep(120);

    const second = spawnWrapper(
      packageKey,
      [
        NODE_BIN,
        "-e",
        `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(observationPath)},fs.existsSync(${JSON.stringify(donePath)})?"after":"overlap");`,
      ],
      "50",
    );
    const [firstOutcome, secondOutcome] = await Promise.all([
      firstResult,
      collect(second),
    ]);

    expect(firstOutcome.code).toBe(0);
    expect(secondOutcome.code).toBe(0);
    expect(readFileSync(observationPath, "utf8")).toBe("after");
  });

  test("serializes simultaneous takeovers of a directory-style dead-owner lock", async () => {
    const packageKey = uniquePackageKey("dead-race");
    const lockPath = lockPathFor(packageKey);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      path.join(lockPath, "metadata.json"),
      `${JSON.stringify({ pid: 2_147_483_647, ownerId: "dead", createdAt: new Date().toISOString() })}\n`,
    );
    const evidenceDir = mkdtempSync(path.join(tmpdir(), "eliza-lock-race-"));
    cleanupPaths.add(evidenceDir);
    const activePath = path.join(evidenceDir, "active");
    const overlapPath = path.join(evidenceDir, "overlap");
    const childCode = `const fs=require("node:fs");const active=${JSON.stringify(activePath)};const overlap=${JSON.stringify(overlapPath)};if(fs.existsSync(active))fs.writeFileSync(overlap,"overlap");fs.writeFileSync(active,String(process.pid));setTimeout(()=>fs.rmSync(active,{force:true}),250);`;

    const left = spawnWrapper(packageKey, [NODE_BIN, "-e", childCode]);
    const right = spawnWrapper(packageKey, [NODE_BIN, "-e", childCode]);
    const outcomes = await Promise.all([collect(left), collect(right)]);

    expect(outcomes.map((outcome) => outcome.code)).toEqual([0, 0]);
    expect(existsSync(overlapPath)).toBe(false);
  });

  test("preserves a live replacement installed before atomic stale takeover", async () => {
    const packageKey = uniquePackageKey("replacement-barrier");
    const lockPath = lockPathFor(packageKey);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 2_147_483_647, ownerId: "dead", createdAt: new Date().toISOString() })}\n`,
    );
    const evidenceDir = mkdtempSync(path.join(tmpdir(), "eliza-lock-barrier-"));
    cleanupPaths.add(evidenceDir);
    const readyPath = path.join(evidenceDir, "rename-ready");
    const releasePath = path.join(evidenceDir, "rename-release");
    const renamedPath = path.join(evidenceDir, "rename-complete");
    const preloadPath = path.join(evidenceDir, "rename-barrier.mjs");
    writeFileSync(
      preloadPath,
      `import fs from "node:fs/promises";\nconst originalRename=fs.rename.bind(fs);\nfs.rename=async(source,destination)=>{const isTarget=source===process.env.ELIZA_BUILD_LOCK_TEST_TARGET;if(isTarget){await fs.writeFile(process.env.ELIZA_BUILD_LOCK_TEST_READY,"ready");while(true){try{await fs.access(process.env.ELIZA_BUILD_LOCK_TEST_RELEASE);break;}catch(error){/* error-policy:J3 a missing release marker remains an explicit blocked state. */if(error?.code!=="ENOENT")throw error;}await new Promise(resolve=>setTimeout(resolve,5));}}const result=await originalRename(source,destination);if(isTarget)await fs.writeFile(process.env.ELIZA_BUILD_LOCK_TEST_RENAMED,"renamed");return result;};\n`,
    );

    const contender = spawnWrapper(
      packageKey,
      [NODE_BIN, "-e", "process.exit(0)"],
      "1",
      {
        NODE_OPTIONS: `--import=${preloadPath}`,
        ELIZA_BUILD_LOCK_TEST_TARGET: lockPath,
        ELIZA_BUILD_LOCK_TEST_READY: readyPath,
        ELIZA_BUILD_LOCK_TEST_RELEASE: releasePath,
        ELIZA_BUILD_LOCK_TEST_RENAMED: renamedPath,
      },
    );
    const contenderResult = collect(contender);
    await waitForPath(readyPath);

    const replacementId = randomUUID();
    const replacement = `${JSON.stringify({
      pid: process.pid,
      ownerId: replacementId,
      createdAt: new Date().toISOString(),
    })}\n`;
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, replacement, { flag: "wx" });
    writeFileSync(releasePath, "release");

    await waitForPath(renamedPath);
    await waitForFileContent(lockPath, replacement);
    expect(readFileSync(lockPath, "utf8")).toBe(replacement);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).ownerId).toBe(
      replacementId,
    );

    contender.kill("SIGTERM");
    const outcome = await contenderResult;
    expect(outcome.code).not.toBe(0);
    expect(readFileSync(lockPath, "utf8")).toBe(replacement);
  });

  test("waits for the age bound before reclaiming incomplete metadata", () => {
    const packageKey = uniquePackageKey("incomplete");
    const lockPath = lockPathFor(packageKey);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "");
    const now = new Date();
    utimesSync(lockPath, now, now);

    const startedAt = Date.now();
    const result = runWrapper(
      packageKey,
      [NODE_BIN, "-e", "process.stdout.write('acquired')"],
      "300",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("acquired");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("releases the lock after a command-start failure", () => {
    const packageKey = uniquePackageKey("spawn-error");
    const lockPath = lockPathFor(packageKey);
    const failure = runWrapper(packageKey, [
      "definitely-not-an-eliza-command-build-lock-test",
    ]);

    if (process.platform === "win32") {
      expect(failure.status).not.toBe(0);
    } else {
      expect(failure.status).toBe(127);
      expect(failure.stderr).toContain("Failed to start command");
      expect(failure.stderr).not.toContain("Unhandled 'error' event");
    }
    expect(existsSync(lockPath)).toBe(false);

    const recovery = runWrapper(packageKey, [
      NODE_BIN,
      "-e",
      "process.exit(0)",
    ]);
    expect(recovery.status).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("keeps a third contender out while a paused takeover holds the mutex (#20265)", async () => {
    // The review-reproduced interleaving on #19356: stale contender A pauses
    // immediately before its quarantine rename, live peer B replaces the
    // stale lock and starts its command, A's resumed rename then moves B's
    // LIVE lock and empties the canonical path, and a third contender C wins
    // open(lockPath, "wx") while B is still active. With every canonical-path
    // mutation holding the kernel-arbitrated mutex, B and C must instead wait
    // out A's pause, and no two commands may ever overlap.
    const packageKey = uniquePackageKey("three-party");
    const lockPath = lockPathFor(packageKey);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 2_147_483_647, ownerId: "dead", createdAt: new Date().toISOString() })}\n`,
    );
    const evidenceDir = mkdtempSync(path.join(tmpdir(), "eliza-lock-three-"));
    cleanupPaths.add(evidenceDir);
    const readyPath = path.join(evidenceDir, "rename-ready");
    const releasePath = path.join(evidenceDir, "rename-release");
    const readyAfterPath = path.join(evidenceDir, "rename-ready-after");
    const releaseAfterPath = path.join(evidenceDir, "rename-release-after");
    const preloadPath = path.join(evidenceDir, "rename-barrier.mjs");
    const activePath = path.join(evidenceDir, "active");
    const overlapPath = path.join(evidenceDir, "overlap");
    // Two-stage barrier: pause immediately before AND immediately after the
    // wrapper's actual fs.rename, matching the interleaving reproduced in the
    // #19356 review. Marker files persist, so later renames pass straight
    // through both stages.
    writeFileSync(
      preloadPath,
      `import fs from "node:fs/promises";\nconst originalRename=fs.rename.bind(fs);\nconst pause=async(ready,release)=>{await fs.writeFile(ready,"ready");while(true){try{await fs.access(release);break;}catch(error){/* error-policy:J3 a missing release marker remains an explicit blocked state. */if(error?.code!=="ENOENT")throw error;}await new Promise(resolve=>setTimeout(resolve,5));}};\nfs.rename=async(source,destination)=>{if(source===process.env.ELIZA_BUILD_LOCK_TEST_TARGET){await pause(process.env.ELIZA_BUILD_LOCK_TEST_READY,process.env.ELIZA_BUILD_LOCK_TEST_RELEASE);const result=await originalRename(source,destination);await pause(process.env.ELIZA_BUILD_LOCK_TEST_READY_AFTER,process.env.ELIZA_BUILD_LOCK_TEST_RELEASE_AFTER);return result;}return originalRename(source,destination);};\n`,
    );
    const childCode = `const fs=require("node:fs");const active=${JSON.stringify(activePath)};const overlap=${JSON.stringify(overlapPath)};if(fs.existsSync(active))fs.writeFileSync(overlap,"overlap");fs.writeFileSync(active,String(process.pid));setTimeout(()=>fs.rmSync(active,{force:true}),800);`;

    const pausedTakeover = spawnWrapper(
      packageKey,
      [NODE_BIN, "-e", childCode],
      "1",
      {
        NODE_OPTIONS: `--import=${preloadPath}`,
        ELIZA_BUILD_LOCK_TEST_TARGET: lockPath,
        ELIZA_BUILD_LOCK_TEST_READY: readyPath,
        ELIZA_BUILD_LOCK_TEST_RELEASE: releasePath,
        ELIZA_BUILD_LOCK_TEST_READY_AFTER: readyAfterPath,
        ELIZA_BUILD_LOCK_TEST_RELEASE_AFTER: releaseAfterPath,
      },
    );
    const pausedResult = collect(pausedTakeover);
    await waitForPath(readyPath);

    // A is paused before its rename. Under the mutex protocol B must wait out
    // the pause; under the broken protocol B completes its own takeover and
    // is mid-command when A's resumed rename moves B's live lock away.
    const livePeer = spawnWrapper(packageKey, [NODE_BIN, "-e", childCode], "1");
    const livePeerResult = collect(livePeer);
    await Bun.sleep(250);
    writeFileSync(releasePath, "release");
    await waitForPath(readyAfterPath);

    // A is now frozen between its rename and its validate/restore step. With
    // the mutex, C just queues; without it, C wins open(lockPath, "wx") on
    // the emptied canonical path while B's command is still active, and A's
    // later restoration hits EEXIST and strands B in quarantine.
    const thirdContender = spawnWrapper(
      packageKey,
      [NODE_BIN, "-e", childCode],
      "1",
    );
    await Bun.sleep(250);
    writeFileSync(releaseAfterPath, "release");

    const [pausedOutcome, peerOutcome, thirdOutcome] = await Promise.all([
      pausedResult,
      livePeerResult,
      collect(thirdContender),
    ]);

    expect(pausedOutcome.code).toBe(0);
    expect(pausedOutcome.stderr).toBe("");
    expect(peerOutcome.code).toBe(0);
    expect(thirdOutcome.code).toBe(0);
    expect(existsSync(overlapPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  }, 20_000);

  test("an old owner cleanup preserves a replacement lock", () => {
    const packageKey = uniquePackageKey("replacement");
    const lockPath = lockPathFor(packageKey);
    const replacementId = randomUUID();
    const childCode = `const fs=require("node:fs");const target=${JSON.stringify(lockPath)};fs.rmSync(target,{recursive:true,force:true});fs.writeFileSync(target,JSON.stringify({pid:process.pid,ownerId:${JSON.stringify(replacementId)},createdAt:new Date().toISOString()}));`;

    const result = runWrapper(packageKey, [NODE_BIN, "-e", childCode]);

    expect(result.status).toBe(0);
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).ownerId).toBe(
      replacementId,
    );
  });
});
