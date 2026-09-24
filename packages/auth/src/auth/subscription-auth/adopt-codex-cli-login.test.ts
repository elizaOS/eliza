/**
 * adoptCodexCliLogin transactional guarantees against the real filesystem: a
 * temp HOME/ELIZA_HOME/CODEX_HOME per test (removed afterEach), permission-based
 * fault injection for the retire/pool-write failure paths, and a genuine second
 * OS process performing Codex's atomic-replace refresh write pattern for the
 * concurrent-refresher race, synchronized at the real retirement rename.
 */
import { spawn } from "node:child_process";
import fs, {
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
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createIsolatedAccountStoragePolicy,
  loadAccount,
} from "../account-storage.ts";
import {
  type AdoptCodexOptions,
  adoptCodexCliLogin as adoptCodexCliLoginWithPolicy,
  restoreRetiredSource,
} from "./adopt-codex-cli-login.ts";

let home: string;
const savedEnv: Record<string, string | undefined> = {};

function adoptCodexCliLogin(
  options: Omit<AdoptCodexOptions, "storagePolicy"> = {},
) {
  return adoptCodexCliLoginWithPolicy({
    ...options,
    storagePolicy: createIsolatedAccountStoragePolicy(home),
  });
}

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

async function expectAdoptError(
  fn: () => Promise<unknown>,
  code: string,
): Promise<ElizaError> {
  try {
    await fn();
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
  for (const key of ["HOME", "ELIZA_HOME", "ELIZA_STATE_DIR", "CODEX_HOME"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.HOME = home;
  process.env.ELIZA_HOME = home; // authRoot() → <ELIZA_HOME>/auth
  process.env.ELIZA_STATE_DIR = home;
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
  it("adopts the login, retires the source, and stores exactly the retired bytes", async () => {
    const codexHome = path.join(home, "codex");
    const authPath = writeCodexAuth(codexHome, "refresh-1");

    const result = await adoptCodexCliLogin({ codexHome, accountId: "pool-a" });

    // Source is gone from the CLI read path; the retired copy exists.
    expect(existsSync(authPath)).toBe(false);
    expect(existsSync(result.retiredTo)).toBe(true);

    // Pool credentials are byte-identical to the retired file's tokens — the
    // invariant that makes adoption race-safe against concurrent refreshes.
    const retired = JSON.parse(readFileSync(result.retiredTo, "utf-8")) as {
      tokens: { access_token: string; refresh_token: string };
    };
    const account = await loadAccount("openai-codex", "pool-a");
    expect(account?.credentials.access).toBe(retired.tokens.access_token);
    expect(account?.credentials.refresh).toBe(retired.tokens.refresh_token);
    expect(account?.credentials.idToken).toBe("id.token.codex");
    expect(result.organizationId).toBe("acct-abc");
  });

  it("adopts from the default CODEX_HOME when no explicit home is given", async () => {
    process.env.CODEX_HOME = path.join(home, ".codex");
    writeCodexAuth(process.env.CODEX_HOME, "rt.default-home");

    await adoptCodexCliLogin();

    expect(
      (await loadAccount("openai-codex", "default"))?.credentials.refresh,
    ).toBe("rt.default-home");
  });

  it("repeated adoption preserves every retired artifact (no-clobber retirement)", async () => {
    const codexHome = path.join(home, "codex");
    writeCodexAuth(codexHome, "refresh-first");
    const first = await adoptCodexCliLogin({ codexHome, accountId: "pool-a" });

    writeCodexAuth(codexHome, "refresh-second");
    const second = await adoptCodexCliLogin({
      codexHome,
      accountId: "pool-a",
      overwrite: true,
    });

    expect(first.retiredTo).not.toBe(second.retiredTo);
    expect(retiredFilesIn(codexHome)).toHaveLength(2);
    expect(readFileSync(first.retiredTo, "utf-8")).toContain("refresh-first");
    expect(readFileSync(second.retiredTo, "utf-8")).toContain("refresh-second");
    // The pool holds the latest adoption.
    expect(
      (await loadAccount("openai-codex", "pool-a"))?.credentials.refresh,
    ).toBe("refresh-second");
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
  ])(
    "rejects %s account id before any filesystem effect",
    async (_label, id) => {
      const codexHome = path.join(home, "codex");
      const authPath = writeCodexAuth(codexHome, "refresh-1");

      await expectAdoptError(
        async () => adoptCodexCliLogin({ codexHome, accountId: id }),
        "adopt_codex.invalid_account_id",
      );

      // The source was never touched.
      expect(existsSync(authPath)).toBe(true);
      expect(retiredFilesIn(codexHome)).toHaveLength(0);
    },
  );
});

describe("source validation", () => {
  it("classifies a missing source as no_source", async () => {
    await expectAdoptError(
      async () => adoptCodexCliLogin({ codexHome: path.join(home, "nope") }),
      "adopt_codex.no_source",
    );
  });

  it("classifies a permission failure as source_stat_failed, not absence", async () => {
    const codexHome = path.join(home, "codex");
    writeCodexAuth(codexHome, "refresh-1");
    chmodSync(codexHome, 0o000);
    try {
      await expectAdoptError(
        async () => adoptCodexCliLogin({ codexHome }),
        "adopt_codex.source_stat_failed",
      );
    } finally {
      chmodSync(codexHome, 0o755);
    }
  });

  it("refuses a symlinked auth.json and consumes nothing", async () => {
    const codexHome = path.join(home, "codex");
    mkdirSync(codexHome, { recursive: true });
    const real = path.join(home, "elsewhere.json");
    writeFileSync(real, codexAuthBody("refresh-1"));
    const link = path.join(codexHome, "auth.json");
    symlinkSync(real, link);

    await expectAdoptError(
      async () => adoptCodexCliLogin({ codexHome }),
      "adopt_codex.not_regular_file",
    );
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(real)).toBe(true);
    expect(await loadAccount("openai-codex", "default")).toBeNull();
  });

  it("restores the source when it is not valid JSON", async () => {
    const codexHome = path.join(home, "codex");
    mkdirSync(codexHome, { recursive: true });
    const authPath = path.join(codexHome, "auth.json");
    writeFileSync(authPath, "{not json");

    await expectAdoptError(
      async () => adoptCodexCliLogin({ codexHome }),
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
  ])("restores the source on %s", async (_label, body) => {
    const codexHome = path.join(home, "codex");
    mkdirSync(codexHome, { recursive: true });
    const authPath = path.join(codexHome, "auth.json");
    writeFileSync(authPath, body);

    await expectAdoptError(
      async () => adoptCodexCliLogin({ codexHome }),
      "adopt_codex.invalid_tokens",
    );
    // Full rollback: source back in place, nothing retired, nothing pooled.
    expect(existsSync(authPath)).toBe(true);
    expect(retiredFilesIn(codexHome)).toHaveLength(0);
    expect(await loadAccount("openai-codex", "default")).toBeNull();
  });
});

describe("pool collision", () => {
  it("refuses to overwrite an existing pool account and leaves the source untouched", async () => {
    const codexHome = path.join(home, "codex");
    writeCodexAuth(codexHome, "refresh-1");
    await adoptCodexCliLogin({ codexHome, accountId: "pool-a" });
    const authPath = writeCodexAuth(codexHome, "refresh-2");

    await expectAdoptError(
      async () => adoptCodexCliLogin({ codexHome, accountId: "pool-a" }),
      "adopt_codex.account_exists",
    );
    expect(existsSync(authPath)).toBe(true);
    expect(
      (await loadAccount("openai-codex", "pool-a"))?.credentials.refresh,
    ).toBe("refresh-1");
  });
});

describe("fault injection", () => {
  it("hard-fails retire when the source dir is not writable, committing nothing", async () => {
    const codexHome = path.join(home, "codex");
    const authPath = writeCodexAuth(codexHome, "refresh-1");
    chmodSync(codexHome, 0o555);
    try {
      await expectAdoptError(
        async () => adoptCodexCliLogin({ codexHome }),
        "adopt_codex.retire_failed",
      );
    } finally {
      chmodSync(codexHome, 0o755);
    }
    expect(existsSync(authPath)).toBe(true);
    expect(await loadAccount("openai-codex", "default")).toBeNull();
  });

  it("restores the source when the pool write fails", async () => {
    const codexHome = path.join(home, "codex");
    const authPath = writeCodexAuth(codexHome, "refresh-1");
    // Seed the auth-store dir, then drop its write bit so saveAccount fails.
    const authStoreDir = path.join(home, "auth");
    mkdirSync(authStoreDir, { recursive: true });
    chmodSync(authStoreDir, 0o555);
    try {
      const err = await expectAdoptError(
        async () => adoptCodexCliLogin({ codexHome }),
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

  it("restoreRetiredSource refuses to clobber an occupied original path", async () => {
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

  it("restoreRetiredSource moves the retired file back when the path is free", async () => {
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
  it.each([0, 100])(
    "detects a second process that recreates the source after retirement with a %i ms scheduling delay",
    async (writerDelayMs) => {
      const codexHome = path.join(home, "codex");
      const authPath = writeCodexAuth(codexHome, "refresh-base");
      const originalBody = readFileSync(authPath, "utf-8");
      const refreshedBody = codexAuthBody("concurrent-refresh");
      const recreatedMarker = path.join(home, "writer-recreated");

      // The child performs the real atomic replacement. Its completion marker
      // lets the parent resume adoption only after this interleaving occurred,
      // including when the OS delays scheduling the writer.
      const writerScript = `
        import { existsSync, writeFileSync, renameSync } from "node:fs";
        const [authPath, body, recreatedMarker, delay] = process.argv.slice(1);
        const sleeper = new Int32Array(new SharedArrayBuffer(4));
        process.stdout.write("ready\\n");
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (!existsSync(authPath)) {
            Atomics.wait(sleeper, 0, 0, Number(delay));
            const tmp = authPath + ".tmp";
            writeFileSync(tmp, body);
            renameSync(tmp, authPath);
            writeFileSync(recreatedMarker, "complete");
            process.exit(0);
          }
          Atomics.wait(sleeper, 0, 0, 5);
        }
        process.exit(2);
      `;
      const writer = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          writerScript,
          authPath,
          refreshedBody,
          recreatedMarker,
          String(writerDelayMs),
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      const writerReady = new Promise<void>((resolve, reject) => {
        writer.once("error", reject);
        writer.once("exit", (code) =>
          reject(new Error(`writer exited before readiness: ${code}`)),
        );
        writer.stdout.once("data", (chunk) => {
          if (!chunk.toString().includes("ready")) {
            reject(new Error("writer emitted an unexpected readiness message"));
            return;
          }
          resolve();
        });
      });
      const writerDone = new Promise<number | null>((resolve, reject) => {
        writer.once("error", reject);
        writer.once("exit", resolve);
      });
      const realRename = fs.renameSync;
      try {
        // Pause only after the real source retirement syscall. Synchronize the
        // named ESM binding used by adoption, and restore it in the finally.
        fs.renameSync = (source, destination) => {
          realRename(source, destination);
          if (source !== authPath) return;
          const deadline = Date.now() + 5000;
          const sleeper = new Int32Array(new SharedArrayBuffer(4));
          while (!existsSync(recreatedMarker)) {
            if (Date.now() >= deadline) {
              throw new Error("writer did not complete the atomic replacement");
            }
            Atomics.wait(sleeper, 0, 0, 5);
          }
        };
        syncBuiltinESMExports();
        await writerReady;
        const error = await expectAdoptError(
          async () => adoptCodexCliLogin({ codexHome, accountId: "race" }),
          "adopt_codex.concurrent_refresher",
        );
        expect(typeof error.context?.retiredTo).toBe("string");
        expect(readFileSync(String(error.context?.retiredTo), "utf-8")).toBe(
          originalBody,
        );
        expect(readFileSync(authPath, "utf-8")).toBe(refreshedBody);
        expect(await loadAccount("openai-codex", "race")).toBeNull();
        expect(await writerDone).toBe(0);
      } finally {
        fs.renameSync = realRename;
        syncBuiltinESMExports();
        if (writer.exitCode === null) writer.kill();
        await writerDone;
      }
    },
    15_000,
  );
});
