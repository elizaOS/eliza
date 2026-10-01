/**
 * Credential scoping for VFS Git remotes. Host GitHub credentials
 * (GITHUB_TOKEN / GITHUB_PAT) must only be offered to HTTPS github.com
 * remotes — never to an arbitrary user-supplied remote — and an empty
 * GITHUB_TOKEN must not shadow GITHUB_PAT. isomorphic-git is stubbed so the
 * test can capture the real onAuth callback built by the service.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PostWorkbenchVfsGitRequest } from "@elizaos/core";
import type { AuthCallback } from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gitMock = vi.hoisted(() => ({
  clone: vi.fn(),
  fetch: vi.fn(),
  currentBranch: vi.fn(),
}));

vi.mock("isomorphic-git", () => ({ default: gitMock }));
vi.mock("isomorphic-git/http/node", () => ({ default: {} }));

import { createVfsGitService } from "./vfs-git.ts";
import type { VirtualFilesystemService } from "./virtual-filesystem.ts";

const ENV_KEYS = ["GITHUB_TOKEN", "GITHUB_PAT"] as const;
const savedEnv: Record<string, string | undefined> = {};
let filesRoot: string;

function service() {
  const vfs = {
    filesRoot,
    withProjectOperation: <T>(op: () => Promise<T>) => op(),
  } as unknown as VirtualFilesystemService;
  return createVfsGitService(vfs);
}

async function captureCloneAuth(
  url: string,
  extra: Partial<PostWorkbenchVfsGitRequest> = {},
): Promise<AuthCallback | undefined> {
  await service().run({
    action: "clone",
    url,
    ...extra,
  } as PostWorkbenchVfsGitRequest);
  const call = gitMock.clone.mock.calls[0][0] as { onAuth?: AuthCallback };
  return call.onAuth;
}

async function authFor(onAuth: AuthCallback | undefined, url: string) {
  return onAuth ? await onAuth(url, {}) : undefined;
}

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  filesRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vfs-git-auth-"));
  gitMock.clone.mockReset().mockResolvedValue(undefined);
  gitMock.fetch.mockReset().mockResolvedValue({});
  gitMock.currentBranch.mockReset().mockResolvedValue("main");
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await fsp.rm(filesRoot, { recursive: true, force: true });
});

describe("VFS Git auth callback", () => {
  it("does not send the host GITHUB_TOKEN to a non-GitHub remote", async () => {
    process.env.GITHUB_TOKEN = "host-secret";
    const url = "https://attacker.example/repo.git";
    const onAuth = await captureCloneAuth(url);
    expect(await authFor(onAuth, url)).toBeUndefined();
  });

  it("does not send the host token to plain-HTTP github.com", async () => {
    process.env.GITHUB_TOKEN = "host-secret";
    const url = "http://github.com/org/repo.git";
    const onAuth = await captureCloneAuth(url);
    expect(await authFor(onAuth, url)).toBeUndefined();
  });

  it("does not send the host token to a github.com lookalike host", async () => {
    process.env.GITHUB_TOKEN = "host-secret";
    const url = "https://github.com.attacker.example/org/repo.git";
    const onAuth = await captureCloneAuth(url);
    expect(await authFor(onAuth, url)).toBeUndefined();
  });

  it("scopes fetch/push remotes by the URL isomorphic-git authenticates", async () => {
    process.env.GITHUB_TOKEN = "host-secret";
    await service().run({
      action: "fetch",
      remote: "origin",
    } as PostWorkbenchVfsGitRequest);
    const onAuth = (gitMock.fetch.mock.calls[0][0] as { onAuth?: AuthCallback })
      .onAuth;
    expect(
      await authFor(onAuth, "https://attacker.example/repo.git"),
    ).toBeUndefined();
    expect(await authFor(onAuth, "https://github.com/org/repo.git")).toEqual({
      username: "x-access-token",
      password: "host-secret",
    });
  });

  it("sends the host GITHUB_TOKEN to an HTTPS github.com remote", async () => {
    process.env.GITHUB_TOKEN = "host-secret";
    const url = "https://github.com/org/repo.git";
    const onAuth = await captureCloneAuth(url);
    expect(await authFor(onAuth, url)).toEqual({
      username: "x-access-token",
      password: "host-secret",
    });
  });

  it("treats an empty GITHUB_TOKEN as unset and falls back to GITHUB_PAT", async () => {
    process.env.GITHUB_TOKEN = "";
    process.env.GITHUB_PAT = "host-pat";
    const url = "https://github.com/org/repo.git";
    const onAuth = await captureCloneAuth(url);
    expect(await authFor(onAuth, url)).toEqual({
      username: "x-access-token",
      password: "host-pat",
    });
  });

  it("still sends request-supplied credentials to any HTTP(S) remote", async () => {
    process.env.GITHUB_TOKEN = "host-secret";
    const url = "https://git.example.com/repo.git";
    const onAuth = await captureCloneAuth(url, {
      auth: { token: "request-token" },
    } as Partial<PostWorkbenchVfsGitRequest>);
    expect(await authFor(onAuth, url)).toEqual({
      username: "x-access-token",
      password: "request-token",
    });
  });

  it("returns no callback when no credentials are configured", async () => {
    process.env.GITHUB_TOKEN = "  ";
    const onAuth = await captureCloneAuth("https://github.com/org/repo.git");
    expect(onAuth).toBeUndefined();
  });
});
