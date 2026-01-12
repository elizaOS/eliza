import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Media } from "../../types/index.ts";
import { ContentType, ModelType } from "../../types/index.ts";
import { processAttachments } from "../index";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils";

describe("processAttachments", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    // Mock useModel as a vi.fn() to support mockRejectedValueOnce/mockResolvedValueOnce
    runtime.useModel = vi.fn().mockResolvedValue("");

    // Spy on logger methods
    vi.spyOn(runtime.logger, "warn").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "error").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "info").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "debug").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should return empty array for no attachments", async () => {
    const result = await processAttachments([], runtime);
    expect(result).toEqual([]);
  });

  it("should return empty array for null/undefined attachments", async () => {
    const result = await processAttachments(null, runtime);
    expect(result).toEqual([]);
  });

  it("should process image attachments and generate descriptions", async () => {
    const imageAttachment: Media = {
      id: "image-1",
      url: "https://example.com/image.jpg",
      contentType: ContentType.IMAGE,
      source: "image/jpeg",
    };

    // Mock the image description model response
    runtime.useModel.mockResolvedValue(`<response>
  <title>Beautiful Sunset</title>
  <description>A stunning sunset over the ocean with vibrant colors</description>
  <text>This image captures a breathtaking sunset scene over a calm ocean. The sky is painted with brilliant hues of orange, pink, and purple as the sun dips below the horizon. Gentle waves lap at the shore, creating a peaceful and serene atmosphere.</text>
</response>`);

    const result = await processAttachments([imageAttachment], runtime);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("image-1");

    expect(result[0].title).toBe("Beautiful Sunset");
    expect(result[0].description).toBe(
      "A stunning sunset over the ocean with vibrant colors",
    );
    expect(result[0].text).toBe(
      "This image captures a breathtaking sunset scene over a calm ocean. The sky is painted with brilliant hues of orange, pink, and purple as the sun dips below the horizon. Gentle waves lap at the shore, creating a peaceful and serene atmosphere.",
    );

    expect(runtime.useModel).toHaveBeenCalledWith(ModelType.IMAGE_DESCRIPTION, {
      prompt: expect.stringContaining("Analyze the provided image"),
      imageUrl: "https://example.com/image.jpg",
    });
  });

  it("should skip processing for images that already have descriptions", async () => {
    const imageWithDescription: Media = {
      id: "image-2",
      url: "https://example.com/described.jpg",
      contentType: ContentType.IMAGE,
      source: "image/jpeg",
      description: "Already has a description",
      title: "Existing Title",
      text: "Existing text",
    };

    const result = await processAttachments([imageWithDescription], runtime);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(imageWithDescription);
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("should handle non-image attachments without processing", async () => {
    const pdfAttachment: Media = {
      id: "pdf-1",
      url: "https://example.com/document.pdf",
      source: "application/pdf",
      title: "PDF Document",
    };

    const result = await processAttachments([pdfAttachment], runtime);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(pdfAttachment);
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("should handle mixed attachment types", async () => {
    const attachments: Media[] = [
      {
        id: "image-1",
        url: "https://example.com/image1.jpg",
        contentType: ContentType.IMAGE,
        source: "image/jpeg",
      },
      {
        id: "pdf-1",
        url: "https://example.com/doc.pdf",
        source: "application/pdf",
      },
      {
        id: "image-2",
        url: "https://example.com/image2.png",
        contentType: ContentType.IMAGE,
        source: "image/png",
        description: "Already described",
      },
    ];

    runtime.useModel.mockResolvedValue(`<response>
  <title>Test Image</title>
  <description>A test image description</description>
  <text>This is a test image description.</text>
</response>`);

    const result = await processAttachments(attachments, runtime);

    expect(result).toHaveLength(3);
    // Only the first image should be processed
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(result[0].description).toBe("A test image description");
    expect(result[1]).toEqual(attachments[1]); // PDF unchanged
    expect(result[2]).toEqual(attachments[2]); // Already described image unchanged
  });

  it("should handle object response format for backwards compatibility", async () => {
    const imageAttachment: Media = {
      id: "image-1",
      url: "https://example.com/image.jpg",
      contentType: ContentType.IMAGE,
      source: "image/jpeg",
    };

    // Mock object response instead of XML
    runtime.useModel.mockResolvedValue({
      title: "Object Response Title",
      description: "Object response description",
      text: "Object response text",
    });

    const result = await processAttachments([imageAttachment], runtime);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Object Response Title");
    expect(result[0].description).toBe("Object response description");
    expect(result[0].text).toBe("Object response description");
  });

  it("should handle malformed XML responses gracefully", async () => {
    const imageAttachment: Media = {
      id: "image-1",
      url: "https://example.com/image.jpg",
      contentType: ContentType.IMAGE,
      source: "image/jpeg",
    };

    // Mock malformed XML response
    runtime.useModel.mockResolvedValue("This is not valid XML");

    const result = await processAttachments([imageAttachment], runtime);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(imageAttachment); // Should return original
    expect(runtime.logger.warn).toHaveBeenCalledWith(
      { src: "plugin:bootstrap", agentId: runtime.agentId },
      "Failed to parse XML response for image description",
    );
  });

  it("should handle errors during processing gracefully", async () => {
    const attachments: Media[] = [
      {
        id: "image-1",
        url: "https://example.com/image1.jpg",
        contentType: ContentType.IMAGE,
        source: "image/jpeg",
      },
      {
        id: "image-2",
        url: "https://example.com/image2.jpg",
        contentType: ContentType.IMAGE,
        source: "image/jpeg",
      },
    ];

    // Mock error for first image, success for second
    const mockUseModel = runtime.useModel as ReturnType<typeof vi.fn>;
    mockUseModel
      .mockRejectedValueOnce(new Error("Model API error"))
      .mockResolvedValueOnce(`<response>
  <title>Second Image</title>
  <description>Description of second image</description>
  <text>Detailed description of the second image</text>
</response>`);

    const result = await processAttachments(attachments, runtime);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(attachments[0]); // First image unchanged due to error
    expect(result[1].description).toBe("Description of second image");
    expect(runtime.logger.error).toHaveBeenCalledWith(
      {
        src: "plugin:bootstrap",
        agentId: runtime.agentId,
        error: expect.any(String),
      },
      "Error generating image description",
    );
  });

  it("should handle various image content types", async () => {
    const attachments: Media[] = [
      {
        id: "jpeg-image",
        url: "https://example.com/photo.jpg",
        contentType: ContentType.IMAGE,
        source: "image/jpeg",
      },
      {
        id: "png-image",
        url: "https://example.com/graphic.png",
        contentType: ContentType.IMAGE,
        source: "image/png",
      },
      {
        id: "webp-image",
        url: "https://example.com/modern.webp",
        contentType: ContentType.IMAGE,
        source: "image/webp",
      },
    ];

    let callCount = 0;
    runtime.useModel.mockImplementation(() => {
      callCount++;
      return Promise.resolve(`<response>
  <title>Image ${callCount}</title>
  <description>Description ${callCount}</description>
  <text>Text ${callCount}</text>
</response>`);
    });

    const result = await processAttachments(attachments, runtime);

    expect(result).toHaveLength(3);
    expect(runtime.useModel).toHaveBeenCalledTimes(3);

    result.forEach((attachment, index) => {
      expect(attachment.title).toBe(`Image ${index + 1}`);
      expect(attachment.description).toBe(`Description ${index + 1}`);
    });
  });

  it("should set default title when not provided in response", async () => {
    const imageAttachment: Media = {
      id: "image-1",
      url: "https://example.com/image.jpg",
      contentType: ContentType.IMAGE,
      source: "image/jpeg",
    };

    // Mock response without title
    runtime.useModel.mockResolvedValue(`<response>
  <description>A description without title</description>
  <text>This is the text content without a title.</text>
</response>`);

    const result = await processAttachments([imageAttachment], runtime);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Image"); // Default title
    expect(result[0].description).toBe("A description without title");
  });
});
