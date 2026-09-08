/**
 * Executable contracts for GET_SCREEN display selection and frame provenance.
 * The mocked runtime preserves the real optional computer-use service seam.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { visionAction } from "./action";

let screenshot = "";

beforeAll(async () => {
  screenshot = (
    await sharp({
      create: {
        width: 2,
        height: 1,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    })
      .png()
      .toBuffer()
  ).toString("base64");
});

function makeMessage(): Memory {
  return {
    id: "message" as `${string}-${string}-${string}-${string}-${string}`,
    entityId: "user" as `${string}-${string}-${string}-${string}-${string}`,
    agentId: "agent" as `${string}-${string}-${string}-${string}-${string}`,
    roomId: "room" as `${string}-${string}-${string}-${string}-${string}`,
    content: { text: "read display" },
  };
}

function makeRuntime(computeruse: object | null): IAgentRuntime {
  return Object.assign(Object.create(null) as IAgentRuntime, {
    agentId: "agent",
    getService: vi.fn((name: string) =>
      name === "computeruse" ? computeruse : null,
    ),
    createMemory: vi.fn(async () => undefined),
  });
}

describe("VISION get_screen capture provenance", () => {
  it("validates and passes displayId through to native capture", async () => {
    const executeCommand = vi.fn(async () => ({
      success: true,
      screenshot,
      displayId: 2,
    }));
    const result = await visionAction.handler(
      makeRuntime({ executeCommand }),
      makeMessage(),
      undefined,
      { action: "get_screen", displayId: 2, includeOcr: false },
    );

    expect(executeCommand).toHaveBeenCalledWith("screenshot", { displayId: 2 });
    expect(result).toMatchObject({
      success: true,
      data: { op: "get_screen", displayId: 2 },
    });
  });

  it("rejects a returned frame whose identity differs from the request", async () => {
    const result = await visionAction.handler(
      makeRuntime({
        executeCommand: async () => ({
          success: true,
          screenshot,
          displayId: 3,
        }),
      }),
      makeMessage(),
      undefined,
      { action: "get_screen", displayId: 2 },
    );

    expect(result).toMatchObject({
      success: false,
      data: {
        error: "display_id_mismatch",
        requestedDisplayId: 2,
        actualDisplayId: 3,
        capturedAt: expect.any(Number),
      },
    });
  });

  it("does not infer identity from the request when native capture omits it", async () => {
    const result = await visionAction.handler(
      makeRuntime({
        executeCommand: async () => ({ success: true, screenshot }),
      }),
      makeMessage(),
      undefined,
      { action: "get_screen", displayId: 0 },
    );

    expect(result).toMatchObject({
      success: false,
      data: {
        error: "display_id_mismatch",
        requestedDisplayId: 0,
        actualDisplayId: null,
        capturedAt: expect.any(Number),
      },
    });
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, "2"])(
    "rejects invalid displayId %j before capture",
    async (displayId) => {
      const executeCommand = vi.fn();
      const result = await visionAction.handler(
        makeRuntime({ executeCommand }),
        makeMessage(),
        undefined,
        { action: "get_screen", displayId },
      );

      expect(executeCommand).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        data: {
          error: "invalid_display_id",
          capturedAt: expect.any(Number),
        },
      });
    },
  );

  it("timestamps capture-source failures", async () => {
    const before = Date.now();
    const result = await visionAction.handler(
      makeRuntime(null),
      makeMessage(),
      undefined,
      { action: "get_screen", displayId: 4 },
    );

    expect(result).toMatchObject({
      success: false,
      data: {
        error: "no_capture_source",
        capturedAt: expect.any(Number),
      },
    });
    expect(Number(result?.data?.capturedAt)).toBeGreaterThanOrEqual(before);
  });
});
