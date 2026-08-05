import { describe, expect, it } from "vitest";
import {
  createHybridMemoryStore,
  createOfflineMemoryStore,
  createHermesMemoryStore,
  createHonchoMemoryStore,
} from "../src/memory-client.ts";
import { memoryBackendStatus, readCheshireMemoryConfig } from "../src/config.ts";

describe("plugin-cheshire-memory", () => {
  it("reads HERMES_API_KEY and HONCHO_API_KEY", () => {
    const cfg = readCheshireMemoryConfig((k) => {
      if (k === "HERMES_API_KEY") return "hermes_secret";
      if (k === "HONCHO_API_KEY") return "honcho_secret";
      return undefined;
    });
    expect(cfg.hermesApiKey).toBe("hermes_secret");
    expect(cfg.honchoApiKey).toBe("honcho_secret");
    expect(memoryBackendStatus(cfg)).toEqual({
      hermes: "configured",
      honcho: "configured",
    });
  });

  it("offline store append + ask", async () => {
    const store = createOfflineMemoryStore();
    await store.append({
      role: "trade",
      content: "bought SOL CLAWD",
      ts: Date.now(),
    });
    const answer = await store.ask("CLAWD");
    expect(answer).toContain("CLAWD");
  });

  it("hybrid merges backends", async () => {
    const a = createOfflineMemoryStore();
    const b = createOfflineMemoryStore();
    await a.append({ role: "user", content: "from-a", ts: 1 });
    await b.append({ role: "user", content: "from-b", ts: 2 });
    const hybrid = createHybridMemoryStore({ honcho: a, hermes: b });
    expect(hybrid.backend).toBe("hybrid");
    const recent = await hybrid.recent(10);
    expect(recent.map((m) => m.content)).toEqual(["from-a", "from-b"]);
  });

  it("honcho/hermes clients use fetch without throwing on failure", async () => {
    const failFetch = async () => {
      throw new Error("network down");
    };
    const honcho = createHonchoMemoryStore({
      apiKey: "k",
      baseUrl: "https://example.invalid",
      peerId: "p",
      sessionId: "s",
      fetchImpl: failFetch,
    });
    const hermes = createHermesMemoryStore({
      apiKey: "k",
      baseUrl: "https://example.invalid",
      fetchImpl: failFetch,
    });
    await honcho.append({ role: "user", content: "hi", ts: Date.now() });
    await hermes.append({ role: "trade", content: "sell", ts: Date.now() });
    const a = await honcho.ask("hi");
    expect(a.length).toBeGreaterThan(0);
  });
});
