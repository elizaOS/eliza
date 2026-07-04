import { ElizaError } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserService, type BrowserTarget } from "../browser-service.js";

const originalEnv = { ...process.env };

function createTarget(args: {
  id: string;
  priority: number;
  available?: boolean;
  availableError?: Error;
  fail?: boolean;
  score?: BrowserTarget["score"];
}): BrowserTarget {
  return {
    id: args.id,
    name: args.id,
    description: args.id,
    priority: args.priority,
    ...(args.score ? { score: args.score } : {}),
    available: vi.fn(async () => {
      if (args.availableError) throw args.availableError;
      return args.available ?? true;
    }),
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

  it("preserves pinned target availability failures as typed errors", async () => {
    const service = new BrowserService();
    const availabilityError = new Error("bridge health probe failed");
    service.registerTarget(
      createTarget({
        id: "bridge",
        priority: 80,
        availableError: availabilityError,
      }),
    );
    service.registerTarget(createTarget({ id: "workspace", priority: 100 }));

    try {
      await service.execute({ subaction: "state" }, "bridge");
      throw new Error("expected pinned target availability failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe("BROWSER_TARGET_UNAVAILABLE");
      expect((error as ElizaError).context).toEqual({
        targetId: "bridge",
        subaction: "state",
      });
      expect((error as ElizaError).severity).toBe("ephemeral");
      expect((error as Error).cause).toBe(availabilityError);
    }
  });

  it("passes desktop context so companion targets can win when available", async () => {
    const service = new BrowserService();
    const workspaceScore = vi.fn(() => 100);
    const bridgeScore = vi.fn(({ mobile }) => (mobile ? null : 160));
    service.registerTarget(
      createTarget({ id: "workspace", priority: 100, score: workspaceScore }),
    );
    service.registerTarget(
      createTarget({ id: "bridge", priority: 80, score: bridgeScore }),
    );

    const result = await service.execute({ subaction: "state" });

    expect(result.value).toBe("bridge");
    expect(workspaceScore.mock.calls[0]?.[0].mobile).toBe(false);
    expect(bridgeScore.mock.calls[0]?.[0].mobile).toBe(false);
  });

  it("passes mobile context so internal workspace wins and companion targets opt out", async () => {
    process.env.ELIZA_MOBILE_PLATFORM = "ios";
    const service = new BrowserService();
    const workspace = createTarget({
      id: "workspace",
      priority: 100,
      score: ({ mobile }) => (mobile ? 120 : 100),
    });
    const bridge = createTarget({
      id: "bridge",
      priority: 80,
      score: ({ mobile }) => (mobile ? null : 160),
    });
    service.registerTarget(bridge);
    service.registerTarget(workspace);

    const result = await service.execute({ subaction: "state" });

    expect(result.value).toBe("workspace");
    expect(bridge.execute).not.toHaveBeenCalled();
    expect(workspace.execute).toHaveBeenCalledTimes(1);
  });
});

describe("BrowserService workspace snapshot seam (item #12091-14)", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("exposes the live workspace snapshot so hosts read it via the runtime service, not a plugin import", async () => {
    const service = new BrowserService();
    const snapshot = await service.getWorkspaceSnapshot();
    expect(typeof snapshot.mode).toBe("string");
    expect(Array.isArray(snapshot.tabs)).toBe(true);
  });
});
