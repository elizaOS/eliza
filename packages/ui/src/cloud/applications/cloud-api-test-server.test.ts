/**
 * Unit tests for the cloud API test-server launcher. The suite drives the real
 * spawn/handshake behaviour with throwaway bun fixture scripts staged in a
 * temporary repo root (no network server needed): parse success, split and
 * oversized stdout chunks, first-match precedence, forced env/cwd injection,
 * timeout rejection, exit-before-listening, and spawn failure.
 */
import type { ChildProcess } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCloudApiTestServer } from "./__e2e__/cloud-api-test-server.ts";

const DEV_SCRIPT_RELPATH = join(
  "packages",
  "cloud",
  "scripts",
  "admin",
  "dev",
  "cloud-api-hono-dev.ts",
);

const KEEP_ALIVE = "setInterval(() => {}, 10_000);";

// A fixture that never reports listening must not outlive the test even when
// the launcher rejects and the handle stays private to it.
const SILENT_WITH_WATCHDOG = [
  KEEP_ALIVE,
  "setTimeout(() => process.exit(0), 30_000);",
].join("\n");

const createdRepoRoots: string[] = [];
const spawnedChildren: ChildProcess[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const child of spawnedChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  await Promise.all(
    createdRepoRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function stageFixture(script: string): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "cloud-api-test-server-"));
  const scriptPath = join(repoRoot, DEV_SCRIPT_RELPATH);
  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, script);
  createdRepoRoots.push(repoRoot);
  return repoRoot;
}

function track(child: ChildProcess): ChildProcess {
  spawnedChildren.push(child);
  return child;
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (exited(child)) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}

describe("startCloudApiTestServer", () => {
  it("resolves with the advertised base URL and a live child once the listening line appears", async () => {
    const repoRoot = await stageFixture(
      [
        'console.log("[cloud-api-hono-dev] listening on http://127.0.0.1:46311");',
        KEEP_ALIVE,
      ].join("\n"),
    );

    const { child, baseUrl } = await startCloudApiTestServer({
      repoRoot,
      env: process.env,
    });
    track(child);

    expect(baseUrl).toBe("http://127.0.0.1:46311");
    expect(typeof child.pid).toBe("number");
    expect(exited(child)).toBe(false);

    child.kill("SIGTERM");
    await waitForExit(child);
  }, 20_000);

  it("spawns the dev script inside repoRoot and forces API_DEV_HOST/API_DEV_PORT while forwarding the caller env", async () => {
    const repoRoot = await stageFixture(
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(new URL("./probe.json", import.meta.url), JSON.stringify({ host: process.env.API_DEV_HOST, port: process.env.API_DEV_PORT, marker: process.env.PROBE_MARKER, cwd: process.cwd() }));',
        'console.log("[cloud-api-hono-dev] listening on http://127.0.0.1:46312");',
        KEEP_ALIVE,
      ].join("\n"),
    );

    const { child, baseUrl } = await startCloudApiTestServer({
      repoRoot,
      env: { ...process.env, PROBE_MARKER: "caller-env-passthrough" },
    });
    track(child);

    try {
      expect(baseUrl).toBe("http://127.0.0.1:46312");
      const probe = JSON.parse(
        await readFile(
          join(repoRoot, DEV_SCRIPT_RELPATH, "../probe.json"),
          "utf8",
        ),
      ) as { host: string; port: string; marker: string; cwd: string };
      expect(probe.host).toBe("127.0.0.1");
      expect(probe.port).toBe("0");
      expect(probe.marker).toBe("caller-env-passthrough");
      expect(probe.cwd).toBe(await realpath(repoRoot));
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  }, 20_000);

  it("reassembles the listening line when it arrives split across separate stdout chunks", async () => {
    const repoRoot = await stageFixture(
      [
        'process.stdout.write("[cloud-api-ho");',
        'setTimeout(() => { process.stdout.write("no-dev] listening on http://127.0.0.1:46313\\n"); }, 200);',
        KEEP_ALIVE,
      ].join("\n"),
    );

    const { child, baseUrl } = await startCloudApiTestServer({
      repoRoot,
      env: process.env,
    });
    track(child);

    try {
      expect(baseUrl).toBe("http://127.0.0.1:46313");
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  }, 20_000);

  it("still finds the listening line after more than 8 KiB of earlier output", async () => {
    const repoRoot = await stageFixture(
      [
        'process.stdout.write("#".repeat(9_000) + "\\n");',
        'console.log("[cloud-api-hono-dev] listening on http://127.0.0.1:46314");',
        KEEP_ALIVE,
      ].join("\n"),
    );

    const { child, baseUrl } = await startCloudApiTestServer({
      repoRoot,
      env: process.env,
    });
    track(child);

    try {
      expect(baseUrl).toBe("http://127.0.0.1:46314");
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  }, 20_000);

  it("settles on the first advertised address and ignores later duplicates", async () => {
    const repoRoot = await stageFixture(
      [
        'console.log("[cloud-api-hono-dev] listening on http://127.0.0.1:46315");',
        'console.log("[cloud-api-hono-dev] listening on http://127.0.0.1:46316");',
        KEEP_ALIVE,
      ].join("\n"),
    );

    const { child, baseUrl } = await startCloudApiTestServer({
      repoRoot,
      env: process.env,
    });
    track(child);

    try {
      expect(baseUrl).toBe("http://127.0.0.1:46315");
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  }, 20_000);

  it("rejects with the timeout message when no listening line is reported in time", async () => {
    const repoRoot = await stageFixture(SILENT_WITH_WATCHDOG);

    await expect(
      startCloudApiTestServer({
        repoRoot,
        env: process.env,
        timeoutMs: 500,
      }),
    ).rejects.toThrow(
      "cloud-api-hono-dev did not report its listening address within 500ms",
    );
  }, 20_000);

  it("uses the default 120 second budget when timeoutMs is omitted", async () => {
    const repoRoot = await stageFixture(SILENT_WITH_WATCHDOG);

    vi.useFakeTimers();
    const pending = startCloudApiTestServer({ repoRoot, env: process.env });
    const outcome = expect(pending).rejects.toThrow(
      "cloud-api-hono-dev did not report its listening address within 120000ms",
    );
    await vi.advanceTimersByTimeAsync(120_000);
    await outcome;
  }, 20_000);

  it("reports the exit code when the dev server exits before listening", async () => {
    const repoRoot = await stageFixture("process.exit(3);");

    await expect(
      startCloudApiTestServer({ repoRoot, env: process.env }),
    ).rejects.toThrow(
      "cloud-api-hono-dev exited before listening (code 3, signal null)",
    );
  }, 20_000);

  it("reports the signal when the dev server is killed before listening", async () => {
    const repoRoot = await stageFixture(
      "process.kill(process.pid, 'SIGKILL');",
    );

    await expect(
      startCloudApiTestServer({ repoRoot, env: process.env }),
    ).rejects.toThrow(
      "cloud-api-hono-dev exited before listening (code null, signal SIGKILL)",
    );
  }, 20_000);

  it("propagates the spawn error when bun cannot be resolved", async () => {
    const repoRoot = await stageFixture(SILENT_WITH_WATCHDOG);

    let caught: unknown;
    try {
      await startCloudApiTestServer({
        repoRoot,
        env: {},
        timeoutMs: 5_000,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as NodeJS.ErrnoException).code).toBe("ENOENT");
  }, 20_000);
});
