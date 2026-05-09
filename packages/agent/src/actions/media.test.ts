import type { Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateImageAction } from "./media.js";

const loadElizaConfig = vi.fn();

vi.mock("../config/config.js", () => ({
  loadElizaConfig: () => loadElizaConfig(),
}));

function createMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    agentId: "00000000-0000-0000-0000-000000000002",
    entityId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: { text },
  } as Memory;
}

describe("media actions", () => {
  beforeEach(() => {
    loadElizaConfig.mockReset();
  });

  it("does not expose image generation when no media provider is configured", async () => {
    loadElizaConfig.mockReturnValue({});

    await expect(
      generateImageAction.validate?.(
        {} as never,
        createMessage("generate an image of a cozy neon office"),
        undefined,
      ),
    ).resolves.toBe(false);
  });

  it("exposes image generation when cloud media is selected", async () => {
    loadElizaConfig.mockReturnValue({
      cloud: {
        apiKey: "test-key",
        baseUrl: "https://cloud.example.test/api/v1",
      },
      serviceRouting: {
        media: {
          transport: "cloud-proxy",
          backend: "elizacloud",
        },
      },
    });

    await expect(
      generateImageAction.validate?.(
        {} as never,
        createMessage("generate an image of a cozy neon office"),
        undefined,
      ),
    ).resolves.toBe(true);
  });
});
