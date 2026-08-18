/**
 * Regression coverage for `handleImageGeneration`'s fail-closed contract
 * (elizaOS/eliza#21985). The IMAGE slot must never fabricate a healthy-looking
 * `{ url: "" }` for a cloud entry that carries neither `url` nor `image`
 * (partial/failed/moderated generation). It must throw the same way the
 * sibling `handleVideoGeneration`/`handleAudioGeneration`/
 * `handleImageDescription` handlers in this package already fail closed, so the
 * runtime reports the failure instead of storing an empty attachment
 * reference. The cloud SDK client is mocked; no network.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const generateImage = vi.fn();
vi.mock("../src/utils/sdk-client", () => ({
  createElizaCloudClient: () => ({ generateImage }),
}));
vi.mock("../src/utils/config", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getImageGenerationModel: () => "google/nano-banana-2/text-to-image",
  };
});

const { handleImageGeneration } = await import("../src/models/image");

function runtime(): IAgentRuntime {
  return { getSetting: () => "", emitEvent: () => {} } as unknown as IAgentRuntime;
}

describe("handleImageGeneration fail-closed contract (#21985)", () => {
  afterEach(() => generateImage.mockReset());

  it("throws instead of fabricating { url: '' } when an entry has neither url nor image", async () => {
    generateImage.mockResolvedValue({ images: [{}] });
    await expect(handleImageGeneration(runtime(), { prompt: "a cat" })).rejects.toThrow(
      /returned no image URL/i
    );
  });

  it("throws when the cloud returns an empty images array for a >=1 image request", async () => {
    generateImage.mockResolvedValue({ images: [] });
    await expect(handleImageGeneration(runtime(), { prompt: "a cat" })).rejects.toThrow(
      /returned no image/i
    );
  });

  it("throws when the cloud omits the images field entirely", async () => {
    generateImage.mockResolvedValue({});
    await expect(handleImageGeneration(runtime(), { prompt: "a cat" })).rejects.toThrow(
      /returned no image/i
    );
  });

  it("resolves a single entry that carries only a url", async () => {
    generateImage.mockResolvedValue({ images: [{ url: "https://cdn/ok.png" }] });
    await expect(handleImageGeneration(runtime(), { prompt: "a cat" })).resolves.toEqual([
      { url: "https://cdn/ok.png" },
    ]);
  });

  it("preserves a base64 entry that carries only the image field", async () => {
    const b64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    generateImage.mockResolvedValue({ images: [{ image: b64 }] });
    await expect(handleImageGeneration(runtime(), { prompt: "a cat" })).resolves.toEqual([
      { url: b64 },
    ]);
  });

  it("falls back to a valid base64 image when url is empty", async () => {
    const b64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    generateImage.mockResolvedValue({ images: [{ url: "", image: b64 }] });
    await expect(handleImageGeneration(runtime(), { prompt: "a cat" })).resolves.toEqual([
      { url: b64 },
    ]);
  });

  it("rejects a mixed batch rather than returning an empty-url hole", async () => {
    generateImage.mockResolvedValue({
      images: [{}, { url: "https://cdn/ok.png" }],
    });
    await expect(handleImageGeneration(runtime(), { prompt: "a cat" })).rejects.toThrow(
      /returned no image URL/i
    );
  });

  it("rejects when an entry's url is an empty string", async () => {
    generateImage.mockResolvedValue({ images: [{ url: "" }] });
    await expect(handleImageGeneration(runtime(), { prompt: "a cat" })).rejects.toThrow(
      /returned no image URL/i
    );
  });
});
