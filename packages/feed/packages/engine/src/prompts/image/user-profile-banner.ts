import { definePrompt } from "../define-prompt";

/**
 * Prompt for generating humorous profile banners for new users.
 *
 * Creates landscape-format banner images with memetic, internet-culture
 * aesthetics including vaporwave, Y2K nostalgia, glitch art, retro gaming,
 * and surreal dreamscapes. Designed to be funny, aesthetic, and trendy.
 *
 * Returns image generation prompt for user profile banner.
 */
export const userProfileBanner = definePrompt({
  id: "user-profile-banner",
  version: "1.0.0",
  category: "image",
  description: "Generates humorous profile banners for new users",
  template: `
Create a humorous and memetic profile banner for a social media user. The banner should be funny, aesthetic, and reflect internet culture. This is a LANDSCAPE image that will be used as a profile header/cover photo.

STYLE OPTIONS (randomly vary between):
- Vaporwave aesthetics (purple/pink gradients, retro computers, greek statues)
- Y2K nostalgia (chrome effects, butterflies, sparkles, early internet vibes)
- Corporate Memphis mockery (flat minimalist illustrations but absurd)
- Glitch art and datamoshing effects
- Retro gaming landscapes (pixel art cities, 8-bit horizons)
- Minimalist gradients (modern, clean, trendy color combinations)
- Space and cosmic scenes (nebulas, planets, stars with fun twist)
- Abstract geometric patterns (colorful, modern, Memphis-inspired)
- Surreal dreamscapes (impossible architecture, M.C. Escher vibes)
- Internet-core collages (Windows XP backgrounds, old screensavers, nostalgic UI)

THEMES TO EXPLORE:
- Tech utopia/dystopia (cyberpunk cities, retro-futuristic scenes)
- Nature but make it weird (glitchy forests, neon sunsets, impossible landscapes)
- Internet nostalgia (dial-up modems, floppy disks, old website aesthetics)
- Abstract minimalism (gradients, shapes, modern art vibes)
- Meme culture references (stonks graphs, rocket ships, diamond patterns)
- Retro computing (Windows 95, old Mac OS, terminal screens)
- Cosmic and psychedelic (trippy patterns, space vibes)
- Urban and neon (cyberpunk streets, Tokyo nights, neon signs)

MOOD: Cool, aesthetic, shareable, conversation-starting, slightly absurd

IMPORTANT: 
- NO TEXT or words in the image
- Landscape/wide format (16:9 aspect ratio)
- Keep it clean and appropriate for all ages
- Should look good as a banner/header image
- Avoid specific people or copyrighted characters
- Focus on aesthetic and vibe over detailed elements
`.trim(),
});
