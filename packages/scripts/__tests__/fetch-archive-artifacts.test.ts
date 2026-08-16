/**
 * Guards the opt-in archive artifact fetch contract through the real CLI
 * process: the root install lifecycle must never invoke an archive pull,
 * the script must refuse lifecycle hooks and fail closed on download
 * problems, and extraction must never overwrite git-tracked files. Uses a
 * real git fixture repository and a real local HTTP server — no mocks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(SCRIPTS_DIR, "..", "fetch-archive-artifacts.mjs");
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..", "..", "..");
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function runScript(env: Record<string, string | undefined>) {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  delete merged.npm_lifecycle_event;
  if (env.npm_lifecycle_event !== undefined) {
    merged.npm_lifecycle_event = env.npm_lifecycle_event;
  }
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: merged,
  });
}

describe("root install lifecycle contract", () => {
  test("no lifecycle script pulls the archive bundle", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const lifecycleScripts = [
      "preinstall",
      "install",
      "postinstall",
      "prepare",
      "prepublish",
      "prepublishOnly",
    ];
    for (const name of lifecycleScripts) {
      const command = manifest.scripts[name] ?? "";
      expect(command).not.toContain("sync-artifacts");
      expect(command).not.toContain("fetch-archive-artifacts");
      expect(command).not.toContain("eliza-archive");
    }
    // The retired implicit-sync surface must stay retired.
    expect(manifest.scripts["sync:artifacts"]).toBeUndefined();
    expect(
      existsSync(path.join(REPO_ROOT, "packages/scripts/sync-artifacts.mjs")),
    ).toBe(false);
  });
});

describe("fetch-archive-artifacts CLI", () => {
  test("refuses to run from a package lifecycle hook", () => {
    const root = makeTempDirectory("archive-fetch-hook-");
    const result = runScript({
      ELIZA_ARCHIVE_ROOT: root,
      npm_lifecycle_event: "postinstall",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'refusing to run from package lifecycle hook "postinstall"',
    );
  });

  test("fails closed with a non-zero exit when the download is unavailable", () => {
    const root = makeTempDirectory("archive-fetch-download-");
    const temp = makeTempDirectory("archive-fetch-tmp-");
    const result = runScript({
      ELIZA_ARCHIVE_ROOT: root,
      ELIZA_ARCHIVE_URL: "http://127.0.0.1:9/eliza-dev-artifacts.tar.gz",
      ELIZA_ARCHIVE_MAX_ATTEMPTS: "1",
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not download the artifact bundle");
    expect(existsSync(path.join(root, ".eliza-artifacts-version"))).toBe(false);
  });

  test("extracts only untracked members and never overwrites tracked files", async () => {
    const root = makeTempDirectory("archive-fetch-repo-");
    const temp = makeTempDirectory("archive-fetch-tmp2-");
    const payload = makeTempDirectory("archive-fetch-payload-");

    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", [
      "-C",
      root,
      "config",
      "user.email",
      "test@example.com",
    ]);
    execFileSync("git", ["-C", root, "config", "user.name", "test"]);
    writeFileSync(path.join(root, "tracked.txt"), "checkout content\n");
    execFileSync("git", ["-C", root, "add", "tracked.txt"]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"]);

    writeFileSync(path.join(payload, "tracked.txt"), "STALE ARCHIVE CONTENT\n");
    writeFileSync(path.join(payload, "untracked.bin"), "fresh fixture bytes\n");
    const bundle = path.join(payload, "bundle.tar.gz");
    execFileSync("tar", [
      "-czf",
      bundle,
      "-C",
      payload,
      "tracked.txt",
      "untracked.bin",
    ]);
    const bundleBytes = readFileSync(bundle);
    const digest = createHash("sha256").update(bundleBytes).digest("hex");

    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(bundleBytes),
    });
    try {
      // A synchronous spawn would block this process's event loop and
      // deadlock against the in-process Bun.serve fixture, so the child is
      // awaited asynchronously here.
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ELIZA_ARCHIVE_ROOT: root,
        ELIZA_ARCHIVE_URL: `http://127.0.0.1:${server.port}/bundle-${randomUUID()}.tar.gz`,
        ELIZA_ARCHIVE_SHA256: digest,
        ELIZA_ARCHIVE_MAX_ATTEMPTS: "1",
        TEMP: temp,
        TMP: temp,
        TMPDIR: temp,
      };
      delete env.npm_lifecycle_event;
      const child = Bun.spawn([process.execPath, SCRIPT], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, stderrText] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(status).toBe(0);
      expect(stderrText).toContain(
        "skipping 1 archive member(s) that would overwrite git-tracked files",
      );
      expect(readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe(
        "checkout content\n",
      );
      expect(readFileSync(path.join(root, "untracked.bin"), "utf8")).toBe(
        "fresh fixture bytes\n",
      );
      expect(existsSync(path.join(root, ".eliza-artifacts-version"))).toBe(
        true,
      );
    } finally {
      server.stop(true);
    }
  });

  test("removes only aged matching archives from the temp directory", () => {
    const root = makeTempDirectory("archive-fetch-marker-");
    const temp = makeTempDirectory("archive-fetch-clean-");
    // Marker match makes the run a no-op after the sweep, keeping it offline.
    writeFileSync(
      path.join(root, ".eliza-artifacts-version"),
      "2026-06-18.1\n",
    );
    const staleArchive = path.join(temp, "eliza-artifacts-101.tar.gz");
    const freshArchive = path.join(temp, "eliza-artifacts-202.tar.gz");
    const unrelatedArchive = path.join(temp, "other-artifacts-303.tar.gz");
    for (const file of [staleArchive, freshArchive, unrelatedArchive]) {
      writeFileSync(file, "fixture");
    }
    const agedAt = new Date(Date.now() - 7 * 60 * 60_000);
    utimesSync(staleArchive, agedAt, agedAt);
    utimesSync(unrelatedArchive, agedAt, agedAt);

    const result = runScript({
      ELIZA_ARCHIVE_ROOT: root,
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("removed 1 stale artifact temp archive");
    expect(result.stdout).toContain("artifacts already at 2026-06-18.1");
    expect(existsSync(staleArchive)).toBe(false);
    expect(existsSync(freshArchive)).toBe(true);
    expect(existsSync(unrelatedArchive)).toBe(true);
  });
});
