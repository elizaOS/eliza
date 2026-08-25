/**
 * Unit tests for the local GitHub PAT store. Exercises path resolution,
 * load/save/clear against a real temp `ELIZA_STATE_DIR`, metadata stripping,
 * user-response mapping, and `GITHUB_TOKEN` env application. Deterministic
 * and unmocked — the real module writes and reads on-disk JSON.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resolveStateDirForTests,
  applySavedTokenToEnv,
  buildCredentialsFromUserResponse,
  clearCredentials,
  type GitHubCredentials,
  getCredentialFilePath,
  loadCredentials,
  loadMetadata,
  saveCredentials,
} from "./github-credentials";

function sampleCreds(
  overrides: Partial<GitHubCredentials> = {},
): GitHubCredentials {
  return {
    token: "ghp_test_token_abc",
    username: "octocat",
    scopes: ["repo", "read:user"],
    savedAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function writeRaw(filePath: string, body: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, body, "utf-8");
}

describe("github-credentials", () => {
  let previousStateDir: string | undefined;
  let previousGithubToken: string | undefined;
  let stateDir: string;

  beforeEach(() => {
    previousStateDir = process.env.ELIZA_STATE_DIR;
    previousGithubToken = process.env.GITHUB_TOKEN;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "github-creds-"));
    process.env.ELIZA_STATE_DIR = stateDir;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = previousStateDir;
    }
    if (previousGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previousGithubToken;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  describe("path resolution", () => {
    it("places github.json under <state-dir>/credentials", () => {
      expect(_resolveStateDirForTests()).toBe(stateDir);
      expect(getCredentialFilePath()).toBe(
        path.join(stateDir, "credentials", "github.json"),
      );
    });
  });

  describe("loadCredentials", () => {
    it("returns null when no credential file exists", async () => {
      expect(await loadCredentials()).toBeNull();
    });

    it("returns null when the file is unreadable", async () => {
      const filePath = getCredentialFilePath();
      await writeRaw(filePath, JSON.stringify(sampleCreds()));
      await fs.promises.chmod(filePath, 0o000);
      try {
        expect(await loadCredentials()).toBeNull();
      } finally {
        await fs.promises.chmod(filePath, 0o600);
      }
    });

    it("returns null for invalid JSON", async () => {
      await writeRaw(getCredentialFilePath(), "{not-json");
      expect(await loadCredentials()).toBeNull();
    });

    it("returns null for JSON that is not an object", async () => {
      await writeRaw(getCredentialFilePath(), "null");
      expect(await loadCredentials()).toBeNull();

      await writeRaw(getCredentialFilePath(), '"a-string"');
      expect(await loadCredentials()).toBeNull();

      await writeRaw(getCredentialFilePath(), "[]");
      expect(await loadCredentials()).toBeNull();
    });

    it("returns null when required fields have the wrong types", async () => {
      const filePath = getCredentialFilePath();
      const valid = sampleCreds();

      await writeRaw(filePath, JSON.stringify({ ...valid, token: 123 }));
      expect(await loadCredentials()).toBeNull();

      await writeRaw(filePath, JSON.stringify({ ...valid, username: null }));
      expect(await loadCredentials()).toBeNull();

      await writeRaw(filePath, JSON.stringify({ ...valid, scopes: "repo" }));
      expect(await loadCredentials()).toBeNull();

      await writeRaw(
        filePath,
        JSON.stringify({ ...valid, savedAt: "1700000000000" }),
      );
      expect(await loadCredentials()).toBeNull();
    });

    it("returns null when scopes contains a non-string", async () => {
      await writeRaw(
        getCredentialFilePath(),
        JSON.stringify(
          sampleCreds({ scopes: ["repo", 1] as unknown as string[] }),
        ),
      );
      expect(await loadCredentials()).toBeNull();
    });

    it("accepts an empty scopes array and empty string fields", async () => {
      const creds = sampleCreds({
        token: "",
        username: "",
        scopes: [],
      });
      await writeRaw(getCredentialFilePath(), JSON.stringify(creds));
      expect(await loadCredentials()).toEqual(creds);
    });

    it("round-trips a valid record including extra JSON properties", async () => {
      const creds = sampleCreds();
      await writeRaw(
        getCredentialFilePath(),
        JSON.stringify({ ...creds, extra: "kept" }),
      );
      expect(await loadCredentials()).toEqual({ ...creds, extra: "kept" });
    });
  });

  describe("loadMetadata", () => {
    it("returns null when credentials are missing", async () => {
      expect(await loadMetadata()).toBeNull();
    });

    it("omits the token and keeps username, scopes, and savedAt", async () => {
      const creds = sampleCreds();
      await saveCredentials(creds);
      const metadata = await loadMetadata();
      expect(metadata).toEqual({
        username: creds.username,
        scopes: creds.scopes,
        savedAt: creds.savedAt,
      });
      expect(metadata).not.toHaveProperty("token");
    });
  });

  describe("saveCredentials", () => {
    it("creates the credentials directory at mode 0700 and the file at 0600", async () => {
      const creds = sampleCreds();
      await saveCredentials(creds);

      const filePath = getCredentialFilePath();
      const directory = path.dirname(filePath);
      const dirStat = await fs.promises.stat(directory);
      const fileStat = await fs.promises.stat(filePath);
      expect(dirStat.mode & 0o777).toBe(0o700);
      expect(fileStat.mode & 0o777).toBe(0o600);
      expect(await loadCredentials()).toEqual(creds);
    });

    it("pretty-prints JSON and leaves no temp siblings after rename", async () => {
      const creds = sampleCreds();
      await saveCredentials(creds);

      const filePath = getCredentialFilePath();
      const raw = await fs.promises.readFile(filePath, "utf-8");
      expect(raw).toBe(JSON.stringify(creds, null, 2));

      const siblings = await fs.promises.readdir(path.dirname(filePath));
      expect(siblings).toEqual(["github.json"]);
    });

    it("overwrites the previous single-token record", async () => {
      await saveCredentials(sampleCreds({ token: "first", username: "one" }));
      const second = sampleCreds({
        token: "second",
        username: "two",
        scopes: ["gist"],
        savedAt: 1_800_000_000_000,
      });
      await saveCredentials(second);
      expect(await loadCredentials()).toEqual(second);
    });
  });

  describe("clearCredentials", () => {
    it("removes a saved credential file", async () => {
      await saveCredentials(sampleCreds());
      expect(fs.existsSync(getCredentialFilePath())).toBe(true);
      await clearCredentials();
      expect(fs.existsSync(getCredentialFilePath())).toBe(false);
      expect(await loadCredentials()).toBeNull();
    });

    it("succeeds silently when nothing is saved", async () => {
      await expect(clearCredentials()).resolves.toBeUndefined();
      expect(fs.existsSync(getCredentialFilePath())).toBe(false);
    });

    it("propagates non-ENOENT filesystem errors", async () => {
      const filePath = getCredentialFilePath();
      await fs.promises.mkdir(filePath, { recursive: true });
      await expect(clearCredentials()).rejects.toMatchObject({
        code: expect.stringMatching(/^(EISDIR|EPERM)$/),
      });
    });
  });

  describe("buildCredentialsFromUserResponse", () => {
    it("maps token, login, scopes, and an explicit timestamp", () => {
      expect(
        buildCredentialsFromUserResponse(
          "ghp_from_api",
          { login: "monalisa" },
          ["user:email"],
          42,
        ),
      ).toEqual({
        token: "ghp_from_api",
        username: "monalisa",
        scopes: ["user:email"],
        savedAt: 42,
      });
    });

    it("defaults savedAt to Date.now() when now is omitted", () => {
      const before = Date.now();
      const built = buildCredentialsFromUserResponse("t", { login: "u" }, []);
      const after = Date.now();
      expect(built.token).toBe("t");
      expect(built.username).toBe("u");
      expect(built.scopes).toEqual([]);
      expect(built.savedAt).toBeGreaterThanOrEqual(before);
      expect(built.savedAt).toBeLessThanOrEqual(after);
    });
  });

  describe("applySavedTokenToEnv", () => {
    it("leaves an explicit GITHUB_TOKEN untouched", async () => {
      process.env.GITHUB_TOKEN = "already-set";
      await saveCredentials(sampleCreds({ token: "from-disk" }));
      expect(await applySavedTokenToEnv()).toEqual({
        applied: false,
        envAlreadySet: true,
      });
      expect(process.env.GITHUB_TOKEN).toBe("already-set");
    });

    it("treats a whitespace-only GITHUB_TOKEN as unset", async () => {
      process.env.GITHUB_TOKEN = "  \t";
      await saveCredentials(sampleCreds({ token: "from-disk" }));
      expect(await applySavedTokenToEnv()).toEqual({
        applied: true,
        envAlreadySet: false,
        username: "octocat",
      });
      expect(process.env.GITHUB_TOKEN).toBe("from-disk");
    });

    it("does not apply when no credential file exists", async () => {
      expect(await applySavedTokenToEnv()).toEqual({
        applied: false,
        envAlreadySet: false,
      });
      expect(process.env.GITHUB_TOKEN).toBeUndefined();
    });

    it("copies the saved token into GITHUB_TOKEN and reports the username", async () => {
      await saveCredentials(
        sampleCreds({ token: "ghp_applied", username: "hubot" }),
      );
      expect(await applySavedTokenToEnv()).toEqual({
        applied: true,
        envAlreadySet: false,
        username: "hubot",
      });
      expect(process.env.GITHUB_TOKEN).toBe("ghp_applied");
    });
  });
});
