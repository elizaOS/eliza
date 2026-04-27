/**
 * Unit tests for github-credentials.ts — the on-disk PAT store backing
 * Settings → Coding Agents → GitHub.
 *
 * Covers:
 * - loadCredentials returns null when the file is missing
 * - loadCredentials returns null when the file is malformed JSON
 * - loadCredentials returns null when fields are wrong-shape
 * - saveCredentials → loadCredentials roundtrip preserves all fields
 * - loadMetadata strips the token
 * - clearCredentials deletes the file (and is idempotent on missing files)
 * - saveCredentials writes mode-0600 with parent-dir mode-0700
 * - applySavedTokenToEnv copies into process.env when unset
 * - applySavedTokenToEnv leaves an existing env var untouched
 * - applySavedTokenToEnv reports correctly when no credential is saved
 *
 * Each test points the resolver at a unique tmp dir via MILADY_STATE_DIR
 * so concurrent test runs never share on-disk state.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resolveStateDirForTests,
  applySavedTokenToEnv,
  buildCredentialsFromUserResponse,
  clearCredentials,
  getCredentialFilePath,
  loadCredentials,
  loadMetadata,
  saveCredentials,
} from "./github-credentials";

let tempDir: string;
let originalStateDir: string | undefined;
let originalElizaStateDir: string | undefined;
let originalToken: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "milady-github-credentials-"),
  );
  originalStateDir = process.env.MILADY_STATE_DIR;
  originalElizaStateDir = process.env.ELIZA_STATE_DIR;
  originalToken = process.env.GITHUB_TOKEN;
  process.env.MILADY_STATE_DIR = tempDir;
  delete process.env.ELIZA_STATE_DIR;
  delete process.env.GITHUB_TOKEN;
});

afterEach(async () => {
  if (originalStateDir === undefined) {
    delete process.env.MILADY_STATE_DIR;
  } else {
    process.env.MILADY_STATE_DIR = originalStateDir;
  }
  if (originalElizaStateDir === undefined) {
    delete process.env.ELIZA_STATE_DIR;
  } else {
    process.env.ELIZA_STATE_DIR = originalElizaStateDir;
  }
  if (originalToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalToken;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("github-credentials state-dir resolution", () => {
  it("resolves under MILADY_STATE_DIR when set", () => {
    expect(_resolveStateDirForTests()).toBe(tempDir);
    expect(getCredentialFilePath()).toBe(
      path.join(tempDir, "credentials", "github.json"),
    );
  });
});

describe("loadCredentials", () => {
  it("returns null when the file does not exist", async () => {
    expect(await loadCredentials()).toBeNull();
  });

  it("returns null when the file is malformed JSON", async () => {
    const filePath = getCredentialFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{ not json", "utf-8");
    expect(await loadCredentials()).toBeNull();
  });

  it("returns null when the record is wrong-shape", async () => {
    const filePath = getCredentialFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({ token: "x", username: 42, scopes: [], savedAt: 0 }),
    );
    expect(await loadCredentials()).toBeNull();
  });
});

describe("saveCredentials → loadCredentials roundtrip", () => {
  it("preserves token, username, scopes, savedAt", async () => {
    const record = buildCredentialsFromUserResponse(
      "ghp_test_token",
      { login: "octocat" },
      ["repo", "read:user"],
      1_700_000_000_000,
    );
    await saveCredentials(record);
    const loaded = await loadCredentials();
    expect(loaded).toEqual(record);
  });

  it("loadMetadata strips the token", async () => {
    const record = buildCredentialsFromUserResponse(
      "ghp_test_token",
      { login: "octocat" },
      ["repo"],
      1_700_000_000_000,
    );
    await saveCredentials(record);
    const meta = await loadMetadata();
    expect(meta).toEqual({
      username: "octocat",
      scopes: ["repo"],
      savedAt: 1_700_000_000_000,
    });
  });

  it("writes the credential file mode 0600", async () => {
    await saveCredentials(
      buildCredentialsFromUserResponse("t", { login: "u" }, [], 1),
    );
    const stat = await fs.stat(getCredentialFilePath());
    expect((stat.mode & 0o777).toString(8)).toBe("600");
  });

  it("creates the parent directory mode 0700", async () => {
    await saveCredentials(
      buildCredentialsFromUserResponse("t", { login: "u" }, [], 1),
    );
    const stat = await fs.stat(path.dirname(getCredentialFilePath()));
    expect((stat.mode & 0o777).toString(8)).toBe("700");
  });
});

describe("clearCredentials", () => {
  it("removes the file when present", async () => {
    await saveCredentials(
      buildCredentialsFromUserResponse("t", { login: "u" }, [], 1),
    );
    await clearCredentials();
    expect(await loadCredentials()).toBeNull();
  });

  it("is idempotent when no file is saved", async () => {
    await expect(clearCredentials()).resolves.toBeUndefined();
  });
});

describe("applySavedTokenToEnv", () => {
  it("copies the saved token into process.env when GITHUB_TOKEN is unset", async () => {
    await saveCredentials(
      buildCredentialsFromUserResponse(
        "ghp_token",
        { login: "octocat" },
        ["repo"],
        1,
      ),
    );
    const result = await applySavedTokenToEnv();
    expect(result).toEqual({
      applied: true,
      envAlreadySet: false,
      username: "octocat",
    });
    expect(process.env.GITHUB_TOKEN).toBe("ghp_token");
  });

  it("leaves an existing GITHUB_TOKEN untouched (explicit env wins)", async () => {
    process.env.GITHUB_TOKEN = "ghp_user_explicit";
    await saveCredentials(
      buildCredentialsFromUserResponse("ghp_saved", { login: "u" }, [], 1),
    );
    const result = await applySavedTokenToEnv();
    expect(result).toEqual({ applied: false, envAlreadySet: true });
    expect(process.env.GITHUB_TOKEN).toBe("ghp_user_explicit");
  });

  it("reports applied=false when no credential is saved", async () => {
    const result = await applySavedTokenToEnv();
    expect(result).toEqual({ applied: false, envAlreadySet: false });
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
  });
});
