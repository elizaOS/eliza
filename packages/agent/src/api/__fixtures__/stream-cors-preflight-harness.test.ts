/**
 * Covers the stream CORS preflight subprocess harness. Nothing is exported —
 * `main()` runs at load — so this suite spawns the real file under Bun and
 * asserts argv/port validation, the JSON/exit contract, and the catch path
 * when `../server.ts` cannot load. The live OPTIONS wire is owned by
 * `../server-cors-preflight.test.ts`; here we lock the request the harness
 * actually sends.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const HARNESS_PATH = join(
  import.meta.dirname,
  "stream-cors-preflight-harness.ts",
);
const SERVER_PATH = join(import.meta.dirname, "../server.ts");
const HARNESS_SRC = readFileSync(HARNESS_PATH, "utf8");

const USAGE = { ok: false, error: "usage: <port>" } as const;

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

function lastJsonLine(stdout: string): unknown {
  const lastLine = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}";
  return JSON.parse(lastLine) as unknown;
}

function execErrorFields(err: unknown): {
  stdout: string;
  stderr: string;
  code: number | null;
} {
  if (typeof err !== "object" || err === null) {
    return { stdout: "", stderr: "", code: null };
  }
  const rec = err as { stdout?: unknown; stderr?: unknown; code?: unknown };
  return {
    stdout: typeof rec.stdout === "string" ? rec.stdout : "",
    stderr: typeof rec.stderr === "string" ? rec.stderr : "",
    code: typeof rec.code === "number" ? rec.code : null,
  };
}

async function runHarness(args: string[]): Promise<{
  exitCode: number | null;
  stdout: string;
  parsed: unknown;
}> {
  const bun = resolveBunExecutable();
  if (!bun) {
    throw new Error("bun executable not found on this host");
  }
  try {
    const { stdout } = await execFileAsync(bun, [HARNESS_PATH, ...args], {
      timeout: 15_000,
      env: { ...process.env },
    });
    return { exitCode: 0, stdout, parsed: lastJsonLine(stdout) };
  } catch (err) {
    const fields = execErrorFields(err);
    return {
      exitCode: fields.code,
      stdout: fields.stdout,
      parsed: lastJsonLine(fields.stdout),
    };
  }
}

describe("stream-cors-preflight-harness", () => {
  const usageCases: Array<{ name: string; args: string[] }> = [
    { name: "a missing port argument", args: [] },
    { name: "a non-numeric port", args: ["abc"] },
    { name: "a non-integer port", args: ["1.5"] },
    { name: "port 0", args: ["0"] },
    { name: "a negative port", args: ["-1"] },
    { name: "an empty-string port", args: [""] },
    { name: "NaN as the port", args: ["NaN"] },
    { name: "Infinity as the port", args: ["Infinity"] },
    { name: "signed zero as the port", args: ["-0"] },
  ];

  for (const { name, args } of usageCases) {
    it(`rejects ${name} with usage JSON and exit 2`, async () => {
      const result = await runHarness(args);
      expect(result.exitCode).toBe(2);
      expect(result.parsed).toEqual(USAGE);
    });
  }

  it("writes the usage JSON as a single stdout line", async () => {
    const result = await runHarness(["nope"]);
    expect(result.stdout.trim()).toBe(JSON.stringify(USAGE));
  });

  it("does not treat a trailing extra argv as a valid port when argv[2] is unusable", async () => {
    const result = await runHarness(["abc", "8080"]);
    expect(result.exitCode).toBe(2);
    expect(result.parsed).toEqual(USAGE);
  });

  it.skipIf(existsSync(SERVER_PATH))(
    "reports a non-usage load failure as ok:false on stdout and exits 1 when server.ts is absent",
    async () => {
      const result = await runHarness(["41234"]);
      expect(result.exitCode).toBe(1);
      expect(result.parsed).toMatchObject({ ok: false });
      expect(result.parsed).not.toEqual(USAGE);
      const parsed = result.parsed as { ok: false; error: string };
      expect(parsed.error.length).toBeGreaterThan(0);
    },
  );

  it("sends the Capacitor stream preflight the parent test asserts", () => {
    expect(HARNESS_SRC).toContain('method: "OPTIONS"');
    expect(HARNESS_SRC).toContain("/api/conversations/conv-1/messages/stream");
    expect(HARNESS_SRC).toContain('origin: "https://localhost"');
    expect(HARNESS_SRC).toContain(
      "authorization,content-type,x-elizaos-client-id",
    );
    expect(HARNESS_SRC).toContain('initialAgentState: "starting"');
    expect(HARNESS_SRC).toContain("skipDeferredStartupWork: true");
  });

  it("closes the server in finally and reports CORS allow headers on success", () => {
    expect(HARNESS_SRC).toContain("await server.close()");
    expect(HARNESS_SRC).toContain("allowOrigin:");
    expect(HARNESS_SRC).toContain("allowMethods:");
    expect(HARNESS_SRC).toContain("allowHeaders:");
    expect(HARNESS_SRC).toContain("process.exit(0)");
    expect(HARNESS_SRC).toContain("process.exit(1)");
    expect(HARNESS_SRC).toContain("process.exit(2)");
  });
});
