/**
 * Guards the opt-in archive artifact fetch contract through the real CLI
 * process: the root install lifecycle must never invoke an archive pull,
 * the script must refuse lifecycle hooks and fail closed on download,
 * digest, and unsafe-member problems, extraction must never overwrite
 * git-tracked files, and every failure path must sweep the temp archive.
 * Uses a real git fixture repository, a real local HTTP server, and
 * hand-built tar bundles for adversarial member names — no mocks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
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

function leakedTempArchives(temp: string): string[] {
  return readdirSync(temp).filter((entry) =>
    /^eliza-artifacts-\d+\.tar\.gz$/.test(entry),
  );
}

/**
 * Builds a gzipped POSIX ustar archive by hand so member names tar itself
 * refuses to create (option-like, `..` traversal) can be exercised.
 */
function buildTarGz(entries: Array<{ name: string; content: string }>) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content, "utf8");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "utf8");
    header.write("0000000\0", 108, 8, "utf8");
    header.write("0000000\0", 116, 8, "utf8");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    header.write("00000000000\0", 136, 12, "utf8");
    header.fill(" ", 148, 156);
    header.write("0", 156, 1, "utf8");
    header.write("ustar\0", 257, 6, "utf8");
    header.write("00", 263, 2, "utf8");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    const padding = (512 - (data.length % 512)) % 512;
    blocks.push(header, data, Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.from(Bun.gzipSync(Buffer.concat(blocks)));
}

async function runScriptAgainstServer(options: {
  root: string;
  temp: string;
  bundle: Buffer | Uint8Array;
  sha256: string;
}) {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(options.bundle as BodyInit),
  });
  try {
    // A synchronous spawn would block this process's event loop and
    // deadlock against the in-process Bun.serve fixture, so the child is
    // awaited asynchronously.
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELIZA_ARCHIVE_ROOT: options.root,
      ELIZA_ARCHIVE_URL: `http://127.0.0.1:${server.port}/bundle-${randomUUID()}.tar.gz`,
      ELIZA_ARCHIVE_SHA256: options.sha256,
      ELIZA_ARCHIVE_MAX_ATTEMPTS: "1",
      TEMP: options.temp,
      TMP: options.temp,
      TMPDIR: options.temp,
    };
    delete env.npm_lifecycle_event;
    const child = Bun.spawn([process.execPath, SCRIPT], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { status, stdout, stderr };
  } finally {
    server.stop(true);
  }
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
    expect(leakedTempArchives(temp)).toEqual([]);
  });

  test("fails closed on sha256 mismatch and sweeps the temp archive", async () => {
    const root = makeTempDirectory("archive-fetch-digest-");
    const temp = makeTempDirectory("archive-fetch-digest-tmp-");
    const bundle = buildTarGz([{ name: "untracked.bin", content: "bytes\n" }]);
    const result = await runScriptAgainstServer({
      root,
      temp,
      bundle,
      sha256: "0".repeat(64),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sha256 mismatch");
    expect(existsSync(path.join(root, ".eliza-artifacts-version"))).toBe(false);
    // The digest failure must reach the boundary `finally`; an exit inside
    // the flow would leave the downloaded bundle behind in the temp dir.
    expect(leakedTempArchives(temp)).toEqual([]);
  });

  test("rejects option-like and traversal archive members without extracting", async () => {
    const root = makeTempDirectory("archive-fetch-unsafe-");
    const temp = makeTempDirectory("archive-fetch-unsafe-tmp-");
    const bundle = buildTarGz([
      { name: "--checkpoint-action=exec=touch pwned.txt", content: "evil\n" },
      { name: "../escape.txt", content: "evil\n" },
      { name: "safe.txt", content: "benign\n" },
    ]);
    const digest = createHash("sha256").update(bundle).digest("hex");
    const result = await runScriptAgainstServer({
      root,
      temp,
      bundle,
      sha256: digest,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsafe paths");
    // Nothing may be extracted when any member is unsafe — including the
    // benign member and anything an option-injected tar action could create.
    expect(existsSync(path.join(root, "safe.txt"))).toBe(false);
    expect(existsSync(path.join(root, "pwned.txt"))).toBe(false);
    expect(existsSync(path.resolve(root, "..", "escape.txt"))).toBe(false);
    expect(existsSync(path.join(root, ".eliza-artifacts-version"))).toBe(false);
    expect(leakedTempArchives(temp)).toEqual([]);
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

    const result = await runScriptAgainstServer({
      root,
      temp,
      bundle: bundleBytes,
      sha256: digest,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "skipping 1 archive member(s) that would overwrite git-tracked files",
    );
    expect(readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe(
      "checkout content\n",
    );
    expect(readFileSync(path.join(root, "untracked.bin"), "utf8")).toBe(
      "fresh fixture bytes\n",
    );
    expect(existsSync(path.join(root, ".eliza-artifacts-version"))).toBe(true);
    expect(leakedTempArchives(temp)).toEqual([]);
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
