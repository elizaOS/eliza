/**
 * Image Generation Service
 * Generates images for monsters, characters, and locations using AI
 */

import { v4 as uuid } from 'uuid';

export type ImageProvider = 'openai' | 'fal';
export type ImageSubject = 'monster' | 'character' | 'location' | 'item' | 'scene';
export type ImageStyle = 'fantasy_art' | 'painted' | 'sketch' | 'realistic' | 'token';

export interface ImageGenerationOptions {
  provider?: ImageProvider;
  style?: ImageStyle;
  size?: '256x256' | '512x512' | '1024x1024';
  quality?: 'standard' | 'hd';
}

export interface GeneratedImage {
  id: string;
  url: string;
  prompt: string;
  subject: ImageSubject;
  style: ImageStyle;
  provider: ImageProvider;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

// Image cache to avoid regenerating
const imageCache = new Map<string, GeneratedImage>();

/**
 * Generate an image for a monster
 */
export async function generateMonsterImage(
  monster: {
    name: string;
    type: string;
    size: string;
    description?: string;
  },
  options: ImageGenerationOptions = {}
): Promise<GeneratedImage> {
  const cacheKey = `monster:${monster.name}:${options.style || 'fantasy_art'}`;
  const cached = imageCache.get(cacheKey);
  if (cached) return cached;

  const prompt = buildMonsterPrompt(monster, options.style || 'fantasy_art');
  const image = await generateImage(prompt, 'monster', options);
  
  imageCache.set(cacheKey, image);
  return image;
}

/**
 * Generate an image for a character
 */
export async function generateCharacterImage(
  character: {
    name: string;
    race: string;
    class: string;
    appearance?: string;
    equipment?: string[];
  },
  options: ImageGenerationOptions = {}
): Promise<GeneratedImage> {
  const cacheKey = `character:${character.name}:${options.style || 'fantasy_art'}`;
  const cached = imageCache.get(cacheKey);
  if (cached) return cached;

  const prompt = buildCharacterPrompt(character, options.style || 'fantasy_art');
  const image = await generateImage(prompt, 'character', options);
  
  imageCache.set(cacheKey, image);
  return image;
}

/**
 * Generate an image for a location
 */
export async function generateLocationImage(
  location: {
    name: string;
    type: string;
    description: string;
    atmosphere?: string;
    timeOfDay?: string;
  },
  options: ImageGenerationOptions = {}
): Promise<GeneratedImage> {
  const cacheKey = `location:${location.name}:${options.style || 'fantasy_art'}`;
  const cached = imageCache.get(cacheKey);
  if (cached) return cached;

  const prompt = buildLocationPrompt(location, options.style || 'fantasy_art');
  const image = await generateImage(prompt, 'location', options);
  
  imageCache.set(cacheKey, image);
  return image;
}

/**
 * Generate an image for a scene
 */
export async function generateSceneImage(
  scene: {
    description: string;
    characters?: string[];
    mood?: string;
    action?: string;
  },
  options: ImageGenerationOptions = {}
): Promise<GeneratedImage> {
  const prompt = buildScenePrompt(scene, options.style || 'fantasy_art');
  return await generateImage(prompt, 'scene', options);
}

/**
 * Generate a token image for a combatant
 */
export async function generateTokenImage(
  entity: {
    name: string;
    type: 'pc' | 'npc' | 'monster';
    race?: string;
    class?: string;
    monsterType?: string;
  },
  options: ImageGenerationOptions = {}
): Promise<GeneratedImage> {
  const prompt = buildTokenPrompt(entity);
  return await generateImage(prompt, entity.type === 'monster' ? 'monster' : 'character', {
    ...options,
    style: 'token',
    size: '256x256',
  });
}

/**
 * Core image generation function
 */
async function generateImage(
  prompt: string,
  subject: ImageSubject,
  options: ImageGenerationOptions
): Promise<GeneratedImage> {
  const provider = options.provider || 'openai';
  const style = options.style || 'fantasy_art';
  const size = options.size || '512x512';

  let url: string;

  if (provider === 'openai') {
    url = await generateWithOpenAI(prompt, size, options.quality);
  } else {
    url = await generateWithFal(prompt, size);
  }

  return {
    id: uuid(),
    url,
    prompt,
    subject,
    style,
    provider,
    createdAt: new Date(),
  };
}

/**
 * Generate image using OpenAI DALL-E
 */
async function generateWithOpenAI(
  prompt: string,
  size: string,
  quality?: 'standard' | 'hd'
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    console.warn('OpenAI API key not set, returning placeholder');
    return getPlaceholderImage();
  }

  try {
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: size === '256x256' ? '1024x1024' : size, // DALL-E 3 doesn't support 256
        quality: quality || 'standard',
      }),
    });

    const data = await response.json();
    
    if (data.error) {
      console.error('OpenAI error:', data.error);
      return getPlaceholderImage();
    }

    return data.data[0].url;
  } catch (error) {
    console.error('Failed to generate image with OpenAI:', error);
    return getPlaceholderImage();
  }
}

/**
 * Generate image using Fal AI
 */
