import { AgentRuntime, createCharacter } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  createViewClientStore,
  runWithViewClient,
} from "./view-client-context.ts";

describe("renderer caller state", () => {
  it("keeps concurrent async callers separate across host, client, and runtime", async () => {
    const first = new AgentRuntime({
      character: createCharacter({ name: "Same agent" }),
      enableAutonomy: false,
    });
    const second = new AgentRuntime({
      character: createCharacter({ name: "Same agent" }),
      enableAutonomy: false,
    });
    expect(first.agentId).toBe(second.agentId);
    const store = createViewClientStore<string>();
    const host = {};
    const otherHost = {};
    const a = { hostKey: host, clientId: "a" };
    const b = { hostKey: host, clientId: "b" };
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = runWithViewClient(a, async () => {
      store.set(first, "A");
      await barrier;
      expect(store.get(first)).toBe("A");
      expect(store.get(second)).toBeNull();
    });
    await runWithViewClient(b, async () => {
      store.set(first, "B");
      await Promise.resolve();
      expect(store.get(first)).toBe("B");
      store.delete(first);
    });
    expect(store.get(first, { hostKey: otherHost, clientId: "a" })).toBeNull();
    expect(store.get(first)).toBeNull();
    release();
    await pending;
  });
});
