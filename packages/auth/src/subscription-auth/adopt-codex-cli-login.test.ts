/**
 * adoptCodexCliLogin is a transactional operation: on success the pool account
 * exists AND the source ~/.codex/auth.json is retired (renamed out of the CLI
 * read path); on any failure nothing is committed. Tests use a temp ELIZA_HOME
 * so the real store is never touched, and include the two-process exclusivity
 * proof — after adoption, a second reader of the original path finds no source
 * to refresh.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAccount } from "../account-storage.ts";
import {
  AdoptCodexError,
  adoptCodexCliLogin,
} from "./adopt-codex-cli-login.ts";

let home: string;
let prevHome: string | undefined;
let prevElizaHome: string | undefined;
let prevCodexHome: string | undefined;

function makeJwt(expSeconds: number): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "RS256" })}.${b({ exp: expSeconds })}.sig`;
}

function writeCodexAuth(dir: string, refresh: string): string {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "auth.json");
  writeFileSync(
    p,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: refresh,
        id_token: "id.token.codex",
        account_id: "acct-abc",
      },
      last_refresh: new Date().toISOString(),
    }),
  );
  return p;
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "adopt-codex-"));
  prevHome = process.env.HOME;
  prevElizaHome = process.env.ELIZA_HOME;
  prevCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  process.env.ELIZA_HOME = home; // authRoot() → <ELIZA_HOME>/auth
  process.env.CODEX_HOME = path.join(home, ".codex");
});
afterEach(() => {
  for (const [k, v] of [
    ["HOME", prevHome],
    ["ELIZA_HOME", prevElizaHome],
    ["CODEX_HOME", prevCodexHome],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("adoptCodexCliLogin", () => {
  it("writes the pool account AND retires the source (exclusive ownership)", () => {
    const src = writeCodexAuth(path.join(home, ".codex"), "rt.1.ORIGINAL");
    const res = adoptCodexCliLogin();
    // Pool account written with the tokens + id_token + org id.
    const rec = loadAccount("openai-codex", "default");
    expect(rec?.credentials.refresh).toBe("rt.1.ORIGINAL");
    expect(rec?.credentials.idToken).toBe("id.token.codex");
    expect(rec?.organizationId).toBe("acct-abc");
    // Source retired: original path gone, retiredTo present.
    expect(existsSync(src)).toBe(false);
    expect(existsSync(res.retiredTo)).toBe(true);
  });

  it("PROVES the retired source cannot refresh: a second reader finds no source", () => {
    const src = writeCodexAuth(path.join(home, ".codex"), "rt.1.ONETIME");
    adoptCodexCliLogin();
    // Simulate a second process (an interactive `codex`, or a stale refresher)
    // reading the CLI's canonical path AFTER adoption. It must find nothing —
    // there is no live token there to replay-and-revoke the pool-owned chain.
    expect(existsSync(src)).toBe(false);
    expect(() => readFileSync(src, "utf-8")).toThrow();
    // The pool is the sole holder of the refresh token.
    expect(loadAccount("openai-codex", "default")?.credentials.refresh).toBe(
      "rt.1.ONETIME",
    );
  });

  it("refuses to overwrite an existing pool account without overwrite", () => {
    writeCodexAuth(path.join(home, ".codex"), "rt.first");
    adoptCodexCliLogin();
    // A new source appears; adopting again without overwrite must fail AND must
    // NOT retire the new source (nothing committed).
    const src2 = writeCodexAuth(path.join(home, ".codex"), "rt.second");
    expect(() => adoptCodexCliLogin()).toThrow(AdoptCodexError);
    try {
      adoptCodexCliLogin();
    } catch (e) {
      expect((e as AdoptCodexError).code).toBe("account_exists");
    }
    expect(existsSync(src2)).toBe(true); // not retired
  });

  it("overwrites when explicitly allowed", () => {
    writeCodexAuth(path.join(home, ".codex"), "rt.old");
    adoptCodexCliLogin();
    writeCodexAuth(path.join(home, ".codex"), "rt.new");
    adoptCodexCliLogin({ overwrite: true });
    expect(loadAccount("openai-codex", "default")?.credentials.refresh).toBe(
      "rt.new",
    );
  });

  it("refuses a symlink source (not a regular file) and commits nothing", () => {
    const realDir = path.join(home, "elsewhere");
    const real = writeCodexAuth(realDir, "rt.sneaky");
    const codexDir = path.join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const link = path.join(codexDir, "auth.json");
    symlinkSync(real, link);
    expect(() => adoptCodexCliLogin()).toThrow(AdoptCodexError);
    try {
      adoptCodexCliLogin();
    } catch (e) {
      expect((e as AdoptCodexError).code).toBe("not_regular_file");
    }
    // The symlink and its target are untouched; no pool account written.
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(real)).toBe(true);
    expect(loadAccount("openai-codex", "default")).toBeNull();
  });

  it("errors clearly when there is no source", () => {
    expect(() => adoptCodexCliLogin()).toThrow(AdoptCodexError);
    try {
      adoptCodexCliLogin();
    } catch (e) {
      expect((e as AdoptCodexError).code).toBe("no_source");
    }
  });

  it("errors on a source missing tokens without retiring it", () => {
    const codexDir = path.join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const p = path.join(codexDir, "auth.json");
    writeFileSync(p, JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));
    expect(() => adoptCodexCliLogin()).toThrow(AdoptCodexError);
    expect(existsSync(p)).toBe(true); // not retired
  });

  it("adopts from an explicit codexHome without touching process CODEX_HOME", () => {
    const acct2 = path.join(home, ".codex-acct2");
    writeCodexAuth(acct2, "rt.acct2");
    const res = adoptCodexCliLogin({ accountId: "codex2", codexHome: acct2 });
    expect(res.accountId).toBe("codex2");
    expect(loadAccount("openai-codex", "codex2")?.credentials.refresh).toBe(
      "rt.acct2",
    );
    expect(existsSync(path.join(acct2, "auth.json"))).toBe(false); // retired
  });
});
