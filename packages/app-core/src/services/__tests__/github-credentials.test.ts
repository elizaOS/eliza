import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFs } = vi.hoisted(() => ({
  mockFs: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
    mkdir: vi.fn(),
    chmod: vi.fn(),
  },
}));
vi.mock("node:fs/promises", () => ({ default: mockFs, ...mockFs }));

const MOCK_STATE_DIR = "/tmp/fake-state";
vi.mock("@elizaos/core", () => ({
  resolveStateDir: () => MOCK_STATE_DIR,
}));

import {
  GitHubCredentials,
  applySavedTokenToEnv,
  buildCredentialsFromUserResponse,
  clearCredentials,
  getCredentialFilePath,
  loadCredentials,
  loadMetadata,
  saveCredentials,
} from "./github-credentials.ts";

const creds: GitHubCredentials = {
  token: "ghp_abc",
  username: "alice",
  scopes: ["repo", "read:org"],
  savedAt: 1700000000000,
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.GITHUB_TOKEN;
});

describe("getCredentialFilePath", () => {
  it("resolves under the state dir credentials folder", () => {
    expect(getCredentialFilePath()).toBe(
      `${MOCK_STATE_DIR}/credentials/github.json`,
    );
  });
});

describe("buildCredentialsFromUserResponse", () => {
  it("builds the record from a GitHub user response", () => {
    const record = buildCredentialsFromUserResponse(
      "ghp_abc",
      { login: "alice" },
      ["repo"],
      123,
    );
    expect(record).toEqual({
      token: "ghp_abc",
      username: "alice",
      scopes: ["repo"],
      savedAt: 123,
    });
  });
});

describe("loadCredentials", () => {
  it("returns null on missing file", async () => {
    mockFs.readFile.mockRejectedValue({ code: "ENOENT" });
    expect(await loadCredentials()).toBeNull();
  });

  it("returns null on invalid JSON", async () => {
    mockFs.readFile.mockResolvedValue("not json");
    expect(await loadCredentials()).toBeNull();
  });

  it("returns null on shape mismatch", async () => {
    mockFs.readFile.mockResolvedValue(JSON.stringify({ token: 5 }));
    expect(await loadCredentials()).toBeNull();
  });

  it("returns credentials on valid content", async () => {
    mockFs.readFile.mockResolvedValue(JSON.stringify(creds));
    expect(await loadCredentials()).toEqual(creds);
  });
});

describe("loadMetadata", () => {
  it("strips the token", async () => {
    mockFs.readFile.mockResolvedValue(JSON.stringify(creds));
    const metadata = await loadMetadata();
    expect(metadata).not.toHaveProperty("token");
    expect(metadata?.username).toBe("alice");
  });

  it("returns null when nothing saved", async () => {
    mockFs.readFile.mockRejectedValue({ code: "ENOENT" });
    expect(await loadMetadata()).toBeNull();
  });
});

describe("saveCredentials", () => {
  it("writes atomically via temp file + rename", async () => {
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.chmod.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined);
    await saveCredentials(creds);
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining(".tmp"),
      expect.stringContaining("ghp_abc"),
      { mode: 0o600 },
    );
    expect(mockFs.rename).toHaveBeenCalledTimes(1);
  });
});

describe("clearCredentials", () => {
  it("succeeds silently on ENOENT", async () => {
    mockFs.unlink.mockRejectedValue({ code: "ENOENT" });
    await expect(clearCredentials()).resolves.toBeUndefined();
  });

  it("propagates other errors", async () => {
    mockFs.unlink.mockRejectedValue(new Error("EACCES"));
    await expect(clearCredentials()).rejects.toThrow("EACCES");
  });
});

describe("applySavedTokenToEnv", () => {
  it("skips when GITHUB_TOKEN is already set", async () => {
    process.env.GITHUB_TOKEN = "explicit";
    const result = await applySavedTokenToEnv();
    expect(result).toEqual({ applied: false, envAlreadySet: true });
    expect(mockFs.readFile).not.toHaveBeenCalled();
  });

  it("applies the saved token when env is empty", async () => {
    mockFs.readFile.mockResolvedValue(JSON.stringify(creds));
    const result = await applySavedTokenToEnv();
    expect(result.applied).toBe(true);
    expect(result.username).toBe("alice");
    expect(process.env.GITHUB_TOKEN).toBe("ghp_abc");
  });

  it("no-op when nothing saved", async () => {
    mockFs.readFile.mockRejectedValue({ code: "ENOENT" });
    const result = await applySavedTokenToEnv();
    expect(result).toEqual({ applied: false, envAlreadySet: false });
  });
});
