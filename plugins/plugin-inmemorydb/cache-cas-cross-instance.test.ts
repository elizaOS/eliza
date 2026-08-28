/**
 * Cache tenant isolation and cross-instance CAS serialization (#25141):
 * adapters sharing one MemoryStorage must serialize CAS so two same-agent
 * fresh-insert races cannot both succeed, while adapters for DIFFERENT agents
 * must be fully isolated — a cross-agent CAS on the same key is two
 * independent namespaces, mirroring the SQL composite (key, agent_id) cache
 * primary key. Real adapter + real storage; no mocks.
 */

import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const AGENT_A = "00000000-0000-4000-8000-00000000000a" as const;
const AGENT_B = "00000000-0000-4000-8000-00000000000b" as const;

describe("compareAndSwapCache across adapter instances sharing one storage", () => {
  it("two same-agent adapters racing a fresh insert: exactly one wins", async () => {
    const storage = new MemoryStorage();
    await storage.init();
    const adapterA = new InMemoryDatabaseAdapter(storage, AGENT_A);
    const adapterB = new InMemoryDatabaseAdapter(storage, AGENT_A);
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

  it("two same-agent adapters racing the same expected revision: exactly one swaps", async () => {
    const storage = new MemoryStorage();
    await storage.init();
    const adapterA = new InMemoryDatabaseAdapter(storage, AGENT_A);
    const adapterB = new InMemoryDatabaseAdapter(storage, AGENT_A);
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

  it("different agents never collide: both create, read, and overwrite their own value", async () => {
    const storage = new MemoryStorage();
    await storage.init();
    const adapterA = new InMemoryDatabaseAdapter(storage, AGENT_A);
    const adapterB = new InMemoryDatabaseAdapter(storage, AGENT_B);
    await adapterA.init();
    await adapterB.init();

    // Both agents can create the same logical key (separate namespaces).
    const aw = await adapterA.compareAndSwapCache("shared-key", null, 0, { owner: "A" });
    const bw = await adapterB.compareAndSwapCache("shared-key", null, 0, { owner: "B" });
    expect(aw).toBe(true);
    expect(bw).toBe(true);

    // Each reads back only its own value — no tenant leakage.
    const aReads = await adapterA.getCaches<{ owner: string }>(["shared-key"]);
    const bReads = await adapterB.getCaches<{ owner: string }>(["shared-key"]);
    expect(aReads.get("shared-key")?.owner).toBe("A");
    expect(bReads.get("shared-key")?.owner).toBe("B");

    // Each agent advances its own revision independently.
    const aSwap = await adapterA.compareAndSwapCache("shared-key", 0, 1, { owner: "A2" });
    const bSwap = await adapterB.compareAndSwapCache("shared-key", 0, 1, { owner: "B2" });
    expect(aSwap).toBe(true);
    expect(bSwap).toBe(true);

    const aFinal = await adapterA.getCaches<{ owner: string }>(["shared-key"]);
    const bFinal = await adapterB.getCaches<{ owner: string }>(["shared-key"]);
    expect(aFinal.get("shared-key")?.owner).toBe("A2");
    expect(bFinal.get("shared-key")?.owner).toBe("B2");
  });

  it("setCaches/deleteCaches are agent-scoped: a delete by one agent leaves the other's row intact", async () => {
    const storage = new MemoryStorage();
    await storage.init();
    const adapterA = new InMemoryDatabaseAdapter(storage, AGENT_A);
    const adapterB = new InMemoryDatabaseAdapter(storage, AGENT_B);
    await adapterA.init();
    await adapterB.init();

    await adapterA.setCaches([{ key: "scoped-key", value: { owner: "A" } }]);
    await adapterB.setCaches([{ key: "scoped-key", value: { owner: "B" } }]);

    await adapterA.deleteCaches(["scoped-key"]);

    const aReads = await adapterA.getCaches(["scoped-key"]);
    const bReads = await adapterB.getCaches(["scoped-key"]);
    expect(aReads.has("scoped-key")).toBe(false);
    expect(bReads.get("scoped-key")).toEqual({ owner: "B" });
  });
});
