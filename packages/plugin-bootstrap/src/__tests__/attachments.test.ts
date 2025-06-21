import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import { processAttachments } from '../index';
import { IAgentRuntime, Media, ModelType, ContentType, logger } from '@elizaos/core';
import { createMockRuntime, MockRuntime } from './test-utils';

// Mock the logger
mock.module('@elizaos/core', () => ({
  logger: {
    debug: mock(),
    warn: mock(),
    error: mock(),
    info: mock(),
  },
}));

describe('processAttachments', () => {
  let mockRuntime: MockRuntime;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });

  it('should return empty array for no attachments', async () => {
    const result = await processAttachments([], mockRuntime as IAgentRuntime);
    expect(result).toEqual([]);
  });

  it('should return empty array for null/undefined attachments', async () => {
    const result = await processAttachments(null as any, mockRuntime as IAgentRuntime);
    expect(result).toEqual([]);
  });

  it('should process image attachments and generate descriptions', async () => {
    const imageAttachment: Media = {
      id: 'image-1',
      url: 'https://example.com/image.jpg',
      contentType: ContentType.IMAGE,
      source: 'image/jpeg',
    };

    // Mock the image description model response
    mockRuntime.useModel = mock().mockResolvedValue(`<response>
  <title>Beautiful Sunset</title>
  <description>A stunning sunset over the ocean with vibrant colors</description>
  <text>This image captures a breathtaking sunset scene over a calm ocean. The sky is painted with brilliant hues of orange, pink, and purple as the sun dips below the horizon. Gentle waves lap at the shore, creating a peaceful and serene atmosphere.</text>
</response>`);

    const result = await processAttachments([imageAttachment], mockRuntime as IAgentRuntime);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('image-1');
    expect(result[0].title).toBe('Beautiful Sunset');
    expect(result[0].description).toBe('A stunning sunset over the ocean with vibrant colors');
    expect(result[0].text).toBe(
      'This image captures a breathtaking sunset scene over a calm ocean. The sky is painted with brilliant hues of orange, pink, and purple as the sun dips below the horizon. Gentle waves lap at the shore, creating a peaceful and serene atmosphere.'
    );

    expect(mockRuntime.useModel).toHaveBeenCalledWith(ModelType.IMAGE_DESCRIPTION, {
      prompt: expect.stringContaining('Analyze the provided image'),
      imageUrl: 'https://example.com/image.jpg',
    });
  });

  it('should skip processing for images that already have descriptions', async () => {
    const imageWithDescription: Media = {
      id: 'image-2',
      url: 'https://example.com/described.jpg',
      contentType: ContentType.IMAGE,
      source: 'image/jpeg',
      description: 'Already has a description',
      title: 'Existing Title',
      text: 'Existing text',
    };

    const result = await processAttachments([imageWithDescription], mockRuntime as IAgentRuntime);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(imageWithDescription);
    expect(mockRuntime.useModel).not.toHaveBeenCalled();
  });

  it('should handle non-image attachments without processing', async () => {
    const pdfAttachment: Media = {
      id: 'pdf-1',
      url: 'https://example.com/document.pdf',
      source: 'application/pdf',
      title: 'PDF Document',
    };

    const result = await processAttachments([pdfAttachment], mockRuntime as IAgentRuntime);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(pdfAttachment);
    expect(mockRuntime.useModel).not.toHaveBeenCalled();
  });

  it('should handle mixed attachment types', async () => {
    const attachments: Media[] = [
      {
        id: 'image-1',
        url: 'https://example.com/image1.jpg',
        contentType: ContentType.IMAGE,
        source: 'image/jpeg',
      },
      {
        id: 'pdf-1',
        url: 'https://example.com/doc.pdf',
        source: 'application/pdf',
      },
      {
        id: 'image-2',
        url: 'https://example.com/image2.png',
        contentType: ContentType.IMAGE,
        source: 'image/png',
        description: 'Already described',
      },
    ];

    mockRuntime.useModel = mock().mockResolvedValue(`<response>
  <title>Test Image</title>
  <description>A test image description</description>
  <text>Detailed description of the test image</text>
</response>`);

    const result = await processAttachments(attachments, mockRuntime as IAgentRuntime);

    expect(result).toHaveLength(3);
    // Only the first image should be processed
    expect(mockRuntime.useModel).toHaveBeenCalledTimes(1);
    expect(result[0].description).toBe('A test image description');
    expect(result[1]).toEqual(attachments[1]); // PDF unchanged
    expect(result[2]).toEqual(attachments[2]); // Already described image unchanged
  });

  it('should handle object response format for backwards compatibility', async () => {
    const imageAttachment: Media = {
      id: 'image-1',
      url: 'https://example.com/image.jpg',
      contentType: ContentType.IMAGE,
      source: 'image/jpeg',
    };

    // Mock object response instead of XML
    mockRuntime.useModel = mock().mockResolvedValue({
      title: 'Object Response Title',
      description: 'Object response description',
      text: 'Object response text',
    });

    const result = await processAttachments([imageAttachment], mockRuntime as IAgentRuntime);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Object Response Title');
    expect(result[0].description).toBe('Object response description');
    expect(result[0].text).toBe('Object response description');
  });

  it('should handle malformed XML responses gracefully', async () => {
    const imageAttachment: Media = {
      id: 'image-1',
      url: 'https://example.com/image.jpg',
      contentType: ContentType.IMAGE,
      source: 'image/jpeg',
    };

    // Mock malformed XML response
    mockRuntime.useModel = mock().mockResolvedValue('This is not valid XML');

    const result = await processAttachments([imageAttachment], mockRuntime as IAgentRuntime);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(imageAttachment); // Should return original
    expect(logger.warn).toHaveBeenCalledWith(
      '[Bootstrap] Failed to parse XML response for image description'
    );
  });

  it('should handle errors during processing gracefully', async () => {
    const attachments: Media[] = [
      {
        id: 'image-1',
        url: 'https://example.com/image1.jpg',
        contentType: ContentType.IMAGE,
        source: 'image/jpeg',
      },
      {
        id: 'image-2',
        url: 'https://example.com/image2.jpg',
        contentType: ContentType.IMAGE,
        source: 'image/jpeg',
      },
    ];

    // Mock error for first image, success for second
    mockRuntime.useModel = mock().mockRejectedValueOnce(new Error('Model API error'))
      .mockResolvedValueOnce(`<response>
  <title>Second Image</title>
  <description>Description of second image</description>
  <text>Detailed description of the second image</text>
</response>`);

    const result = await processAttachments(attachments, mockRuntime as IAgentRuntime);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(attachments[0]); // First image unchanged due to error
    expect(result[1].description).toBe('Description of second image');
    expect(logger.error).toHaveBeenCalledWith(
      '[Bootstrap] Error generating image description:',
      expect.any(Error)
    );
  });

  it('should handle various image content types', async () => {
    const attachments: Media[] = [
      {
        id: 'jpeg-image',
        url: 'https://example.com/photo.jpg',
        contentType: ContentType.IMAGE,
        source: 'image/jpeg',
      },
      {
        id: 'png-image',
        url: 'https://example.com/graphic.png',
        contentType: ContentType.IMAGE,
        source: 'image/png',
      },
      {
        id: 'webp-image',
        url: 'https://example.com/modern.webp',
        contentType: ContentType.IMAGE,
        source: 'image/webp',
      },
    ];

    let callCount = 0;
    mockRuntime.useModel = mock().mockImplementation(() => {
      callCount++;
      return Promise.resolve(`<response>
  <title>Image ${callCount}</title>
  <description>Description ${callCount}</description>
  <text>Text ${callCount}</text>
</response>`);
    });

    const result = await processAttachments(attachments, mockRuntime as IAgentRuntime);

    expect(result).toHaveLength(3);
    expect(mockRuntime.useModel).toHaveBeenCalledTimes(3);

    result.forEach((attachment, index) => {
      expect(attachment.title).toBe(`Image ${index + 1}`);
      expect(attachment.description).toBe(`Description ${index + 1}`);
    });
  });

  it('should set default title when not provided in response', async () => {
    const imageAttachment: Media = {
      id: 'image-1',
      url: 'https://example.com/image.jpg',
      contentType: ContentType.IMAGE,
      source: 'image/jpeg',
    };

    // Mock response without title
    mockRuntime.useModel = mock().mockResolvedValue(`<response>
  <description>A description without title</description>
  <text>Detailed text without title</text>
</response>`);

    const result = await processAttachments([imageAttachment], mockRuntime as IAgentRuntime);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Image'); // Default title
    expect(result[0].description).toBe('A description without title');
  });
});
