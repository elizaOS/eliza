/**
 * Boots the real API in Bun child processes to verify optional TCP binding
 * and rejection of invalid connector-health configuration before listening.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const HARNESS_PATH = join(
  import.meta.dirname,
  "../../test/fixtures",
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
  mode: "skip" | "bind" | "invalid",
  port: number,
): Promise<
  | {
      ok: true;
      mode: string;
      port: number;
      bound: boolean;
      rejected?: boolean;
      error?: string;
    }
  | { ok: false; error: string }
> {
  const bun = resolveBunExecutable();
  if (!bun) {
    return { ok: false, error: "bun executable not found on this host" };
  }
  try {
    const { stdout } = await execFileAsync(
      bun,
      ["--conditions=eliza-source", HARNESS_PATH, mode, String(port)],
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

describe("startApiServer skipListen — real boot in a Bun subprocess (#12180)", () => {
  it("binds NO TCP port when skipListen is true, and DOES bind when it is unset", async () => {
    // Two distinct free ports so the two boots never collide.
    const skipResult = await runBootHarness("skip", 39321);
    if (!skipResult.ok) {
      throw new Error(`skip-listen harness failed: ${skipResult.error}`);
    }

    expect(skipResult.mode).toBe("skip");
    expect(skipResult.bound).toBe(false); // no listener bound

    // Non-vacuous control: without skipListen the same boot DOES bind, so the
    // assertion above is a real guarantee, not a port that was never going to
    // bind anyway.
    const bindResult = await runBootHarness("bind", 39323);
    if (!bindResult.ok) {
      throw new Error(`binding harness failed: ${bindResult.error}`);
    }
    if (bindResult.ok) {
      expect(bindResult.bound).toBe(true);
    }
  }, 240_000);

  it("rejects malformed connector-health configuration before binding", async () => {
    const result = await runBootHarness("invalid", 39325);
    if (!result.ok) {
      throw new Error(`invalid-config harness failed: ${result.error}`);
    }
    if (result.ok) {
      expect(result.bound).toBe(false);
      expect(result).toMatchObject({ mode: "invalid", rejected: true });
      expect(result.error).toContain("CONNECTOR_HEALTH_INTERVAL_MS");
    }
  }, 120_000);
});
