/**
 * Unit tests for the CLI-login importer: mapping the Codex/Claude CLI blob
 * shapes into canonical account records, idempotency, and non-destructiveness.
 * Uses a temp ELIZA_HOME so the real store is never touched.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAccount } from "../account-storage.ts";
import { importCodexCliLogin, importClaudeCliLogin } from "./import-cli-logins.ts";

let home: string;
let prevHome: string | undefined;
let prevElizaHome: string | undefined;

function makeJwt(expSeconds: number): string {
  const b = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "RS256" })}.${b({ exp: expSeconds })}.sig`;
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "auth-import-"));
  prevHome = process.env.HOME;
  prevElizaHome = process.env.ELIZA_HOME;
  process.env.HOME = home;
  process.env.ELIZA_HOME = home; // authRoot() → <ELIZA_HOME>/auth
  delete process.env.CODEX_HOME;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevElizaHome === undefined) delete process.env.ELIZA_HOME;
  else process.env.ELIZA_HOME = prevElizaHome;
});

describe("importCodexCliLogin", () => {
  it("maps ~/.codex/auth.json (chatgpt mode) into an openai-codex account", () => {
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    const exp = Math.floor(Date.now() / 1000) + 3600;
    writeFileSync(
      path.join(home, ".codex", "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: makeJwt(exp),
          refresh_token: "rt.1.CODEX",
          id_token: "id.token.codex",
          account_id: "acct-123",
        },
        last_refresh: new Date().toISOString(),
      }),
    );
    const r = importCodexCliLogin();
    expect(r.imported).toBe(true);
    const rec = loadAccount("openai-codex", "default");
    expect(rec?.credentials.refresh).toBe("rt.1.CODEX");
    expect(rec?.credentials.idToken).toBe("id.token.codex"); // required for CODEX_HOME
    expect(rec?.organizationId).toBe("acct-123");
    expect(rec?.credentials.expires).toBe(exp * 1000);
  });

  it("is idempotent when the store already holds the same refresh token", () => {
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    const auth = JSON.stringify({
      tokens: { access_token: makeJwt(9e9), refresh_token: "rt.same", id_token: "x" },
      last_refresh: new Date().toISOString(),
    });
    writeFileSync(path.join(home, ".codex", "auth.json"), auth);
    expect(importCodexCliLogin().imported).toBe(true);
    expect(importCodexCliLogin().imported).toBe(false); // already current
  });

  it("returns imported=false with a reason when no login file exists", () => {
    expect(importCodexCliLogin().imported).toBe(false);
  });
});

describe("importClaudeCliLogin", () => {
  it("maps a FLAT ~/.claude/.credentials.json into an anthropic-subscription account", () => {
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        accessToken: "acc.flat",
        refreshToken: "rt.flat",
        expiresAt: Date.now() + 3600_000,
        subscriptionType: "max",
      }),
    );
    const r = importClaudeCliLogin();
    expect(r.imported).toBe(true);
    const rec = loadAccount("anthropic-subscription", "default");
    expect(rec?.credentials.access).toBe("acc.flat");
    expect(rec?.credentials.refresh).toBe("rt.flat");
    // Non-destructive: source file survives.
    expect(existsSync(path.join(home, ".claude", ".credentials.json"))).toBe(true);
  });

  it("also maps the NESTED claudeAiOauth wrapper shape", () => {
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "acc.nested", refreshToken: "rt.nested", expiresAt: 1 },
      }),
    );
    expect(importClaudeCliLogin().imported).toBe(true);
    expect(loadAccount("anthropic-subscription", "default")?.credentials.access).toBe(
      "acc.nested",
    );
  });
});
