import { describe, expect, it } from "vitest";
import { withMapsNavigationRelay } from "../src/client/navigation-relay";

describe("withMapsNavigationRelay", () => {
  it("composes signals through the host when it supplies anySignal", async () => {
    const composed: AbortSignal[][] = [];
    const host = {
      anySignal(signals: AbortSignal[]) {
        composed.push(signals);
        const controller = new AbortController();
        for (const signal of signals)
          signal.addEventListener("abort", () => controller.abort(), {
            once: true,
          });
        return controller.signal;
      },
      current: () => ({}),
      execute: async () => null,
      failure: () => "failed",
      connected() {},
    };
    // A relay that is unavailable falls back to the plain send after composing the lifetime.
    const result = await withMapsNavigationRelay(
      host,
      async () => {
        throw Error("unavailable");
      },
      "conversation",
      new AbortController().signal,
      async () => "sent",
    );
    expect(result).toBe("sent");
    expect(composed).toHaveLength(1);
    expect(composed[0]).toHaveLength(2);
  });
});
