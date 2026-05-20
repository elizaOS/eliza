import { definePrompt } from '../define-prompt';

/**
 * Prompt for generating logos for organizations based on description.
 *
 * Creates satirical logo designs that parody real company logos with
 * exaggerated editorial cartoon style. Uses bold ink lines and absurdist
 * humor while maintaining recognizability.
 *
 * Returns image generation prompt for organization logo.
 */
export const organizationLogo = definePrompt({
  id: 'organization-logo',
  version: '3.0.0',
  category: 'image',
  description: 'Generates a logo for organizations based on pfpDescription',
  template: `
Create a logo for {{organizationName}} (satirical parody of {{originalCompany}}).

LOGO DESIGN: {{pfpDescription}}

STYLE: Hand-drawn editorial cartoon style with exaggerated parody elements, bold ink lines, absurdist humor touches. Make it instantly recognizable as a parody of {{originalCompany}}'s logo but with clear satirical elements.

IMPORTANT:
- Square format for profile picture use
- No text on the image (visual elements only)
- Keep it bold and recognizable at small sizes
`.trim(),
});

/**
 * Prompt for generating organization profile banners.
 *
 * Creates landscape-format banner images for organization profiles using
 * editorial cartoon style. Focuses on corporate satire and visual
 * storytelling in wide format.
 *
 * Returns image generation prompt for organization banner.
 */
export const organizationBanner = definePrompt({
  id: 'organization-banner',
  version: '1.0.0',
  category: 'image',
  description: 'Generates organization profile banners',
  template: `
Create a profile banner (landscape/wide format) for {{organizationName}} (satirical parody of {{originalCompany}}).

BANNER SCENE: {{bannerDescription}}

STYLE: Editorial cartoon style. Bold ink lines. Satirical and absurdist. Exaggerated parody elements. Hand-drawn aesthetic with vivid colors. Make it funny and instantly convey the organization's satirical nature.

IMPORTANT: 
- Wide landscape format (16:9 aspect ratio)
- No text on the image
- Focus on visual storytelling and corporate satire
`.trim(),
});
