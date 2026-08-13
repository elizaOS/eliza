/**
 * Coverage for the console's `POST /api/run` validation boundary and the
 * server entrypoint contract. The validation matrix runs against the exported
 * `validateRunRequest`; the ordering and startup suites spawn the real
 * server.mjs as a subprocess (no mocking) with the console state redirected
 * to a temp dir, so they prove what an operator's process actually does:
 * invalid concurrency is rejected before task discovery or any state-dir
 * write, and the direct Node entrypoint boots from canonical, symlinked, and
 * space-containing checkout paths.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONCURRENCY_DEFAULT,
  CONCURRENCY_MAX,
  CONCURRENCY_MIN,
  validateRunRequest,
} from "../server.mjs";

const SERVER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "server.mjs",
);

describe("validateRunRequest concurrency matrix", () => {
  test("omitted concurrency selects the default and preserves the rest", () => {
    const parsed = validateRunRequest({ mode: "selection", labels: ["x"] });
    expect(parsed).toEqual({
      ok: true,
      mode: "selection",
      lane: "pr",
      labels: ["x"],
      concurrency: CONCURRENCY_DEFAULT,
    });
  });

  test("accepts every integer across the documented range", () => {
    for (let n = CONCURRENCY_MIN; n <= CONCURRENCY_MAX; n += 1) {
      const parsed = validateRunRequest({ concurrency: n });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.concurrency).toBe(n);
    }
  });

  test("rejects everything outside the documented contract", () => {
    const invalid: unknown[] = [
      0,
      -3,
      2.5,
      CONCURRENCY_MAX + 1,
      1_000_000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "4",
      "junk",
      "",
      null,
      true,
      false,
      [],
      {},
    ];
    for (const concurrency of invalid) {
      const parsed = validateRunRequest({ concurrency });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("concurrency");
    }
  });

  test("tolerates a missing body", () => {
    const parsed = validateRunRequest(undefined);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.concurrency).toBe(CONCURRENCY_DEFAULT);
  });
});

/** Spawns server.mjs and resolves the ephemeral port it reports. */
function startConsole(entryPath: string, stateDir: string) {
  const child = spawn(process.execPath, [entryPath], {
    env: {
      ...process.env,
      ELIZA_TEST_CONSOLE_PORT: "0",
      ELIZA_TEST_CONSOLE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(
      () => reject(new Error(`server did not report a port; output: ${out}`)),
      15_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}); output: ${out}`));
    });
  });
  return { child, port };
}

describe("POST /api/run boundary ordering (real subprocess)", () => {
  let child: ChildProcess;
  let base: string;
  let stateDir: string;

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-console-run-"));
    const started = startConsole(SERVER_PATH, stateDir);
    child = started.child;
    base = `http://127.0.0.1:${await started.port}`;
  });

  afterAll(() => {
    child?.kill("SIGTERM");
  });

  test("invalid concurrency is rejected before task discovery or any state write", async () => {
    // A selection of a nonexistent label would produce "no tasks selected"
    // if discovery ran first — so a concurrency-shaped error proves the
    // validation boundary fired before discovery.
    const res = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "selection",
        labels: ["no-such-task-label"],
        concurrency: 99,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("concurrency");
    expect(body.error).not.toContain("no tasks");
    // No run was created and no credential/state file was persisted.
    expect(fs.existsSync(path.join(stateDir, "runs"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "credentials.json"))).toBe(false);
  });

  test("string and zero concurrency values also fail closed with 400", async () => {
    for (const concurrency of ["4", 0]) {
      const res = await fetch(`${base}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concurrency }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("concurrency");
    }
  });

  test("valid concurrency passes the boundary and reaches task selection", async () => {
    // An empty selection with an in-range concurrency must fail on the NEXT
    // stage (task selection), proving valid values flow through.
    const res = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "selection",
        labels: [],
        concurrency: CONCURRENCY_MIN,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no tasks selected");
  }, 60_000);
});

describe("direct entrypoint startup paths", () => {
  test("boots from the canonical checkout path", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-console-a-"));
    const { child, port } = startConsole(SERVER_PATH, stateDir);
    try {
      expect(await port).toBeGreaterThan(0);
    } finally {
      child.kill("SIGTERM");
    }
  });

  test("boots from a symlinked, space-containing path", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-console-b-"));
    const linkRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza console link-"),
    );
    const linkedDir = path.join(linkRoot, "console via symlink");
    fs.symlinkSync(path.dirname(SERVER_PATH), linkedDir);
    const { child, port } = startConsole(
      path.join(linkedDir, "server.mjs"),
      stateDir,
    );
    try {
      expect(await port).toBeGreaterThan(0);
    } finally {
      child.kill("SIGTERM");
    }
  });
});
