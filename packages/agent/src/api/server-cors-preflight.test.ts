/**
 * Real-server regression for native chat-streaming CORS preflight.
 *
 * Dedicated cloud agents receive `/api/conversations/:id/messages/stream` from
 * a Capacitor WebView origin, and the browser preflight includes
 * `x-elizaos-client-id`. This test boots the actual agent HTTP server in a Bun
 * subprocess and asserts the stream preflight inherits the full CORS allowlist,
 * not a route-local minimal one.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const HARNESS_PATH = join(
  import.meta.dirname,
  "__fixtures__",
  "stream-cors-preflight-harness.ts",
);

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
    /* not on PATH; try absolute fallbacks */
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

function findFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function runPreflightHarness(port: number): Promise<
  | {
      ok: true;
      status: number;
      allowOrigin: string | null;
      allowMethods: string | null;
      allowHeaders: string | null;
    }
  | { ok: false; error: string }
> {
  const bun = resolveBunExecutable();
  if (!bun) {
    return { ok: false, error: "bun executable not found on this host" };
  }

  try {
    const { stdout } = await execFileAsync(bun, [HARNESS_PATH, String(port)], {
      timeout: 120_000,
      env: { ...process.env },
    });
    const lastLine = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}";
    return JSON.parse(lastLine);
  } catch (err) {
    const stdout =
      typeof (err as { stdout?: unknown }).stdout === "string"
        ? (err as { stdout: string }).stdout
        : "";
    const lastLine = stdout.trim().split("\n").filter(Boolean).at(-1);
    if (lastLine) {
      try {
        return JSON.parse(lastLine);
      } catch {
        /* fall through to the process error below */
      }
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

describe("stream route CORS preflight", () => {
  it("allows the native client-id header on /messages/stream", async () => {
    const result = await runPreflightHarness(await findFreePort());
    if (!result.ok) {
      throw new Error(`preflight harness failed: ${result.error}`);
    }

    expect(result.status).toBe(204);
    expect(result.allowOrigin).toBe("https://localhost");
    expect(result.allowMethods).toContain("POST");
    expect(result.allowHeaders?.toLowerCase()).toContain("x-elizaos-client-id");
  }, 180_000);
});
