/**
 * adoptCodexCliLogin transactional guarantees against the real filesystem: a
 * temp HOME/ELIZA_HOME/CODEX_HOME per test (removed afterEach), permission-based
 * fault injection for the retire/pool-write failure paths, and a genuine second
 * OS process performing Codex's atomic-replace refresh write pattern for the
 * concurrent-refresher race.
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAccount } from "../account-storage.ts";
import {
  adoptCodexCliLogin,
  restoreRetiredSource,
} from "./adopt-codex-cli-login.ts";

let home: string;
const savedEnv: Record<string, string | undefined> = {};

function makeJwt(expSeconds: number): string {
  const b = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "RS256" })}.${b({ exp: expSeconds })}.sig`;
}

function codexAuthBody(refresh: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
      refresh_token: refresh,
      id_token: "id.token.codex",
      account_id: "acct-abc",
    },
    last_refresh: new Date().toISOString(),
  });
}

function writeCodexAuth(dir: string, refresh: string): string {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "auth.json");
  writeFileSync(p, codexAuthBody(refresh));
  return p;
}

function expectAdoptError(fn: () => unknown, code: string): ElizaError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ElizaError);
    expect((err as ElizaError).code).toBe(code);
    return err as ElizaError;
  }
  throw new Error(`expected ElizaError ${code}, nothing was thrown`);
}

function retiredFilesIn(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.includes(".adopted-"));
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "adopt-codex-"));
  for (const key of ["HOME", "ELIZA_HOME", "CODEX_HOME"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.HOME = home;
  process.env.ELIZA_HOME = home; // authRoot() → <ELIZA_HOME>/auth
  delete process.env.CODEX_HOME;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Fault-injection tests drop write bits; restore them so rm can clean up.
  for (const sub of ["codex", "auth"]) {
    try {
      chmodSync(path.join(home, sub), 0o755);
    } catch {
      // error-policy:J6 best-effort teardown — the dir may not exist.
    }
  }
  rmSync(home, { recursive: true, force: true });
});

describe("success path", () => {
  it("adopts the login, retires the source, and stores exactly the retired bytes", () => {
    const codexHome = path.join(home, "codex");
    const authPath = writeCodexAuth(codexHome, "refresh-1");

    const result = adoptCodexCliLogin({ codexHome, accountId: "pool-a" });

    // Source is gone from the CLI read path; the retired copy exists.
    expect(existsSync(authPath)).toBe(false);
    expect(existsSync(result.retiredTo)).toBe(true);

    // Pool credentials are byte-identical to the retired file's tokens — the
    // invariant that makes adoption race-safe against concurrent refreshes.
    const retired = JSON.parse(readFileSync(result.retiredTo, "utf-8")) as {
      tokens: { access_token: string; refresh_token: string };
    };
    const account = loadAccount("openai-codex", "pool-a");
    expect(account?.credentials.access).toBe(retired.tokens.access_token);
    expect(account?.credentials.refresh).toBe(retired.tokens.refresh_token);
    expect(account?.credentials.idToken).toBe("id.token.codex");
    expect(result.organizationId).toBe("acct-abc");
  });

  it("adopts from the default CODEX_HOME when no explicit home is given", () => {
    process.env.CODEX_HOME = path.join(home, ".codex");
    writeCodexAuth(process.env.CODEX_HOME, "rt.default-home");

    adoptCodexCliLogin();

    expect(loadAccount("openai-codex", "default")?.credentials.refresh).toBe(
      "rt.default-home",
    );
  });

  it("repeated adoption preserves every retired artifact (no-clobber retirement)", () => {
    const codexHome = path.join(home, "codex");
    writeCodexAuth(codexHome, "refresh-first");
    const first = adoptCodexCliLogin({ codexHome, accountId: "pool-a" });

    writeCodexAuth(codexHome, "refresh-second");
    const second = adoptCodexCliLogin({
      codexHome,
      accountId: "pool-a",
      overwrite: true,
    });

    expect(first.retiredTo).not.toBe(second.retiredTo);
    expect(retiredFilesIn(codexHome)).toHaveLength(2);
    expect(readFileSync(first.retiredTo, "utf-8")).toContain("refresh-first");
    expect(readFileSync(second.retiredTo, "utf-8")).toContain(
      "refresh-second",
    );
    // The pool holds the latest adoption.
    expect(loadAccount("openai-codex", "pool-a")?.credentials.refresh).toBe(
      "refresh-second",
    );
  });
});

describe("account id boundary", () => {
  it.each([
    ["traversal", "../evil"],
    ["embedded traversal", "a..b"],
    ["posix separator", "a/b"],
    ["windows separator", "a\\b"],
    ["empty", ""],
    ["dot", "."],
    ["dotdot", ".."],
    ["space", "a b"],
    ["control char", "a\u0000b"],
    ["overlong", "a".repeat(200)],
    ["leading dot", ".hidden"],
  ])("rejects %s account id before any filesystem effect", (_label, id) => {
    const codexHome = path.join(home, "codex");
    const authPath = writeCodexAuth(codexHome, "refresh-1");

    expectAdoptError(
      () => adoptCodexCliLogin({ codexHome, accountId: id }),
      "adopt_codex.invalid_account_id",
    );

    // The source was never touched.
    expect(existsSync(authPath)).toBe(true);
    expect(retiredFilesIn(codexHome)).toHaveLength(0);
  });
});

describe("source validation", () => {
  it("classifies a missing source as no_source", () => {
    expectAdoptError(
      () => adoptCodexCliLogin({ codexHome: path.join(home, "nope") }),
      "adopt_codex.no_source",
    );
  });

  it("classifies a permission failure as source_stat_failed, not absence", () => {
    const codexHome = path.join(home, "codex");
    writeCodexAuth(codexHome, "refresh-1");
    chmodSync(codexHome, 0o000);
    try {
      expectAdoptError(
        () => adoptCodexCliLogin({ codexHome }),
        "adopt_codex.source_stat_failed",
      );
    } finally {
      chmodSync(codexHome, 0o755);
    }
  });

  it("refuses a symlinked auth.json and consumes nothing", () => {
    const codexHome = path.join(home, "codex");
    mkdirSync(codexHome, { recursive: true });
    const real = path.join(home, "elsewhere.json");
    writeFileSync(real, codexAuthBody("refresh-1"));
    const link = path.join(codexHome, "auth.json");
    symlinkSync(real, link);

    expectAdoptError(
      () => adoptCodexCliLogin({ codexHome }),
      "adopt_codex.not_regular_file",
    );
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(real)).toBe(true);
    expect(loadAccount("openai-codex", "default")).toBeNull();
  });

  it("restores the source when it is not valid JSON", () => {
    const codexHome = path.join(home, "codex");
    mkdirSync(codexHome, { recursive: true });
    const authPath = path.join(codexHome, "auth.json");
    writeFileSync(authPath, "{not json");

    expectAdoptError(
      () => adoptCodexCliLogin({ codexHome }),
      "adopt_codex.unreadable",
    );
    expect(existsSync(authPath)).toBe(true);
    expect(retiredFilesIn(codexHome)).toHaveLength(0);
  });

  it.each([
    ["missing tokens", JSON.stringify({ auth_mode: "chatgpt" })],
    ["empty token block", JSON.stringify({ tokens: {} })],
    [
      "numeric access token",
      JSON.stringify({ tokens: { access_token: 12345, refresh_token: "r" } }),
    ],
    [
      "numeric id token",
      JSON.stringify({
        tokens: { access_token: "a", refresh_token: "r", id_token: 7 },
      }),
    ],
    [
      "empty refresh token",
      JSON.stringify({ tokens: { access_token: "a", refresh_token: "" } }),
    ],
  ])("restores the source on %s", (_label, body) => {
    const codexHome = path.join(home, "codex");
    mkdirSync(codexHome, { recursive: true });
    const authPath = path.join(codexHome, "auth.json");
    writeFileSync(authPath, body);

    expectAdoptError(
      () => adoptCodexCliLogin({ codexHome }),
      "adopt_codex.invalid_tokens",
    );
    // Full rollback: source back in place, nothing retired, nothing pooled.
    expect(existsSync(authPath)).toBe(true);
    expect(retiredFilesIn(codexHome)).toHaveLength(0);
    expect(loadAccount("openai-codex", "default")).toBeNull();
  });
});

describe("pool collision", () => {
  it("refuses to overwrite an existing pool account and leaves the source untouched", () => {
    const codexHome = path.join(home, "codex");
    writeCodexAuth(codexHome, "refresh-1");
    adoptCodexCliLogin({ codexHome, accountId: "pool-a" });
    const authPath = writeCodexAuth(codexHome, "refresh-2");

    expectAdoptError(
      () => adoptCodexCliLogin({ codexHome, accountId: "pool-a" }),
      "adopt_codex.account_exists",
    );
    expect(existsSync(authPath)).toBe(true);
    expect(loadAccount("openai-codex", "pool-a")?.credentials.refresh).toBe(
      "refresh-1",
    );
  });
});

describe("fault injection", () => {
  it("hard-fails retire when the source dir is not writable, committing nothing", () => {
    const codexHome = path.join(home, "codex");
    const authPath = writeCodexAuth(codexHome, "refresh-1");
    chmodSync(codexHome, 0o555);
    try {
      expectAdoptError(
        () => adoptCodexCliLogin({ codexHome }),
        "adopt_codex.retire_failed",
      );
    } finally {
      chmodSync(codexHome, 0o755);
    }
    expect(existsSync(authPath)).toBe(true);
    expect(loadAccount("openai-codex", "default")).toBeNull();
  });

  it("restores the source when the pool write fails", () => {
    const codexHome = path.join(home, "codex");
    const authPath = writeCodexAuth(codexHome, "refresh-1");
    // Seed the auth-store dir, then drop its write bit so saveAccount fails.
    const authStoreDir = path.join(home, "auth");
    mkdirSync(authStoreDir, { recursive: true });
    chmodSync(authStoreDir, 0o555);
    try {
      const err = expectAdoptError(
        () => adoptCodexCliLogin({ codexHome }),
        "adopt_codex.pool_write_failed",
      );
      expect(err.context?.restored).toBe(true);
    } finally {
      chmodSync(authStoreDir, 0o755);
    }
    // Rollback: the CLI login is usable again, nothing left retired.
    expect(existsSync(authPath)).toBe(true);
    expect(retiredFilesIn(codexHome)).toHaveLength(0);
  });

  it("restoreRetiredSource refuses to clobber an occupied original path", () => {
    const dir = path.join(home, "restore");
    mkdirSync(dir, { recursive: true });
    const retired = path.join(dir, "auth.json.adopted-test");
    const original = path.join(dir, "auth.json");
    writeFileSync(retired, "retired-bytes");
    writeFileSync(original, "fresher-bytes");

    const result = restoreRetiredSource(retired, original);

    expect(result).toEqual({ restored: false, reason: "destination_occupied" });
    // Both artifacts survive: the fresher login and the retired copy.
    expect(readFileSync(original, "utf-8")).toBe("fresher-bytes");
    expect(readFileSync(retired, "utf-8")).toBe("retired-bytes");
  });

  it("restoreRetiredSource moves the retired file back when the path is free", () => {
    const dir = path.join(home, "restore");
    mkdirSync(dir, { recursive: true });
    const retired = path.join(dir, "auth.json.adopted-test");
    const original = path.join(dir, "auth.json");
    writeFileSync(retired, "retired-bytes");

    expect(restoreRetiredSource(retired, original)).toEqual({ restored: true });
    expect(readFileSync(original, "utf-8")).toBe("retired-bytes");
    expect(existsSync(retired)).toBe(false);
  });
});

describe("two-process concurrency", () => {
  it("holds pool==retired under a real second process doing atomic replaces, and detects the live refresher", async () => {
    const codexHome = path.join(home, "codex");
    writeCodexAuth(codexHome, "refresh-base");
    const authPath = path.join(codexHome, "auth.json");

    // A genuine second OS process performing Codex's refresh write pattern:
    // write a temp file, atomically rename it over auth.json, in a tight loop.
    const writerScript = `
      const { writeFileSync, renameSync } = require("node:fs");
      const authPath = process.argv[1];
      const body = (i) => JSON.stringify({
        tokens: {
          access_token: "concurrent-access-" + i,
          refresh_token: "concurrent-refresh-" + i,
        },
      });
      const deadline = Date.now() + 700;
      let i = 0;
      while (Date.now() < deadline) {
        const tmp = authPath + ".tmp";
        writeFileSync(tmp, body(i));
        renameSync(tmp, authPath);
        i++;
      }
    `;
    const writer = spawn(process.execPath, ["-e", writerScript, authPath], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    const writerDone = new Promise<void>((resolve) => {
      writer.on("exit", () => resolve());
    });
    // Let the writer enter its replace loop before racing it.
    await new Promise((resolve) => setTimeout(resolve, 100));

    let sawConcurrentFailure = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const result = adoptCodexCliLogin({
          codexHome,
          accountId: `race-${attempt}`,
        });
        // Invariant: whatever was adopted is byte-identical to the retired
        // file — a torn read/rename interleaving is impossible.
        const retired = JSON.parse(
          readFileSync(result.retiredTo, "utf-8"),
        ) as { tokens: { refresh_token: string } };
        expect(
          loadAccount("openai-codex", `race-${attempt}`)?.credentials.refresh,
        ).toBe(retired.tokens.refresh_token);
      } catch (err) {
        const code = (err as ElizaError).code;
        // While the writer lives, the two legitimate failures are
        // concurrent_refresher (source reappeared after our rename) and
        // no_source (attempt landed between its rename cycles). Anything
        // else is a real bug.
        expect([
          "adopt_codex.concurrent_refresher",
          "adopt_codex.no_source",
        ]).toContain(code);
        if (code === "adopt_codex.concurrent_refresher") {
          sawConcurrentFailure = true;
          // The retired copy is preserved for the operator to inspect.
          expect(
            existsSync(String((err as ElizaError).context?.retiredTo)),
          ).toBe(true);
        }
      }
    }
    // A tight-loop atomic replacer lands a write between our rename and the
    // reappearance check on effectively every attempt.
    expect(sawConcurrentFailure).toBe(true);

    await writerDone;

    // Once the refresher is stopped, adoption succeeds cleanly.
    writeCodexAuth(codexHome, "refresh-after-race");
    const final = adoptCodexCliLogin({ codexHome, accountId: "post-race" });
    expect(loadAccount("openai-codex", "post-race")?.credentials.refresh).toBe(
      "refresh-after-race",
    );
    expect(existsSync(final.retiredTo)).toBe(true);
  }, 15_000);
});
