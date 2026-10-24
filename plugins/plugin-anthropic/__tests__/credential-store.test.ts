/**
 * The app-managed credential reader must tell "not here" apart from
 * "here but unreadable". The sibling reader for `~/.claude/.credentials.json`
 * already does: ENOENT is absent, other read failures and invalid JSON are
 * typed errors (`CREDENTIALS_UNREADABLE` / `CREDENTIALS_CORRUPT`). This file
 * keeps the app-managed path on that same contract, without losing a usable
 * token from another source.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getClaudeOAuthToken } from "../utils/credential-store.ts";

const ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_SUBSCRIPTION_ACCOUNT_ID",
  "CLAUDE_CONFIG_DIR",
  "ELIZA_STATE_DIR",
] as const;

let saved: Record<string, string | undefined>;
let stateDir: string;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  stateDir = mkdtempSync(join(tmpdir(), "anthropic-cred-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(stateDir, { recursive: true, force: true });
});

function writeAppToken(contents: string): void {
  const authDir = join(stateDir, "auth", "anthropic-subscription");
  mkdirSync(authDir, { recursive: true });
  writeFileSync(join(authDir, "default.json"), contents);
}

describe("app-managed Anthropic credential reading", () => {
  it("reports a corrupt credential file instead of treating it as absent", () => {
    writeAppToken('{"credentials":{"access":"tok');

    let error: unknown;
    try {
      getClaudeOAuthToken();
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe("CREDENTIALS_CORRUPT");
  });

  it("still uses another configured token when the credential file is corrupt", () => {
    writeAppToken("not json");
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-token";

    expect(getClaudeOAuthToken().accessToken).toBe("env-token");
  });
});
