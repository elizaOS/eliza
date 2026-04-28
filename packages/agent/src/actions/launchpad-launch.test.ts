/**
 * LAUNCHPAD_LAUNCH action verification.
 *
 * Validates that:
 *   - The action resolves each launchpad key to the correct profile.
 *   - Missing required params surface a clear error result.
 *   - dryRun: "stop-before-tx" propagates into the engine.
 *   - Narration creates intermediate agent memories on the conversation.
 *
 * The engine itself is mocked — its behaviour is covered by
 * launchpad-engine.test.ts.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/launchpads/launchpad-engine.js", () => ({
  runLaunchpad: vi.fn(async (_profile, _options) => ({
    ok: true,
    profileId: _profile.id,
    stoppedAtStep: 0,
    reason: "stub",
  })),
}));
vi.mock("../services/launchpads/metadata-generator.js", () => ({
  generateTokenMetadata: vi.fn(async () => ({
    name: "Stub",
    symbol: "STUB",
    description: "Stub description for unit test.",
    imagePrompt: "stub art",
    theme: "stub",
  })),
}));
vi.mock("../services/launchpads/image-generator.js", () => ({
  runLaunchpadImageGeneration: vi.fn(async () => ({
    imageUrl: "https://example.com/stub.png",
    imageBase64: null,
  })),
}));
vi.mock("../security/access.js", () => ({
  hasRoleAccess: vi.fn(async () => true),
}));

import { runLaunchpad } from "../services/launchpads/launchpad-engine.js";
import { launchpadLaunchAction } from "./launchpad-launch.js";

const mockRunLaunchpad = vi.mocked(runLaunchpad);

const fakeRuntime = {
  agentId: "agent-id" as UUID,
  createMemory: vi.fn(async () => undefined),
  // useModel and other methods are unused via the mocked metadata-generator.
} as unknown as IAgentRuntime;

const fakeMessage: Memory = {
  id: "msg-1" as UUID,
  entityId: "user-id" as UUID,
  roomId: "room-1" as UUID,
  worldId: "world-1" as UUID,
  content: { text: "launch a meme on four.meme testnet" },
};

beforeEach(() => {
  mockRunLaunchpad.mockClear();
  (fakeRuntime.createMemory as ReturnType<typeof vi.fn>).mockClear();
});

describe("launchpadLaunchAction", () => {
  it.each([
    ["four-meme", "four-meme:mainnet"],
    ["four-meme:testnet", "four-meme:testnet"],
    ["flap-sh", "flap-sh:mainnet"],
    ["flap-sh:devnet", "flap-sh:devnet"],
  ])("resolves %s to profile %s", async (key, expectedProfile) => {
    const result = await launchpadLaunchAction.handler(
      fakeRuntime,
      fakeMessage,
      undefined,
      {
        parameters: { launchpad: key, tabId: "btab_1" },
      } as unknown as Parameters<typeof launchpadLaunchAction.handler>[3],
    );
    expect(result?.success).toBe(true);
    expect(mockRunLaunchpad).toHaveBeenCalledOnce();
    const profile = mockRunLaunchpad.mock.calls[0][0];
    expect(profile.id).toBe(expectedProfile);
  });

  it("rejects missing launchpad or tabId with a typed error", async () => {
    const result = await launchpadLaunchAction.handler(
      fakeRuntime,
      fakeMessage,
      undefined,
      { parameters: {} } as unknown as Parameters<
        typeof launchpadLaunchAction.handler
      >[3],
    );
    expect(result?.success).toBe(false);
    expect(result?.values).toMatchObject({
      success: false,
      error: "LAUNCHPAD_LAUNCH_BAD_PARAMS",
    });
    expect(mockRunLaunchpad).not.toHaveBeenCalled();
  });

  it("propagates dryRun stop-before-tx into the engine", async () => {
    await launchpadLaunchAction.handler(fakeRuntime, fakeMessage, undefined, {
      parameters: {
        launchpad: "four-meme:testnet",
        tabId: "btab_1",
        dryRun: "stop-before-tx",
      },
    } as unknown as Parameters<typeof launchpadLaunchAction.handler>[3]);
    const options = mockRunLaunchpad.mock.calls[0][1];
    expect(options.dryRun).toBe("stop-before-tx");
  });

  it("creates a memory entry every time the engine narrates", async () => {
    let captured: ((line: string) => void | Promise<void>) | null = null;
    mockRunLaunchpad.mockImplementation(async (_profile, opts) => {
      captured = opts.narrate;
      // Drive a few narration lines through the callback to exercise the
      // memory write path.
      await opts.narrate("Step one");
      await opts.narrate("Step two");
      return {
        ok: true,
        profileId: _profile.id,
        stoppedAtStep: 1,
        reason: "ok",
      };
    });

    await launchpadLaunchAction.handler(fakeRuntime, fakeMessage, undefined, {
      parameters: { launchpad: "four-meme:testnet", tabId: "btab_1" },
    } as unknown as Parameters<typeof launchpadLaunchAction.handler>[3]);

    expect(captured).not.toBeNull();
    expect(fakeRuntime.createMemory).toHaveBeenCalledTimes(2);
    const firstCall = (fakeRuntime.createMemory as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(firstCall[0].content.text).toBe("Step one");
    expect(firstCall[0].roomId).toBe(fakeMessage.roomId);
    expect(firstCall[0].entityId).toBe(fakeRuntime.agentId);
    expect(firstCall[1]).toBe("messages");
  });
});
