/**
 * Covers the skip-listen boot harness CLI. Nothing is exported — `main()` runs
 * at load — so this suite spawns the real file under Bun and asserts argv
 * validation (mode + integer port), the JSON/exit contract, Number() integer
 * edge cases, and the catch path when `../server.ts` cannot load. Live
 * skip/bind/invalid boots of `startApiServer` are owned by
 * `../server-skip-listen.test.ts`; here we lock the flags the harness actually
 * sends.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const HARNESS_PATH = join(import.meta.dirname, "skip-listen-boot-harness.ts");
const SERVER_PATH = join(import.meta.dirname, "../server.ts");
const HARNESS_SRC = readFileSync(HARNESS_PATH, "utf8");

const USAGE = {
  ok: false,
  error: "usage: <skip|bind|invalid> <port>",
} as const;

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

describe("skip-listen-boot-harness", () => {
  const usageCases: Array<{ name: string; args: string[] }> = [
    { name: "missing argv", args: [] },
    { name: "skip without a port", args: ["skip"] },
    { name: "bind without a port", args: ["bind"] },
    { name: "invalid without a port", args: ["invalid"] },
    { name: "an unknown mode", args: ["listen", "39421"] },
    { name: "an uppercase mode", args: ["SKIP", "39421"] },
    { name: "a leading-space mode", args: [" skip", "39421"] },
    { name: "a non-numeric port", args: ["skip", "abc"] },
    { name: "a non-integer port", args: ["skip", "3.14"] },
    { name: "a port with trailing junk", args: ["skip", "10foo"] },
    { name: "NaN as the port", args: ["skip", "NaN"] },
    { name: "Infinity as the port", args: ["skip", "Infinity"] },
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

  it("does not treat a trailing extra argv as a valid mode when argv[2] is unusable", async () => {
    const result = await runHarness(["abc", "39421", "skip"]);
    expect(result.exitCode).toBe(2);
    expect(result.parsed).toEqual(USAGE);
  });

  const proceedsPastUsage: Array<{ name: string; args: string[] }> = [
    { name: "an empty-string port (Number('') === 0)", args: ["skip", ""] },
    { name: "port 0", args: ["skip", "0"] },
    { name: "a negative integer port", args: ["skip", "-1"] },
    { name: "signed zero as the port", args: ["skip", "-0"] },
    {
      name: "a trailing-zero float that Number() coerces to an integer",
      args: ["skip", "1.0"],
    },
    { name: "hex that Number() coerces to an integer", args: ["skip", "0x10"] },
    {
      name: "scientific notation that Number() coerces to an integer",
      args: ["skip", "1e3"],
    },
    { name: "a padded decimal port", args: ["skip", " 39421"] },
    {
      name: "trailing extra argv after a valid mode and port",
      args: ["skip", "39421", "extra"],
    },
    { name: "bind with an integer port", args: ["bind", "39423"] },
    { name: "invalid with an integer port", args: ["invalid", "39425"] },
  ];

  for (const { name, args } of proceedsPastUsage) {
    it.skipIf(existsSync(SERVER_PATH))(
      `does not usage-reject ${name}`,
      async () => {
        const result = await runHarness(args);
        expect(result.exitCode).not.toBe(2);
        expect(result.parsed).not.toEqual(USAGE);
        expect(result.parsed).toMatchObject({ ok: false });
        const parsed = result.parsed as { ok: false; error: string };
        expect(parsed.error.length).toBeGreaterThan(0);
      },
    );
  }

  it.skipIf(existsSync(SERVER_PATH))(
    "reports a non-usage load failure as ok:false on stdout and exits 1 when server.ts is absent",
    async () => {
      const result = await runHarness(["skip", "39421"]);
      expect(result.exitCode).toBe(1);
      expect(result.parsed).toMatchObject({ ok: false });
      expect(result.parsed).not.toEqual(USAGE);
      const parsed = result.parsed as { ok: false; error: string };
      expect(parsed.error.length).toBeGreaterThan(0);
    },
  );

  it("wires skipListen only for skip mode and probes the returned server port", () => {
    expect(HARNESS_SRC).toContain('skipListen: mode === "skip"');
    expect(HARNESS_SRC).toContain('initialAgentState: "starting"');
    expect(HARNESS_SRC).toContain("isPortBound(server.port)");
    expect(HARNESS_SRC).toContain("ELIZA_API_PORT");
  });

  it("rejects a malformed connector interval before bind and reports rejected", () => {
    expect(HARNESS_SRC).toContain('CONNECTOR_HEALTH_INTERVAL_MS = "10000junk"');
    expect(HARNESS_SRC).toContain("rejected: true");
    expect(HARNESS_SRC).toContain("invalid interval was accepted");
    expect(HARNESS_SRC).toContain("isPortBound(port)");
  });

  it("settles isPortBound on the first of connect, error, or timeout", () => {
    expect(HARNESS_SRC).toContain('host = "127.0.0.1"');
    expect(HARNESS_SRC).toContain("timeoutMs = 1000");
    expect(HARNESS_SRC).toContain("if (settled) return");
    expect(HARNESS_SRC).toContain('socket.once("connect"');
    expect(HARNESS_SRC).toContain('socket.once("error"');
    expect(HARNESS_SRC).toContain("socket.destroy()");
  });

  it("closes the server after reporting and uses the JSON/exit contract", () => {
    expect(HARNESS_SRC).toContain("await server.close()");
    expect(HARNESS_SRC).toContain("process.exit(0)");
    expect(HARNESS_SRC).toContain("process.exit(1)");
    expect(HARNESS_SRC).toContain("process.exit(2)");
    expect(HARNESS_SRC).toContain(
      'mode !== "skip" && mode !== "bind" && mode !== "invalid"',
    );
    expect(HARNESS_SRC).toContain("!Number.isInteger(port)");
  });
});
