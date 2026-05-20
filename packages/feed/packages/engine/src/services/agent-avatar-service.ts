/**
 * Agent profile avatar generation via fal.ai (Nano Banana 2).
 *
 * Produces a unique monkey-style mascot avatar. When a publicly reachable
 * reference image URL is configured, uses image-to-image editing to match
 * that style; otherwise text-to-image with a detailed style prompt.
 */

import { logger } from '@feed/shared';
import { fal } from '@fal-ai/client';
import { formatError } from '../utils/error-utils';
import {
  initFalClient,
  isImageGenerationAvailable,
} from './article-image-service';

interface FalImage {
  url: string;
  width?: number;
  height?: number;
  content_type?: string;
}

interface FalT2IResponse {
  data: {
    images: FalImage[];
  };
}

interface FalEditResponse {
  data: {
    images: FalImage[];
  };
}

export interface GenerateAgentMonkeyAvatarParams {
  /** Optional agent display name for subtle uniqueness in the prompt */
  displayName?: string;
  /** Override reference image (must be publicly fetchable by fal.ai) */
  referenceImageUrl?: string | null;
}

function buildVariationHint(displayName?: string): string {
  const base = displayName?.trim().slice(0, 80);
  if (base) {
    return `This agent is named "${base}" — reflect a distinct, friendly personality in expression or accessories (still a monkey mascot).`;
  }
  return 'Make this monkey visually distinct from typical stock avatars.';
}

function buildTextToImagePrompt(
  params: GenerateAgentMonkeyAvatarParams
): string {
  const hint = buildVariationHint(params.displayName);
  return [
    'Square profile picture, head and shoulders, centered.',
    'A cute 3D-rendered monkey mascot character: soft rounded shapes, expressive eyes, subtle smile, plush-toy / collectible-figure aesthetic.',
    'Clean simple background (soft gradient or light studio), no clutter.',
    hint,
    'Family-friendly. No text, no labels, no numbers, no letters, no logos, no watermarks, no real human faces.',
  ].join(' ');
}

function buildEditPrompt(params: GenerateAgentMonkeyAvatarParams): string {
  const hint = buildVariationHint(params.displayName);
  return [
    'Create a NEW unique monkey character avatar for a social trading bot profile.',
    'Match the art style, rendering quality, lighting, and mascot vibe of the reference image, but the result must be a clearly different monkey:',
    'different fur tones or markings, face shape, eye style, expression, or a small accessory (hat, collar, glasses) — not a copy.',
    'Square head-and-shoulders composition, centered, soft clean background.',
    hint,
    'No text, no labels, no numbers, no letters, no logos, no watermarks, family-friendly.',
  ].join(' ');
}

/**
 * Generate a monkey-style agent avatar; returns a temporary fal.media URL or null.
 */
export async function generateAgentMonkeyProfileImage(
  params: GenerateAgentMonkeyAvatarParams = {}
): Promise<string | null> {
  if (!isImageGenerationAvailable()) {
    logger.debug(
      'Skipping agent avatar generation — FAL_KEY not set',
      {},
      'AgentAvatarService'
    );
    return null;
  }

  initFalClient();

  const referenceUrl =
    params.referenceImageUrl !== undefined
      ? params.referenceImageUrl?.trim() || null
      : process.env.AGENT_AVATAR_REFERENCE_IMAGE_URL?.trim() || null;

  try {
    if (referenceUrl) {
      const result = (await fal.subscribe('fal-ai/nano-banana-2/edit', {
        input: {
          prompt: buildEditPrompt(params),
          image_urls: [referenceUrl],
          num_images: 1,
          aspect_ratio: '1:1',
          output_format: 'png',
          resolution: '1K',
          limit_generations: true,
        },
        logs: false,
      })) as FalEditResponse;

      const url = result.data.images[0]?.url;
      if (!url) {
        logger.warn(
          'fal edit returned no image URL for agent avatar',
          {},
          'AgentAvatarService'
        );
        return null;
      }
      return url;
    }

    const result = (await fal.subscribe('fal-ai/nano-banana-2', {
      input: {
        prompt: buildTextToImagePrompt(params),
        image_size: 'square',
        num_images: 1,
        num_inference_steps: 4,
      },
      logs: false,
    })) as FalT2IResponse;

    const url = result.data.images[0]?.url;
    if (!url) {
      logger.warn(
        'fal t2i returned no image URL for agent avatar',
        {},
        'AgentAvatarService'
      );
      return null;
    }
    return url;
  } catch (error) {
    logger.warn(
      'fal.ai agent avatar generation failed',
      { error: formatError(error) },
      'AgentAvatarService'
    );
    return null;
  }
}
