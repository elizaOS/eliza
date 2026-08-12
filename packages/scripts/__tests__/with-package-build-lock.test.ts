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
const NODE_BIN = process.execPath;
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
  staleMs = "1000",
  timeout = 15_000,
) {
  return spawnSync(NODE_BIN, [WRAPPER, packageKey, "--", ...command], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ELIZA_PACKAGE_BUILD_LOCK_STALE_MS: staleMs,
    },
    timeout,
  });
}

function spawnWrapper(
  packageKey: string,
  command: string[],
  staleMs = "1000",
): ChildProcessWithoutNullStreams {
  return spawn(NODE_BIN, [WRAPPER, packageKey, "--", ...command], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ELIZA_PACKAGE_BUILD_LOCK_STALE_MS: staleMs,
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

afterEach(() => {
  for (const target of cleanupPaths) {
    rmSync(target, { recursive: true, force: true });
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
      "0",
      "-1",
      "+1",
      "1.5",
      "1junk",
      " 1",
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

  test("serializes simultaneous takeovers of one dead-owner lock", async () => {
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
