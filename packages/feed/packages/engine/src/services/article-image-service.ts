/**
 * Article Image Generation Service
 *
 * Generates SATIRICAL PARODY cover images for articles using fal.ai's Flux AI models.
 * Images are uploaded to storage and URLs are returned for database storage.
 *
 * KEY FEATURES:
 * - Adds surreal/absurdist twists to ensure unique, non-IP-infringing imagery
 * - Uses satirical style prompt to avoid generating real logos/trademarks
 *
 * NOTE: Article content already uses parody names (BitcAIn, TeslAI, etc.)
 * via ArticleGenerator's character mapping. No additional name sanitization needed here.
 */

import { logger } from '@babylon/shared';
import { fal } from '@fal-ai/client';
import { articleCover, getRandomTwist, renderPrompt } from '../prompts';
import { formatError } from '../utils/error-utils';

interface FalImage {
  url: string;
  width?: number;
  height?: number;
  content_type?: string;
}

interface FalResponse {
  data: {
    images: FalImage[];
  };
}

interface ArticleImageParams {
  title: string;
  summary: string;
  category?: string;
}

/**
 * Initialize the fal.ai client with API key
 * Should be called once at startup
 */
export function initFalClient(): boolean {
  const falKey = process.env.FAL_KEY;
  if (!falKey) {
    logger.warn(
      'FAL_KEY not found - article image generation disabled',
      {},
      'ArticleImageService'
    );
    return false;
  }

  fal.config({
    credentials: falKey,
  });

  return true;
}

/**
 * Check if image generation is available
 */
export function isImageGenerationAvailable(): boolean {
  return Boolean(process.env.FAL_KEY);
}

/**
 * Generate a SATIRICAL PARODY cover image for an article (best-effort, non-blocking)
 *
 * This function never throws - errors are logged and null is returned.
 * This ensures image generation failures don't block tick execution.
 *
 * The prompt uses surreal/absurdist style with explicit IP avoidance rules
 * to ensure parody aesthetic and avoid generating real logos/trademarks.
 *
 * @param params - Article details for image generation (already using parody names)
 * @returns URL of the generated image, or null if generation fails
 */
export async function generateArticleImage(
  params: ArticleImageParams
): Promise<string | null> {
  if (!isImageGenerationAvailable()) {
    logger.debug(
      'Skipping article image generation - FAL_KEY not available',
      { title: params.title },
      'ArticleImageService'
    );
    return null;
  }

  // Add a random surreal twist for uniqueness and parody aesthetic
  const twist = getRandomTwist();

  const prompt = renderPrompt(articleCover, {
    title: params.title,
    summary: params.summary,
    category: params.category || 'general',
    twist,
  });

  logger.debug(
    'Generating satirical article cover image',
    {
      title: params.title,
      category: params.category,
      twist,
    },
    'ArticleImageService'
  );

  // EXCEPTION TO FAIL-FAST RULE: External API boundary
  // Image generation is non-critical - failures should not crash the game tick.
  // This try-catch is intentional per PR #651 review to ensure best-effort behavior.
  // fal.ai can fail for: network issues, rate limits, API changes, timeouts.
  let result: FalResponse;
  try {
    result = (await fal.subscribe('fal-ai/nano-banana-2', {
      input: {
        prompt,
        image_size: 'landscape_16_9',
        num_inference_steps: 4,
        num_images: 1,
      },
      logs: false,
    })) as FalResponse;
  } catch (error) {
    logger.warn(
      'fal.ai image generation failed (non-critical, continuing)',
      {
        title: params.title,
        error: formatError(error),
      },
      'ArticleImageService'
    );
    return null;
  }

  if (!result.data.images || result.data.images.length === 0) {
    logger.error(
      'No images returned from fal.ai',
      { title: params.title },
      'ArticleImageService'
    );
    return null;
  }

  const imageUrl = result.data.images[0]?.url;
  if (!imageUrl) {
    logger.error(
      'Image URL missing in fal.ai response',
      { title: params.title },
      'ArticleImageService'
    );
    return null;
  }

  logger.info(
    'Generated article cover image',
    { title: params.title, imageUrl },
    'ArticleImageService'
  );

  return imageUrl;
}

/**
 * Generate article image with retry logic
 *
 * @param params - Article details for image generation
 * @param maxRetries - Maximum number of retry attempts (default: 2)
 * @returns URL of the generated image, or null if all retries fail
 */
export async function generateArticleImageWithRetry(
  params: ArticleImageParams,
  maxRetries = 2
): Promise<string | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const imageUrl = await generateArticleImage(params);
    if (imageUrl) {
      return imageUrl;
    }

    if (attempt < maxRetries) {
      logger.warn(
        `Article image generation attempt ${attempt + 1} failed, retrying...`,
        { title: params.title },
        'ArticleImageService'
      );
      // Wait before retry (exponential backoff)
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, attempt))
      );
    }
  }

  logger.error(
    `Failed to generate article image after ${maxRetries + 1} attempts`,
    { title: params.title },
    'ArticleImageService'
  );
  return null;
}
