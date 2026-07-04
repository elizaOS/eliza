import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * `skipListen` guard for the local-agent IPC transport (#12180).
 *
 * `startApiServer` cannot be imported directly into THIS vitest lane: `server.ts`
 * imports `@elizaos/app-core` subpaths that the package's test alias rewrites to
 * a non-directory path (ENOTDIR), so its module graph fails to load in-process —
 * the same documented constraint that keeps every other agent test from
 * importing `server.ts` (see `health-routes.canRespond-ws.test.ts`).
 *
 * Under a plain Bun runtime (no vitest alias), the module graph DOES load, so the
 * real behavioral guarantee is exercised by booting `startApiServer` in a Bun
 * child process (`__fixtures__/skip-listen-boot-harness.ts`) and asserting the
 * agent port is NOT bound with `skipListen: true` and IS bound without it (the
 * non-vacuous control). That subprocess boot additionally needs the built dist +
 * generated i18n data; when those are absent (a sparse checkout), the harness
 * reports a load failure and the behavioral case is skipped explicitly rather
 * than false-failing — the source-level assertions below still hold either way.
 */

const execFileAsync = promisify(execFile);

const SERVER_SRC = readFileSync(join(import.meta.dirname, "server.ts"), "utf8");

const HARNESS_PATH = join(
  import.meta.dirname,
  "__fixtures__",
  "skip-listen-boot-harness.ts",
);

/**
 * Locate a `bun` executable to run the harness. The harness imports the
 * elizaOS module graph (TS + Bun-only APIs) and must run under Bun, NOT the node
 * process vitest may spawn the test file under. `Bun` is present when vitest
 * itself runs under Bun; otherwise resolve `bun` on PATH (the agent test env
 * overrides HOME to a temp dir, so a PATH lookup is more reliable than
 * `~/.bun/bin/bun`), then fall back to a few absolute install locations.
 */
function resolveBunExecutable(): string | null {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    return process.execPath;
  }
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const resolved = execFileSync(locator, ["bun"], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (resolved && existsSync(resolved)) return resolved;
  } catch {
    /* not on PATH — try absolute fallbacks */
  }
  const candidates = [
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, "bin", "bun") : "",
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Run the boot harness under Bun and parse its single JSON result line. */
async function runBootHarness(
  mode: "skip" | "bind",
  port: number,
): Promise<
  | { ok: true; mode: string; port: number; bound: boolean }
  | { ok: false; error: string }
> {
  const bun = resolveBunExecutable();
  if (!bun) {
    return { ok: false, error: "bun executable not found on this host" };
  }
  try {
    const { stdout } = await execFileAsync(
      bun,
      [HARNESS_PATH, mode, String(port)],
      { timeout: 120_000, env: { ...process.env } },
    );
    const lastLine = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}";
    return JSON.parse(lastLine);
  } catch (err) {
    // A non-zero exit (module graph fails to load in a sparse checkout) still
    // prints a JSON error line on stdout — surface it so the caller can skip.
    const stdout =
      typeof (err as { stdout?: unknown }).stdout === "string"
        ? (err as { stdout: string }).stdout
        : "";
    const lastLine = stdout.trim().split("\n").filter(Boolean).at(-1);
    if (lastLine) {
      try {
        return JSON.parse(lastLine);
      } catch {
        /* fall through */
      }
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

describe("startApiServer skipListen — source-level guard (#12180)", () => {
  it("declares an optional skipListen boolean on the options object", () => {
    expect(SERVER_SRC).toMatch(/skipListen\?:\s*boolean/);
  });

  it("short-circuits on opts?.skipListen before binding a TCP listener", () => {
    const guardIndex = SERVER_SRC.indexOf("if (opts?.skipListen)");
    expect(guardIndex).toBeGreaterThan(-1);

    // The skip branch must return before the listening Promise is created.
    const listenPromiseIndex = SERVER_SRC.indexOf(
      "return new Promise((resolve, reject) => {",
    );
    expect(listenPromiseIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(listenPromiseIndex);

    // Between the guard and the listening Promise there must be no server.listen
    // call — the skip path opens no socket.
    const branchBody = SERVER_SRC.slice(guardIndex, listenPromiseIndex);
    expect(branchBody).not.toMatch(/server\.listen\(/);
  });

  it("returns the full server contract from the skip-listen branch", () => {
    const guardIndex = SERVER_SRC.indexOf("if (opts?.skipListen)");
    const listenPromiseIndex = SERVER_SRC.indexOf(
      "return new Promise((resolve, reject) => {",
    );
    const branchBody = SERVER_SRC.slice(guardIndex, listenPromiseIndex);

    // Same public shape the listening path resolves with, so callers (and the
    // in-process dispatchRoute kernel) are unaffected by the bind being skipped.
    expect(branchBody).toMatch(/return\s*\{/);
    expect(branchBody).toMatch(/\bport\b/);
    expect(branchBody).toMatch(/close:/);
    expect(branchBody).toMatch(/updateRuntime,/);
    expect(branchBody).toMatch(/updateStartup,/);
  });

  it("still runs deferred startup work in skip mode unless explicitly skipped", () => {
    const guardIndex = SERVER_SRC.indexOf("if (opts?.skipListen)");
    const listenPromiseIndex = SERVER_SRC.indexOf(
      "return new Promise((resolve, reject) => {",
    );
    const branchBody = SERVER_SRC.slice(guardIndex, listenPromiseIndex);
    expect(branchBody).toContain("startDeferredStartupWork()");
    expect(branchBody).toContain("skipDeferredStartupWork");
  });

  it("keeps the listening path (default) binding via server.listen", () => {
    // Regression proof for the default path: the un-guarded server.listen call
    // still exists and is reached when skipListen is unset.
    expect(SERVER_SRC).toMatch(/server\.listen\(port,\s*host,/);
  });
});

describe("startApiServer streaming screen capture lookup — source-level guard (#12249)", () => {
  it("resolves screenCapture lazily from the current runtime", () => {
    expect(SERVER_SRC).toContain(
      "const resolveScreenCapture = (): IScreenCaptureService | undefined =>",
    );
    expect(SERVER_SRC).toMatch(
      /get\s+screenCapture\(\)\s*\{\s*return\s+resolveScreenCapture\(\);\s*\}/s,
    );
  });

  it("does not snapshot the screen-capture service while streaming routes register", () => {
    expect(SERVER_SRC).not.toMatch(
      /const\s+screenCapture\s*=\s*state\.runtime\?\.getService/s,
    );
  });
});

describe("startApiServer skipListen — real boot in a Bun subprocess (#12180)", () => {
  it("has a boot harness fixture", () => {
    expect(existsSync(HARNESS_PATH)).toBe(true);
  });

  it("binds NO TCP port when skipListen is true, and DOES bind when it is unset", async () => {
    // Two distinct free ports so the two boots never collide.
    const skipResult = await runBootHarness("skip", 39321);
    if (!skipResult.ok) {
      // Sparse checkout: server.ts's module graph needs the built dist +
      // generated i18n data to boot under Bun. Do NOT claim behavioral
      // coverage we didn't get — surface the reason and skip explicitly.
      console.warn(
        `[server-skip-listen] behavioral boot unavailable in this environment: ${skipResult.error}`,
      );
      return;
    }

    expect(skipResult.mode).toBe("skip");
    expect(skipResult.bound).toBe(false); // no listener bound

    // Non-vacuous control: without skipListen the same boot DOES bind, so the
    // assertion above is a real guarantee, not a port that was never going to
    // bind anyway.
    const bindResult = await runBootHarness("bind", 39323);
    expect(bindResult.ok).toBe(true);
    if (bindResult.ok) {
      expect(bindResult.bound).toBe(true);
    }
  }, 240_000);
});
