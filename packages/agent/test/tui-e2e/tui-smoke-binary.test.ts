/**
 * Real-binary TUI smoke: spawns the packaged `eliza-autonomous tui-smoke`
 * subcommand as an actual child process (not the injectable in-process path)
 * and asserts it boots the shell, renders a first frame, and prints the
 * `elizaos-tui-ready` marker.
 *
 * This is the layer the injectable `VirtualTerminal` harness cannot reach: it
 * exercises real module resolution / bundling and the CLI dispatch end-to-end,
 * catching boot regressions a unit test would miss. It points the TUI at a dead
 * loopback URL — the shell tolerates a missing backend (refreshViews/Commands
 * both catch), so the test needs no running server and stays self-contained.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const binPath = join(repoRoot, "packages", "agent", "src", "bin.ts");

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runTuiSmoke(args: string[], timeoutMs = 60_000): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      ["--conditions=eliza-source", binPath, "tui-smoke", ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, ELIZA_TERMINAL_TUI: "1", CI: "true" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`tui-smoke timed out after ${timeoutMs}ms\n${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

describe("real-binary tui-smoke", () => {
  it("boots the packaged CLI, renders a first frame, and prints the readiness marker", async () => {
    const api = "http://127.0.0.1:1";
    const result = await runTuiSmoke(["--api", api]);

    expect(result.code).toBe(0);
    // The rendered first frame (the shell header) reached stdout.
    expect(result.stdout).toContain("elizaOS terminal tui");
    // The readiness marker echoes the resolved backend URL.
    expect(result.stdout).toContain(`elizaos-tui-ready api=${api}`);
  }, 90_000);
});
