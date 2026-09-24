/**
 * Covers the GENERATE_MEDIA action's validate/handler: provider gating (media
 * service vs IMAGE-model fallback), model-facing Seedance controls, missing-URL
 * failure, attachment delivery, and i18n-safe media-kind routing (#10471). Runs
 * against a deterministic mock runtime (vi.fn media service, no live model).
 */

import { describe, expect, it, vi } from "vitest";
import { actionToTool } from "../../../../../../packages/core/src/actions/to-tool.ts";
import {
  ModelType,
  ServiceType,
} from "../../../../../../packages/core/src/types/index.ts";
import { generateMediaAction } from "./generateMedia.ts";

const message = {
  id: "msg",
  roomId: "room",
  content: { text: "generate an image of a glass lighthouse" },
} as never;

function runtimeWithMediaService(
  canGenerateMedia: boolean,
  generateMedia = vi.fn(),
) {
  return {
    getService: (serviceType: string) =>
      serviceType === ServiceType.MEDIA_GENERATION
        ? { canGenerateMedia: vi.fn(() => canGenerateMedia), generateMedia }
        : undefined,
    getModel: vi.fn(() => undefined),
    // Video is opt-in in production (bills per clip); tests exercising the
    // video paths run with the operator opt-in granted.
    getSetting: vi.fn((key: string) =>
      key === "ELIZA_VIDEO_GENERATION_ENABLED" ? "true" : undefined,
    ),
  } as never;
}

