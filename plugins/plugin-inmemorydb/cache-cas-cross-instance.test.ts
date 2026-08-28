/**
 * Cross-instance compare-and-swap serialization (#25141): adapters sharing
 * one MemoryStorage must serialize CAS so two fresh-insert races cannot
 * both succeed. Real adapter + real storage; no mocks.
 */

import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const AGENT_A = "00000000-0000-4000-8000-00000000000a" as const;
const AGENT_B = "00000000-0000-4000-8000-00000000000b" as const;

describe("compareAndSwapCache across adapter instances sharing one storage", () => {
  it("two adapters racing a fresh insert: exactly one wins", async () => {
    const storage = new MemoryStorage();
    await storage.init();
    const adapterA = new InMemoryDatabaseAdapter(storage, AGENT_A);
    const adapterB = new InMemoryDatabaseAdapter(storage, AGENT_B);
    await adapterA.init();
    await adapterB.init();

    const [a, b] = await Promise.all([
      adapterA.compareAndSwapCache("cas-race-key", null, 0, { v: "a" }),
      adapterB.compareAndSwapCache("cas-race-key", null, 0, { v: "b" }),
    ]);
    expect(a === true || b === true).toBe(true);
    expect(a && b).toBe(false);

    const storedMap = await adapterA.getCaches<{
      v: string;
      revision?: number;
    }>(["cas-race-key"]);
    const stored = storedMap.get("cas-race-key");
    expect(stored).toBeDefined();
    expect(stored?.revision).toBe(0);
  });

  it("two adapters racing the same expected revision: exactly one swaps", async () => {
    const storage = new MemoryStorage();
    await storage.init();
    const adapterA = new InMemoryDatabaseAdapter(storage, AGENT_A);
    const adapterB = new InMemoryDatabaseAdapter(storage, AGENT_B);
    await adapterA.init();
    await adapterB.init();

    const seeded = await adapterA.compareAndSwapCache("cas-seed-key", null, 0, { v: "seed" });
    expect(seeded).toBe(true);

    const [a, b] = await Promise.all([
      adapterA.compareAndSwapCache("cas-seed-key", 0, 1, { v: "a" }),
      adapterB.compareAndSwapCache("cas-seed-key", 0, 1, { v: "b" }),
    ]);
    expect(a === true || b === true).toBe(true);
    expect(a && b).toBe(false);
  });
});
