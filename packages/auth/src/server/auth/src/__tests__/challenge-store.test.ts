import { describe, expect, it } from "bun:test";

import { ChallengeStore } from "../challenge-store";
import type { StoreBackend } from "../store-backends";

function failingBackend(): StoreBackend {
  return {
    set: async () => {},
    setIfNotExists: async () => true,
    get: async () => null,
    consume: async () => null,
    compareDelete: async () => false,
    transition: async () => false,
    publish: async () => false,
    delete: async () => {
      throw new Error("backend unavailable");
    },
  };
}

describe("ChallengeStore.delete", () => {
  it("surfaces backend failures so security-sensitive cleanup cannot appear successful", async () => {
    const store = new ChallengeStore({ backend: failingBackend() });
    await expect(store.delete("key")).rejects.toThrow("backend unavailable");
  });

  it("removes the entry on the happy path", async () => {
    const store = new ChallengeStore();
    try {
      await store.set("key", "challenge");
      await store.delete("key");
      expect(await store.get("key")).toBeNull();
    } finally {
      store.destroy();
    }
  });
});