describe("generateMediaAction availability", () => {
  it("publishes every Seedance and attachment input in the planner tool schema", () => {
    const tool = actionToTool(generateMediaAction);
    expect(tool.function.parameters).toMatchObject({
      type: "object",
      properties: {
        duration: { type: "number" },
        aspectRatio: {
          type: "string",
          enum: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
        },
        resolution: { type: "string", enum: ["480p", "720p"] },
        audio: { type: "boolean" },
        seed: { type: "number" },
        imageUrl: { type: "string" },
      },
    });
  });

  it("is hidden when the media service reports no configured provider", async () => {
    await expect(
      generateMediaAction.validate?.(
        runtimeWithMediaService(false),
        message,
        undefined,
        { parameters: { mediaType: "image", prompt: "glass lighthouse" } },
      ),
    ).resolves.toBe(false);
  });

  it("allows image fallback when an IMAGE model is registered", async () => {
    const runtime = {
      getService: () => undefined,
      getModel: (modelType: string) =>
        modelType === ModelType.IMAGE ? vi.fn() : undefined,
    } as never;

    await expect(
      generateMediaAction.validate?.(runtime, message, undefined, {
        parameters: { mediaType: "image", prompt: "glass lighthouse" },
      }),
    ).resolves.toBe(true);
  });

  it("is hidden for video when no media service is configured", async () => {
    const runtime = {
      getService: () => undefined,
      getModel: vi.fn(() => undefined),
    } as never;

    await expect(
      generateMediaAction.validate?.(runtime, message, undefined, {
        parameters: { mediaType: "video", prompt: "glass lighthouse" },
      }),
    ).resolves.toBe(false);
  });

  it("allows an explicit image ask with an IMAGE model even with no media context (F35)", async () => {
    // The live regression: no options (validate is called without them from
    // the message service), no pre-selected media/files context — only the
    // natural-language ask. With an IMAGE model present it must validate, or
    // the action is dropped from the catalog and the model denies a
    // capability it has (tj-ec2962758e6a13).
    const runtime = {
      getService: () => undefined,
      getModel: (modelType: string) =>
        modelType === ModelType.IMAGE ? vi.fn() : undefined,
    } as never;
    const imageAsk = {
      id: "msg",
      roomId: "room",
      content: {
        text: "make me a pixel-art castle image, 64x64 retro game vibe",
      },
    } as never;

    await expect(
      generateMediaAction.validate?.(runtime, imageAsk, undefined),
    ).resolves.toBe(true);
  });

  it("stays hidden without options, media context, OR an explicit ask", async () => {
    // A message that merely mentions an image but is not a generation ask,
    // with no media context and no options, must NOT expose the action.
    const runtime = {
      getService: () => undefined,
      getModel: (modelType: string) =>
        modelType === ModelType.IMAGE ? vi.fn() : undefined,
    } as never;
    const incidental = {
      id: "msg",
      roomId: "room",
      content: { text: "did you see the image i sent earlier?" },
    } as never;

    await expect(
      generateMediaAction.validate?.(runtime, incidental, undefined),
    ).resolves.toBe(false);
  });

  it("allows video when the media service can generate video", async () => {
    await expect(
      generateMediaAction.validate?.(
        runtimeWithMediaService(true),
        message,
        undefined,
        { parameters: { mediaType: "video", prompt: "glass lighthouse" } },
      ),
    ).resolves.toBe(true);
  });

  it("forwards the exact source image URL and Seedance controls for image-to-video", async () => {
    const generateMedia = vi.fn(async () => ({
      mediaType: "video",
      videoUrl: "https://cdn.example.com/generated/clip.mp4",
    }));
    await generateMediaAction.handler?.(
      runtimeWithMediaService(true, generateMedia),
      message,
      undefined,
      {
        parameters: {
          mediaType: "video",
          prompt: "Make the dog wag its tail",
          imageUrl: "https://media.blooio.com/files/dog.png",
          duration: 12,
          resolution: "480p",
          aspectRatio: "9:16",
          audio: false,
          seed: 42,
        },
      },
      vi.fn(),
    );

    expect(generateMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaType: "video",
        imageUrl: "https://media.blooio.com/files/dog.png",
        duration: 12,
        resolution: "480p",
        aspectRatio: "9:16",
        audio: false,
        seed: 42,
      }),
    );
  });

  it("does not silently remove explicit video controls after a provider rejection", async () => {
    const generateMedia = vi.fn(async () => {
      throw new Error(
        "Seedance 2.5 duration must be a whole number from 4 to 30 seconds",
      );
    });
    const result = await generateMediaAction.handler?.(
      runtimeWithMediaService(true, generateMedia),
      message,
      undefined,
      {
        parameters: {
          mediaType: "video",
          prompt: "Make a clip",
          duration: 3,
        },
      },
    );

    expect(generateMedia).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ success: false }));
  });

  it("returns MEDIA_GENERATION_MISSING_URL when video service omits videoUrl", async () => {
    const generateMedia = vi.fn(async () => ({
      mediaType: "video",
      url: undefined,
      videoUrl: undefined,
      mimeType: "video/mp4",
    }));
    const result = await generateMediaAction.handler?.(
      runtimeWithMediaService(true, generateMedia),
      message,
      undefined,
      { parameters: { mediaType: "video", prompt: "glass lighthouse" } },
    );

    expect(result).toMatchObject({
      success: false,
      values: {
        error: "MEDIA_GENERATION_MISSING_URL",
        mediaType: "video",
        prompt: "glass lighthouse",
      },
    });
  });

  it("marks generated media attachments for connector delivery", async () => {
    const callback = vi.fn();
    const generateMedia = vi.fn(async () => ({
      mediaType: "video",
      videoUrl: "https://cdn.example.com/generated/clip.mp4",
      mimeType: "video/mp4",
    }));
    const result = await generateMediaAction.handler?.(
      runtimeWithMediaService(true, generateMedia),
      message,
      undefined,
      {
        parameters: { mediaType: "video", prompt: "glass lighthouse" },
      },
      callback,
    );

    expect(result).toMatchObject({
      success: true,
      verifiedUserFacing: true,
      turnComplete: true,
      userFacingText: "here's your video.",
      values: {
        mediaGenerated: true,
        mediaType: "video",
      },
      data: {
        attachments: [
          expect.objectContaining({
            url: "https://cdn.example.com/generated/clip.mp4",
            contentType: "video",
          }),
        ],
      },
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "media-generation",
        attachments: [
          expect.objectContaining({
            url: "https://cdn.example.com/generated/clip.mp4",
            source: "media-generation",
            contentType: "video",
          }),
        ],
      }),
    );
  });
});