async function generateWithFal(
  prompt: string,
  size: string
): Promise<string> {
  const apiKey = process.env.FAL_API_KEY;
  
  if (!apiKey) {
    console.warn('Fal API key not set, returning placeholder');
    return getPlaceholderImage();
  }

  try {
    const [width, height] = size.split('x').map(Number);
    
    const response = await fetch('https://fal.run/fal-ai/flux-pro', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${apiKey}`,
      },
      body: JSON.stringify({
        prompt,
        image_size: { width, height },
        num_inference_steps: 25,
        guidance_scale: 7.5,
      }),
    });

    const data = await response.json();
    
    if (data.error) {
      console.error('Fal error:', data.error);
      return getPlaceholderImage();
    }

    return data.images[0].url;
  } catch (error) {
    console.error('Failed to generate image with Fal:', error);
    return getPlaceholderImage();
  }
}

/**
 * Build prompt for monster images
 */
function buildMonsterPrompt(
  monster: { name: string; type: string; size: string; description?: string },
  style: ImageStyle
): string {
  const styleModifiers = getStyleModifiers(style);
  
  let prompt = `A ${monster.size.toLowerCase()} ${monster.type} monster called ${monster.name}`;
  
  if (monster.description) {
    prompt += `. ${monster.description}`;
  }
  
  prompt += `. ${styleModifiers}`;
  prompt += '. Dungeons and Dragons fantasy creature, menacing pose, detailed features.';
  
  return prompt;
}

/**
 * Build prompt for character images
 */
function buildCharacterPrompt(
  character: { name: string; race: string; class: string; appearance?: string; equipment?: string[] },
  style: ImageStyle
): string {
  const styleModifiers = getStyleModifiers(style);
  
  let prompt = `A heroic ${character.race} ${character.class}`;
  
  if (character.appearance) {
    prompt += `, ${character.appearance}`;
  }
  
  if (character.equipment && character.equipment.length > 0) {
    prompt += `, equipped with ${character.equipment.slice(0, 3).join(' and ')}`;
  }
  
  prompt += `. ${styleModifiers}`;
  prompt += '. Dungeons and Dragons fantasy character portrait, confident pose, detailed armor and weapons.';
  
  return prompt;
}

/**
 * Build prompt for location images
 */
function buildLocationPrompt(
  location: { name: string; type: string; description: string; atmosphere?: string; timeOfDay?: string },
  style: ImageStyle
): string {
  const styleModifiers = getStyleModifiers(style);
  
  let prompt = `A ${location.type} named ${location.name}. ${location.description}`;
  
  if (location.atmosphere) {
    prompt += ` The atmosphere is ${location.atmosphere}.`;
  }
  
  if (location.timeOfDay) {
    prompt += ` Scene set during ${location.timeOfDay}.`;
  }
  
  prompt += `. ${styleModifiers}`;
  prompt += '. Dungeons and Dragons fantasy landscape, atmospheric lighting, rich details.';
  
  return prompt;
}

/**
 * Build prompt for scene images
 */
function buildScenePrompt(
  scene: { description: string; characters?: string[]; mood?: string; action?: string },
  style: ImageStyle
): string {
  const styleModifiers = getStyleModifiers(style);
  
  let prompt = scene.description;
  
  if (scene.characters && scene.characters.length > 0) {
    prompt += ` Featuring ${scene.characters.join(', ')}.`;
  }
  
  if (scene.mood) {
    prompt += ` The mood is ${scene.mood}.`;
  }
  
  if (scene.action) {
    prompt += ` ${scene.action}.`;
  }
  
  prompt += `. ${styleModifiers}`;
  prompt += '. Dungeons and Dragons fantasy scene, dramatic composition, cinematic lighting.';
  
  return prompt;
}

/**
 * Build prompt for token images
 */
function buildTokenPrompt(
  entity: { name: string; type: string; race?: string; class?: string; monsterType?: string }
): string {
  let prompt: string;
  
  if (entity.type === 'monster') {
    prompt = `Circular token portrait of a ${entity.monsterType || 'creature'} called ${entity.name}`;
  } else {
    prompt = `Circular token portrait of a ${entity.race || 'humanoid'} ${entity.class || 'adventurer'} named ${entity.name}`;
  }
  
  prompt += '. Top-down RPG token style, clean borders, vibrant colors, transparent background, game asset.';
  
  return prompt;
}

/**
 * Get style modifiers for prompts
 */
function getStyleModifiers(style: ImageStyle): string {
  const modifiers: Record<ImageStyle, string> = {
    fantasy_art: 'High fantasy digital art style, vibrant colors, detailed illustration',
    painted: 'Oil painting style, rich textures, classical fantasy art',
    sketch: 'Detailed pencil sketch, crosshatching, hand-drawn illustration',
    realistic: 'Photorealistic rendering, dramatic lighting, cinematic quality',
    token: 'Clean digital art, bold outlines, game token style',
  };
  
  return modifiers[style];
}

/**
 * Get placeholder image when generation fails
 */
function getPlaceholderImage(): string {
  return 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjMmEyYTQwIi8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXNpemU9IjI0IiBmaWxsPSIjNjY2IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iLjNlbSI+SW1hZ2UgUGxhY2Vob2xkZXI8L3RleHQ+PC9zdmc+';
}

/**
 * Clear the image cache
 */
export function clearImageCache(): void {
  imageCache.clear();
}

/**
 * Get cached image by key
 */
export function getCachedImage(cacheKey: string): GeneratedImage | undefined {
  return imageCache.get(cacheKey);
}
