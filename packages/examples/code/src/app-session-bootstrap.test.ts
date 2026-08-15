/** Verifies that App reuses the session loaded before runtime initialization. */
import { afterEach, describe, expect, it } from "bun:test";
import type { AgentRuntime } from "@elizaos/core";
import { App } from "./App.js";
import { useStore } from "./lib/store.js";

const ORIGINAL_STATE = useStore.getState();

describe("App session bootstrap", () => {
  afterEach(() => {
    useStore.setState(ORIGINAL_STATE, true);
  });

  it("does not reload a session that the runtime owner bootstrap already loaded", async () => {
    let reloads = 0;
    const runtime = {
      agentId: "30000000-0000-4000-8000-000000000001",
      character: {},
      getService: () => null,
      registerEvent: () => undefined,
    } as unknown as AgentRuntime;
    const app = new App(runtime);

    useStore.setState({
      sessionLoaded: true,
      loadSessionState: async () => {
        reloads += 1;
        throw new Error("loaded session was read twice");
      },
    });

    const tui = (
      app as unknown as { tui: { start: () => void; stop: () => void } }
    ).tui;
    tui.start = () => {
      queueMicrotask(() => {
        app.stop();
      });
    };

    await expect(app.run()).resolves.toBeUndefined();
    expect(reloads).toBe(0);
  });
});
