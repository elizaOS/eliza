/** Verifies that App reuses the session loaded before runtime initialization. */
import { describe, expect, it } from "bun:test";
import type { AgentRuntime } from "@elizaos/core";
import { App } from "./App.js";
import { useStore } from "./lib/store.js";

describe("App session bootstrap", () => {
  it("does not reload a session that the runtime owner bootstrap already loaded", async () => {
    const previousState = useStore.getState();
    let reloads = 0;
    const runtime = {
      agentId: "30000000-0000-4000-8000-000000000001",
      character: {},
      getService: () => null,
      registerEvent: () => undefined,
    } as unknown as AgentRuntime;
    const app = new App(runtime);

    try {
      useStore.setState({
        sessionLoaded: true,
        loadSessionState: async () => {
          reloads += 1;
          throw new Error("loaded session was read twice");
        },
      });

      const stopTimer = setTimeout(() => app.stop(), 10);
      const result = await app.run().catch((error: unknown) => error);
      clearTimeout(stopTimer);

      expect(result).toBeUndefined();
      expect(reloads).toBe(0);
    } finally {
      app.stop();
      useStore.setState(previousState, true);
    }
  });
});
