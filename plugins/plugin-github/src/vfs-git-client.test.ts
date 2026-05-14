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
