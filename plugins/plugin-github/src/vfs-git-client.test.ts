import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { resolveVfsGitAuth, VirtualGitClient } from "./vfs-git-client.js";

class MemoryVfs {
  files = new Map<string, Uint8Array>();

  async initialize(): Promise<void> {}

  async exportFiles() {
    return [...this.files.entries()].map(([path, bytes]) => ({
      path: `/${path}`,
      bytes,
    }));
  }

  async readFile(path: string): Promise<string> {
    const bytes = this.files.get(normalize(path));
    if (!bytes) throw new Error("not found");
    return Buffer.from(bytes).toString("utf-8");
  }

  async writeFile(path: string, contents: string | Uint8Array): Promise<void> {
    this.files.set(
      normalize(path),
      typeof contents === "string" ? Buffer.from(contents) : contents,
    );
  }

  async delete(path: string): Promise<void> {
    this.files.delete(normalize(path));
  }
}

function runtime(settings: Record<string, unknown>): IAgentRuntime {
  return Object.assign(Object.create(null) as IAgentRuntime, {
    character: {},
    getSetting: vi.fn((key: string) => {
      const value = settings[key];
      return typeof value === "string" ? value : null;
    }),
  });
}

describe("VirtualGitClient", () => {
  it("tracks VFS status and records virtual commits without host git", async () => {
    const vfs = new MemoryVfs();
    await vfs.writeFile("src/a.ts", "one");
    const client = new VirtualGitClient(vfs);

    expect(await client.status()).toMatchObject([
      { path: "src/a.ts", status: "added" },
    ]);

    const first = await client.commit({ message: "initial" });
    expect(first.parent).toBeNull();
    expect(await client.status()).toMatchObject([
      { path: "src/a.ts", status: "unchanged" },
    ]);

    await vfs.writeFile("src/a.ts", "two");
    await vfs.writeFile("src/b.ts", "new");
    expect(await client.status()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/a.ts", status: "modified" }),
        expect.objectContaining({ path: "src/b.ts", status: "added" }),
      ]),
    );

    const second = await client.commit({ message: "update" });
    expect(second.parent).toBe(first.id);
    await expect(client.log()).resolves.toMatchObject([
      { id: second.id, message: "update" },
      { id: first.id, message: "initial" },
    ]);
  });

  it("pushes VFS files through the GitHub git database API", async () => {
    const vfs = new MemoryVfs();
    await vfs.writeFile("src/a.ts", "one");
    const requests: Array<{ url: string; init?: { body?: string } }> = [];
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      requests.push({ url, init });
      if (url.endsWith("/git/ref/heads/main")) {
        return json({ object: { sha: "base-commit" } });
      }
      if (url.endsWith("/git/commits/base-commit")) {
        return json({ sha: "base-commit", tree: { sha: "base-tree" } });
      }
      if (url.endsWith("/git/trees/base-tree?recursive=1")) {
        return json({
          sha: "base-tree",
          tree: [{ path: "old.ts", type: "blob", sha: "old-blob" }],
        });
      }
      if (url.endsWith("/git/blobs")) {
        return json({ sha: "new-blob" });
      }
      if (url.endsWith("/git/trees")) {
        return json({ sha: "new-tree" });
      }
      if (url.endsWith("/git/commits")) {
        return json({ sha: "remote-commit" });
      }
      if (url.endsWith("/git/refs/heads/main")) {
        return json({ ref: "refs/heads/main" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await new VirtualGitClient(vfs).pushToGitHub({
      owner: "eliza",
      repo: "workspace",
      auth: { token: "oauth-or-pat" },
      message: "sync vfs",
      fetch,
    });

    expect(result).toMatchObject({
      branch: "main",
      commitSha: "remote-commit",
      changedFiles: 2,
    });
    expect(requests.at(-1)?.init?.body).toContain("remote-commit");
    const treeRequest = requests.find((request) =>
      request.url.endsWith("/git/trees"),
    );
    expect(treeRequest?.init?.body).toContain('"path":"src/a.ts"');
    expect(treeRequest?.init?.body).toContain('"path":"old.ts"');
    expect(treeRequest?.init?.body).toContain('"sha":null');
  });

  it("pulls GitHub tree contents into VFS and resets removed files", async () => {
    const vfs = new MemoryVfs();
    await vfs.writeFile("stale.ts", "remove me");
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/git/ref/heads/main")) {
        return json({ object: { sha: "remote-commit" } });
      }
      if (url.endsWith("/git/commits/remote-commit")) {
        return json({ sha: "remote-commit", tree: { sha: "remote-tree" } });
      }
      if (url.endsWith("/git/trees/remote-tree?recursive=1")) {
        return json({
          sha: "remote-tree",
          tree: [{ path: "src/a.ts", type: "blob", sha: "blob-a" }],
        });
      }
      if (url.endsWith("/git/blobs/blob-a")) {
        return json({
          sha: "blob-a",
          content: Buffer.from("remote").toString("base64"),
          encoding: "base64",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await new VirtualGitClient(vfs).pullFromGitHub({
      owner: "eliza",
      repo: "workspace",
      auth: { token: "oauth-or-pat" },
      fetch,
    });

    expect(result).toMatchObject({
      branch: "main",
      commitSha: "remote-commit",
      filesWritten: 1,
      filesDeleted: 1,
    });
    await expect(vfs.readFile("src/a.ts")).resolves.toBe("remote");
    await expect(vfs.readFile("stale.ts")).rejects.toThrow("not found");
  });
});

describe("resolveVfsGitAuth", () => {
  it("uses PAT-backed accounts when configured locally", async () => {
    const auth = await resolveVfsGitAuth(
      runtime({ GITHUB_USER_PAT: "pat-token" }),
      { role: "user" },
    );
    expect(auth).toMatchObject({
      source: "pat",
      token: "pat-token",
      accountId: "user",
      role: "user",
    });
  });
});

function normalize(path: string): string {
  return path.replace(/^\/+/, "");
}

function json(data: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}
