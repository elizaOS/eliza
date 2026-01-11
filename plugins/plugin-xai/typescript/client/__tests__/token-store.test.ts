import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileTokenStore, RuntimeCacheTokenStore } from "../auth-providers/token-store";

describe("token-store", () => {
  describe("FileTokenStore", () => {
    it("roundtrips save/load", async () => {
      const path = join(tmpdir(), `x-oauth2-tokens-${Date.now()}.json`);
      const store = new FileTokenStore(path);

      const tokens = {
        access_token: "access",
        refresh_token: "refresh",
        expires_at: Date.now() + 60_000,
        scope: "post.read",
        token_type: "bearer",
      };

      await store.save(tokens);
      const loaded = await store.load();
      expect(loaded).toEqual(tokens);

      await store.clear();
      const cleared = await store.load();
      expect(cleared).toBeNull();
    });

    it("returns null for corrupted json", async () => {
      const path = join(tmpdir(), `x-oauth2-tokens-${Date.now()}-bad.json`);
      await fs.writeFile(path, "{ not json", "utf-8");

      const store = new FileTokenStore(path);
      const loaded = await store.load();
      expect(loaded).toBeNull();

      await store.clear();
    });
  });

  describe("RuntimeCacheTokenStore", () => {
    let runtime: Partial<IAgentRuntime> & {
      getCache: (key: string) => Promise<unknown>;
      setCache: (key: string, value: unknown) => Promise<void>;
    };

    beforeEach(() => {
      const cache = new Map<string, unknown>();
      runtime = {
        agentId: "agent-123" as UUID,
        getCache: vi.fn(async (k: string) => cache.get(k)),
        setCache: vi.fn(async (k: string, v: unknown) => {
          cache.set(k, v);
        }),
      };
    });

    it("saves and loads via runtime cache", async () => {
      const store = new RuntimeCacheTokenStore(runtime);
      const tokens = {
        access_token: "a",
        refresh_token: "r",
        expires_at: 123,
      };

      await store.save(tokens);
      const loaded = await store.load();
      expect(loaded).toEqual(tokens);
      expect(runtime.setCache).toHaveBeenCalled();
      expect(runtime.getCache).toHaveBeenCalled();
    });

    it("clear removes the cached value (via undefined)", async () => {
      const store = new RuntimeCacheTokenStore(runtime);
      await store.save({
        access_token: "a",
        refresh_token: "r",
        expires_at: 123,
      });

      await store.clear();
      const loaded = await store.load();
      expect(loaded).toBeNull();
      expect(runtime.setCache).toHaveBeenCalledWith(expect.any(String), undefined);
    });
  });
});
