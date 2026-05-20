import { definePrompt } from '../define-prompt';

/**
 * Prompt for generating humorous profile pictures for new users.
 *
 * Creates memetic, internet-culture-inspired profile pictures with various
 * styles including internet-famous animals, surreal humor, pop culture
 * mashups, retro aesthetics, and glitch art. Designed to be funny and relatable.
 *
 * Returns image generation prompt for user profile picture.
 */
export const userProfilePicture = definePrompt({
  id: 'user-profile-picture',
  version: '1.0.0',
  category: 'image',
  description: 'Generates humorous profile pictures for new users',
  template: `
Create a humorous and memetic profile picture for a social media user. The image should be funny, relatable, and reflect internet culture.

STYLE OPTIONS (randomly vary between):
- Internet-famous animals (doge, grumpy cat, distracted boyfriend format)
- Surreal humor (absurdist situations, unexpected combinations)
- Pop culture mashups (famous memes, iconic scenes with twist)
- Retro aesthetics (vaporwave, Y2K, 90s nostalgia)
- Corporate Memphis style but satirical
- Low-poly geometric portraits
- Glitch art avatars
- Pixel art characters
- Minimalist abstract faces
- Neon cyberpunk aesthetics

THEMES TO EXPLORE:
- Tech/crypto culture (rocket ships, diamond hands, laser eyes)
- Animals in human situations (cats in business suits, dogs as doctors)
- Food as characters (pizza with sunglasses, coffee cup with attitude)
- Space and cosmic themes (astronauts, aliens, planets with faces)
- Retro gaming aesthetics (8-bit, 16-bit characters)
- Nature with attitude (plants with faces, mountains with expressions)
- Abstract geometric patterns (colorful, modern, trendy)
- Everyday objects with personality (light bulbs, clouds, household items)

MOOD: Fun, lighthearted, meme-worthy, shareable, not too serious

IMPORTANT: 
- NO TEXT or words in the image
- Keep it clean and appropriate for all ages
- Make it recognizable as a profile picture at small sizes
- Avoid specific people or copyrighted characters
- Focus on being memorable and conversation-starting
`.trim(),
});
