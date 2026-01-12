import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { FileTokenStore, RuntimeCacheTokenStore } from "../auth-providers/token-store";

// Local type definitions for testing that satisfies IAgentRuntime subset
interface TestRuntime {
  agentId: UUID;
  getCache: <T>(key: string) => Promise<T | undefined>;
  setCache: <T>(key: string, value: T) => Promise<boolean>;
  deleteCache: (key: string) => Promise<boolean>;
}

// Helper function to convert TestRuntime to IAgentRuntime for testing
function asIAgentRuntime(runtime: TestRuntime): IAgentRuntime {
  return runtime as IAgentRuntime;
}

/**
 * Integration tests for token stores.
 * FileTokenStore tests use the real filesystem.
 * RuntimeCacheTokenStore tests use a minimal in-memory runtime implementation.
 */

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

    it("returns null for missing file", async () => {
      const path = join(tmpdir(), `x-oauth2-tokens-${Date.now()}-nonexistent.json`);
      const store = new FileTokenStore(path);
      const loaded = await store.load();
      expect(loaded).toBeNull();
    });
  });

  describe("RuntimeCacheTokenStore", () => {
    // Minimal in-memory runtime implementation for testing
    let runtime: TestRuntime;
    let cache: Map<string, unknown>;

    beforeEach(() => {
      cache = new Map<string, unknown>();
      runtime = {
        agentId: "agent-123" as UUID,
        getCache: async <T>(key: string): Promise<T | undefined> => cache.get(key) as T | undefined,
        setCache: async <T>(key: string, value: T): Promise<boolean> => {
          cache.set(key, value);
          return true;
        },
        deleteCache: async (key: string): Promise<boolean> => {
          return cache.delete(key);
        },
      };
    });

    it("saves and loads via runtime cache", async () => {
      // TestRuntime satisfies the runtime interface requirements
      const store = new RuntimeCacheTokenStore(asIAgentRuntime(runtime));
      const tokens = {
        access_token: "a",
        refresh_token: "r",
        expires_at: 123,
      };

      await store.save(tokens);
      const loaded = await store.load();
      expect(loaded).toEqual(tokens);
    });

    it("clear removes the cached value", async () => {
      const store = new RuntimeCacheTokenStore(asIAgentRuntime(runtime));
      await store.save({
        access_token: "a",
        refresh_token: "r",
        expires_at: 123,
      });

      await store.clear();
      const loaded = await store.load();
      expect(loaded).toBeNull();
    });

    it("returns null when no tokens stored", async () => {
      const store = new RuntimeCacheTokenStore(asIAgentRuntime(runtime));
      const loaded = await store.load();
      expect(loaded).toBeNull();
    });

    it("uses custom key when provided", async () => {
      const customKey = "custom/token/path";
      const store = new RuntimeCacheTokenStore(asIAgentRuntime(runtime), customKey);

      await store.save({
        access_token: "test",
        expires_at: 999,
      });

      // Verify the custom key was used
      expect(cache.has(customKey)).toBe(true);
    });
  });
});
