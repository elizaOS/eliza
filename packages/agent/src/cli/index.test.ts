/**
 * Verifies eliza-autonomous CLI dispatch for the argument-only commands:
 * version resolution through the shared resolver (not a hardcoded relative
 * package.json require), help output, and the unknown-command failure.
 * Deterministic; the heavy serve/runtime/bridge branches boot real services
 * and are exercised by the packaged-runtime and e2e lanes instead.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAutonomousCli } from "./index.ts";

const packageVersion = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../package.json", import.meta.url)),
      "utf8",
    ),
  ) as { version: string }
).version;

function argv(...args: string[]): string[] {
  return ["node", "eliza-autonomous", ...args];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAutonomousCli argument-only commands", () => {
  it.each([
    "--version",
    "-v",
    "version",
  ])("%s prints the workspace package version", async (flag) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runAutonomousCli(argv(flag));
    expect(log).toHaveBeenCalledTimes(1);
    // The version must come from real package metadata via
    // resolveElizaVersion — the resolver throws rather than printing a
    // fabricated fallback when metadata is missing.
    expect(log).toHaveBeenCalledWith(packageVersion);
    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each([
    "--help",
    "-h",
    "help",
  ])("%s prints usage covering every dispatchable command", async (flag) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runAutonomousCli(argv(flag));
    expect(log).toHaveBeenCalledTimes(1);
    const usage = String(log.mock.calls[0]?.[0]);
    for (const command of [
      "serve",
      "runtime",
      "ios-bridge",
      "android-bridge",
      "benchmark",
    ]) {
      expect(usage).toContain(command);
    }
  });

  it("rejects an unknown command instead of silently serving", async () => {
    await expect(runAutonomousCli(argv("frobnicate"))).rejects.toThrow(
      "Unknown command: frobnicate",
    );
  });

  it("parses benchmark flags and fails fast on an invalid --timeout", async () => {
    // Exercises the benchmark dispatch branch (flag parsing + lazy import)
    // without booting a runtime: runBenchmark validates the timeout before
    // any boot work and exits with status 2.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null): never => {
        throw new Error(`process.exit(${code})`);
      });

    await expect(
      runAutonomousCli(
        argv(
          "benchmark",
          "--task",
          "/nonexistent/task.json",
          "--server",
          "--timeout",
          "not-a-number",
        ),
      ),
    ).rejects.toThrow("process.exit(2)");
    expect(exit).toHaveBeenCalledWith(2);
    expect(error).toHaveBeenCalledWith("[benchmark] Invalid timeout value");
  });
});
