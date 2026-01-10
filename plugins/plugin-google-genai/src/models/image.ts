import type { IAgentRuntime, ImageDescriptionParams } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { fetch } from 'undici';
import { createGoogleGenAI, getSafetySettings, getImageModel } from '../utils/config';

export async function handleImageDescription(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string
) {
  const genAI = createGoogleGenAI(runtime);
  if (!genAI) {
    throw new Error('Google Generative AI client not initialized');
  }

  let imageUrl: string;
  let promptText: string | undefined;
  const modelName = getImageModel(runtime);
  logger.log(`[IMAGE_DESCRIPTION] Using model: ${modelName}`);

  if (typeof params === 'string') {
    imageUrl = params;
    promptText = 'Please analyze this image and provide a title and detailed description.';
  } else {
    imageUrl = params.imageUrl;
    promptText =
      params.prompt || 'Please analyze this image and provide a title and detailed description.';
  }

  try {
    // Fetch image data
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch image: ${imageResponse.statusText}`);
    }

    const imageData = await imageResponse.arrayBuffer();
    const base64Image = Buffer.from(imageData).toString('base64');

    // Determine MIME type from URL or response headers
    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';

    const response = await genAI.models.generateContent({
      model: modelName,
      contents: [
        {
          role: 'user',
          parts: [
            { text: promptText },
            {
              inlineData: {
                mimeType: contentType,
                data: base64Image,
              },
            },
          ],
        },
      ],
      config: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 8192,
        safetySettings: getSafetySettings(),
      },
    });

    const responseText = response.text || '';

    logger.log('Received response for image description');

    // Check if a custom prompt was provided
    const isCustomPrompt =
      typeof params === 'object' &&
      params.prompt &&
      params.prompt !== 'Please analyze this image and provide a title and detailed description.';

    // If custom prompt is used, return the raw content
    if (isCustomPrompt) {
      return responseText;
    }

    // Try to parse the response as JSON first
    try {
      const jsonResponse = JSON.parse(responseText);
      if (jsonResponse.title && jsonResponse.description) {
        return jsonResponse;
      }
    } catch (e) {
      // If not valid JSON, process as text
      logger.debug(`Parsing as JSON failed, processing as text: ${e}`);
    }

    // Extract title and description from text format
    const titleMatch = responseText.match(/title[:\s]+(.+?)(?:\n|$)/i);
    const title = titleMatch?.[1]?.trim() || 'Image Analysis';
    const description = responseText.replace(/title[:\s]+(.+?)(?:\n|$)/i, '').trim();

    return { title, description };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error analyzing image: ${message}`);
    return {
      title: 'Failed to analyze image',
      description: `Error: ${message}`,
    };
  }
}
