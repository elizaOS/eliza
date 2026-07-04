/**
 * Hardening coverage for VISION capture inputs and media payload bounds.
 */

import {
  ContentType,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { visionAction } from "./action";

async function makePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: { r: 0, g: 128, b: 255 },
    },
  })
    .png()
    .toBuffer();
}

function makeMessage(): Memory {
  return {
    id: "message" as `${string}-${string}-${string}-${string}-${string}`,
    entityId: "user" as `${string}-${string}-${string}-${string}-${string}`,
    agentId: "agent" as `${string}-${string}-${string}-${string}-${string}`,
    roomId: "room" as `${string}-${string}-${string}-${string}-${string}`,
    worldId: "world" as `${string}-${string}-${string}-${string}-${string}`,
    content: { text: "capture image" },
  };
}

function makeRuntime(captureImage: () => Promise<Buffer | null>) {
  const visionService = {
    isActive: () => true,
    captureImage,
    getCameraInfo: () => ({ id: "cam-1", name: "Camera", connected: true }),
  };
  const runtime = Object.assign(Object.create(null) as IAgentRuntime, {
    agentId: "agent",
    getService: vi.fn((name: string) =>
      name === "VISION" ? visionService : null,
    ),
    createMemory: vi.fn(async () => undefined),
  });
  return { runtime, visionService };
}

describe("VISION capture hardening", () => {
  it("rejects malformed capture buffers instead of publishing fake image attachments", async () => {
    const { runtime } = makeRuntime(async () => Buffer.from("not an image"));
    const callback = vi.fn<HandlerCallback>();

    const result = await visionAction.handler(
      runtime,
      makeMessage(),
      undefined,
      { action: "capture" },
      callback,
    );

    expect(result?.success).toBe(false);
    expect(result?.data?.errorType).toBe("capture_error");
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: ["VISION"],
        text: expect.stringContaining("Malformed image input"),
      }),
    );
    expect(runtime.createMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.not.objectContaining({
          attachments: expect.any(Array),
        }),
      }),
      "messages",
    );
  });

  it("preserves the detected content type for non-JPEG camera captures", async () => {
    const png = await makePng();
    const { runtime } = makeRuntime(async () => png);
    const callback = vi.fn<HandlerCallback>();

    const result = await visionAction.handler(
      runtime,
      makeMessage(),
      undefined,
      { action: "capture" },
      callback,
    );

    expect(result?.success).toBe(true);
    expect(result?.data?.imageAttachment).toMatchObject({
      contentType: ContentType.IMAGE,
      url: expect.stringMatching(/^data:image\/png;base64,/),
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            url: expect.stringMatching(/^data:image\/png;base64,/),
          }),
        ],
      }),
    );
  });
});
