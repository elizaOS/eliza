import { describe, expect, it } from "vitest";

import { SandboxManager } from "./sandbox-manager.ts";

describe("SandboxManager policy enforcement", () => {
  it("fails explicitly when Apple Container is requested for standard sandbox mode", async () => {
    const manager = new SandboxManager({
      mode: "standard",
      engineType: "apple-container",
    });

    await expect(manager.start()).rejects.toThrow(
      /apple-container.+cannot enforce standard sandbox policy constraints/i,
    );
    expect(manager.getState()).toBe("degraded");
    expect(
      manager
        .getEventLog()
        .some((event) =>
          event.detail.includes("cannot enforce standard sandbox policy"),
        ),
    ).toBe(true);
  });

  it("fails explicitly when Apple Container is requested for max sandbox mode", async () => {
    const manager = new SandboxManager({
      mode: "max",
      engineType: "apple-container",
    });

    await expect(manager.start()).rejects.toThrow(
      /apple-container.+cannot enforce max sandbox policy constraints/i,
    );
  });
});