describe("generateMediaAction media-kind routing is i18n-safe (#10471)", () => {
  it("honors the structured mediaType enum regardless of message language", async () => {
    const generateMedia = vi.fn(async () => ({
      mediaType: "video",
      videoUrl: "https://cdn.example.com/v.mp4",
      mimeType: "video/mp4",
    }));
    // Non-English prompt; routing must come from params.mediaType, not text.
    const jaMessage = {
      id: "msg",
      roomId: "room",
      content: { text: "猫の動画を作って" },
    } as never;
    await generateMediaAction.handler?.(
      runtimeWithMediaService(true, generateMedia),
      jaMessage,
      undefined,
      { parameters: { mediaType: "video", prompt: "a cat" } },
    );
    expect(generateMedia).toHaveBeenCalledWith(
      expect.objectContaining({ mediaType: "video" }),
    );
  });

  it("does NOT infer media kind from English text when mediaType is absent", async () => {
    const generateMedia = vi.fn(async () => ({
      mediaType: "image",
      url: "https://cdn.example.com/i.png",
      mimeType: "image/png",
    }));
    // English "video"/"music" words in the prompt must not steer the media
    // kind — only the structured enum does. Absent enum ⇒ image.
    const englishyMessage = {
      id: "msg",
      roomId: "room",
      content: { text: "make a video with background music of a lighthouse" },
    } as never;
    await generateMediaAction.handler?.(
      runtimeWithMediaService(true, generateMedia),
      englishyMessage,
      undefined,
      { parameters: { prompt: "a lighthouse" } },
    );
    expect(generateMedia).toHaveBeenCalledWith(
      expect.objectContaining({ mediaType: "image" }),
    );
  });
});

describe("GENERATE_MEDIA speech model fallback", () => {
  const speechOptions = {
    parameters: {
      mediaType: "audio",
      audioKind: "tts",
      prompt: "Complete spoken text",
      voice: "speaker-1",
    },
  };

  function speechRuntime(output: Uint8Array | ArrayBuffer) {
    const useModel = vi.fn(async () => output);
    return {
      runtime: {
        getService: () => undefined,
        getSetting: () => undefined,
        getModel: (type: string) =>
          type === ModelType.TEXT_TO_SPEECH ? useModel : undefined,
        useModel,
      } as never,
      useModel,
    };
  }

  it("delivers complete WAV bytes with the requested voice and the correct attachment type", async () => {
    const bytes = Buffer.concat([
      Buffer.from("RIFF0000WAVE"),
      Buffer.from([1, 2, 3, 4]),
    ]);
    const { runtime, useModel } = speechRuntime(bytes);
    const callback = vi.fn(
      async (_content: import("@elizaos/core").Content) => [],
    );
    expect(
      await generateMediaAction.validate(
        runtime,
        message,
        undefined,
        speechOptions,
      ),
    ).toBe(true);
    const result = await generateMediaAction.handler(
      runtime,
      message,
      undefined,
      speechOptions,
      callback,
    );
    expect(result.success).toBe(true);
    expect(useModel).toHaveBeenCalledWith(ModelType.TEXT_TO_SPEECH, {
      text: "Complete spoken text",
      voice: "speaker-1",
      audioStream: false,
    });
    const attachment = callback.mock.calls[0]?.[0].attachments?.[0];
    if (!attachment)
      throw new Error("Speech callback did not deliver an attachment");
    expect(attachment.mimeType).toBe("audio/wav");
    expect(attachment.title).toMatch(/\.wav$/);
    expect(Buffer.from(attachment.url.split(",")[1], "base64")).toEqual(bytes);
  });

  it("does not advertise speech synthesis as a music generator", async () => {
    const { runtime, useModel } = speechRuntime(new Uint8Array([1, 2]));
    expect(
      await generateMediaAction.validate(runtime, message, undefined, {
        parameters: {
          mediaType: "audio",
          audioKind: "music",
          prompt: "A song",
        },
      }),
    ).toBe(false);
    expect(useModel).not.toHaveBeenCalled();
  });

  it("rejects empty speech output without delivering an attachment", async () => {
    const { runtime } = speechRuntime(new ArrayBuffer(0));
    const callback = vi.fn(
      async (_content: import("@elizaos/core").Content) => [],
    );
    const result = await generateMediaAction.handler(
      runtime,
      message,
      undefined,
      speechOptions,
      callback,
    );
    expect(result.success).toBe(false);
    expect(callback).not.toHaveBeenCalled();
    expect(result.text).toContain("no audio bytes");
  });
});
