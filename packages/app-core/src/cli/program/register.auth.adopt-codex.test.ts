/**
 * `eliza auth adopt-codex` drives the real adoption in @elizaos/auth against a
 * temp HOME/ELIZA_HOME/CODEX_HOME — no simulation layer. Covers the explicit
 * --yes confirmation gate, the successful ownership transfer, typed failure
 * surfacing, and the commander wiring (subcommand present under `auth` with the
 * confirmation described).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerProgramCommands } from "./command-registry";
import { runAuthAdoptCodex } from "./register.auth.adopt-codex";

let home: string;
const savedEnv: Record<string, string | undefined> = {};

function makeJwt(expSeconds: number): string {
  const b = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "RS256" })}.${b({ exp: expSeconds })}.sig`;
}

function writeCodexAuth(dir: string, refresh: string): string {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "auth.json");
  writeFileSync(
    p,
    JSON.stringify({
      tokens: {
        access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: refresh,
        account_id: "acct-cli",
      },
    }),
  );
  return p;
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "adopt-codex-cli-"));
  for (const key of ["HOME", "ELIZA_HOME", "CODEX_HOME"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.HOME = home;
  process.env.ELIZA_HOME = home;
  delete process.env.CODEX_HOME;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("runAuthAdoptCodex", () => {
  it("refuses without --yes, describing the transfer and touching nothing", async () => {
    const codexHome = path.join(home, "codex");
    const authPath = writeCodexAuth(codexHome, "rt.cli-1");
    const lines: string[] = [];

    const result = await runAuthAdoptCodex({
      codexHome,
      log: (l) => lines.push(l),
    });

    expect(result).toMatchObject({ ok: false, reason: "not_confirmed" });
    // The description names the destructive consequence and the retry path.
    expect(lines.join("\n")).toContain("logged out");
    expect(lines.join("\n")).toContain("--yes");
    // Nothing happened to the source.
    expect(existsSync(authPath)).toBe(true);
  });

  it("adopts for real with --yes: pool account written, source retired", async () => {
    const codexHome = path.join(home, "codex");
    const authPath = writeCodexAuth(codexHome, "rt.cli-2");

    const result = await runAuthAdoptCodex({
      codexHome,
      accountId: "cli-pool",
      yes: true,
      log: () => undefined,
    });

    expect(result.ok).toBe(true);
    expect(result.accountId).toBe("cli-pool");
    expect(result.organizationId).toBe("acct-cli");
    // Ownership transfer really happened on disk.
    expect(existsSync(authPath)).toBe(false);
    expect(existsSync(String(result.retiredTo))).toBe(true);
    expect(readFileSync(String(result.retiredTo), "utf-8")).toContain(
      "rt.cli-2",
    );
  });

  it("surfaces a typed adoption failure without throwing", async () => {
    const result = await runAuthAdoptCodex({
      codexHome: path.join(home, "missing"),
      yes: true,
      log: () => undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("adopt_codex.no_source");
  });

  it("rejects a traversal account id at the auth boundary", async () => {
    const codexHome = path.join(home, "codex");
    const authPath = writeCodexAuth(codexHome, "rt.cli-3");

    const result = await runAuthAdoptCodex({
      codexHome,
      accountId: "../evil",
      yes: true,
      log: () => undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("adopt_codex.invalid_account_id");
    expect(existsSync(authPath)).toBe(true);
  });
});

describe("commander wiring", () => {
  it("registers adopt-codex under the auth group with the confirmation flag", () => {
    const program = new Command();
    registerProgramCommands(program, ["node", "eliza"]);

    const auth = program.commands.find((c) => c.name() === "auth");
    expect(auth).toBeDefined();
    const adopt = auth?.commands.find((c) => c.name() === "adopt-codex");
    expect(adopt).toBeDefined();
    expect(adopt?.description()).toContain("requires --yes");
    const optionNames = adopt?.options.map((o) => o.long);
    expect(optionNames).toEqual(
      expect.arrayContaining([
        "--account",
        "--codex-home",
        "--overwrite",
        "--yes",
        "--json",
      ]),
    );
  });

  it("registers every top-level command exactly once", () => {
    const program = new Command();
    registerProgramCommands(program, ["node", "eliza"]);

    const names = program.commands.map((c) => c.name());
    for (const expected of [
      "start",
      "benchmark",
      "setup",
      "doctor",
      "db",
      "configure",
      "dashboard",
      "update",
      "auth",
    ]) {
      expect(names.filter((n) => n === expected)).toHaveLength(1);
    }
  });
});
