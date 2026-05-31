import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserService, type BrowserTarget } from "../browser-service.js";

const originalEnv = { ...process.env };

function createTarget(args: {
  id: string;
  priority: number;
  available?: boolean;
  fail?: boolean;
}): BrowserTarget {
  return {
    id: args.id,
    name: args.id,
    description: args.id,
    priority: args.priority,
    available: vi.fn(async () => args.available ?? true),
    execute: vi.fn(async (command) => {
      if (args.fail) throw new Error(`${args.id} failed`);
      return {
        mode: "web",
        subaction: command.subaction,
        value: args.id,
      };
    }),
  };
}

describe("BrowserService target routing", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses target priority instead of registration order for automatic routing", async () => {
    const service = new BrowserService();
    service.registerTarget(createTarget({ id: "stagehand", priority: 10 }));
    service.registerTarget(createTarget({ id: "workspace", priority: 100 }));

    const result = await service.execute({ subaction: "state" });

    expect(result.value).toBe("workspace");
  });

  it("falls back to the next automatic target when an unpinned target fails", async () => {
    const service = new BrowserService();
    const workspace = createTarget({
      id: "workspace",
      priority: 100,
      fail: true,
    });
    const bridge = createTarget({ id: "bridge", priority: 80 });
    service.registerTarget(workspace);
    service.registerTarget(bridge);

    const result = await service.execute({ subaction: "state" });

    expect(result.value).toBe("bridge");
    expect(workspace.execute).toHaveBeenCalledTimes(1);
    expect(bridge.execute).toHaveBeenCalledTimes(1);
  });

  it("does not fall back when the caller pins a target", async () => {
    const service = new BrowserService();
    service.registerTarget(
      createTarget({ id: "workspace", priority: 100, fail: true }),
    );
    service.registerTarget(createTarget({ id: "bridge", priority: 80 }));

    await expect(
      service.execute({ subaction: "state" }, "workspace"),
    ).rejects.toThrow("workspace failed");
  });
});
