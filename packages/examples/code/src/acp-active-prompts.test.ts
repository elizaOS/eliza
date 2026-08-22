/** Deterministic concurrency and cancellation tests for ACP prompt isolation. */

import { describe, expect, it } from "bun:test";
import { AcpActivePromptRegistry } from "./acp-active-prompts.js";

describe("AcpActivePromptRegistry", () => {
  it("attributes concurrent async work to the correct session", async () => {
    const registry = new AcpActivePromptRegistry<string>();
    const seen: string[] = [];
    await Promise.all(
      ["a", "b"].map((sessionId) =>
        registry.run(
          { sessionId, publish: async () => undefined },
          async () => {
            await Promise.resolve();
            seen.push(registry.current()?.sessionId ?? "missing");
          },
        ),
      ),
    );
    expect(seen.sort()).toEqual(["a", "b"]);
    expect(registry.current()).toBeUndefined();
  });

  it("aborts only the selected session and rejects late cancellation", async () => {
    const registry = new AcpActivePromptRegistry<string>();
    let aAborted = false;
    let bAborted = false;
    const a = registry.run(
      { sessionId: "a", publish: async () => undefined },
      async (signal) => {
        registry.cancel("a");
        aAborted = signal.aborted;
      },
    );
    const b = registry.run(
      { sessionId: "b", publish: async () => undefined },
      async (signal) => {
        bAborted = signal.aborted;
      },
    );
    await Promise.all([a, b]);
    expect(aAborted).toBe(true);
    expect(bAborted).toBe(false);
    expect(registry.cancel("a")).toBe(false);
  });
});
