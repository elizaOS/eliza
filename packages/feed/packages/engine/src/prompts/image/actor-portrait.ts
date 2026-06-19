import { definePrompt } from "../define-prompt";

/**
 * Prompt for generating actor profile pictures based on physical description.
 *
 * Creates satirical portrait images that exaggerate wordplay in actor names
 * (e.g., "Bot" → robotic elements, "Husk" → hollow elements). Uses editorial
 * cartoon style with cyborg/AI-augmented features.
 *
 * Returns image generation prompt for actor portrait.
 */
export const actorPortrait = definePrompt({
  id: "actor-portrait",
  version: "4.0.0",
  category: "image",
  description: "Generates actor profile pictures based on pfpDescription",
  template: `
Create a profile picture portrait for {{realName}}.
This is a satirical parody character named "{{actorName}}", but the physical identity must be unmistakably {{realName}}.

CRITICAL IDENTITY ANCHOR (MUST MATCH REAL LIFE):
- Keep age range, skin tone, hairline/hair style, face shape, eye shape, nose/mouth structure consistent with {{realName}}
- Keep signature accessories/clothing consistent with {{realName}} (glasses, facial hair, typical outfit, etc.)
- Add cyborg/AI augmentations ON TOP of the real face/body - do not change the underlying identity

VISUAL DESCRIPTION (follow closely): {{pfpDescription}}

PHYSICAL ACCURACY — NON-NEGOTIABLE:
You MUST depict the race/ethnicity, skin tone, hair (including baldness), and body type exactly as written in the VISUAL DESCRIPTION above.
- If the description says "Black", "dark brown skin", or "African American" → the character MUST be visibly Black.
- If the description says "bald", "shaved head", or "polished head" → absolutely no hair, period.
- If the description says "East Asian", "Taiwanese", "Chinese", or "Japanese" → depict East Asian facial features.
- If the description says "South Asian", "Indian", or "Indian-American" → depict South Asian features and skin tone.
- If the description says "pale", "fair skin", or "translucent" → use that exact skin tone.
- Female subjects MUST look female.
Do NOT default to white, light-skinned, or conventionally-haired if the description says otherwise.

EXAGGERATE THE JOKE IN THE NAME "{{actorName}}":
- If the name contains "Bot", "AI", or tech references → add robotic/cyborg elements, glowing circuits, mechanical parts
- If the name contains "Husk", "Shell", "Empty" → show hollow/translucent elements, emptiness
- If the name contains "Dump", "Trash", "Garbage" → incorporate waste/garbage visual elements
- If the name has animal references → add subtle animal features
- If the name has "Fake", "Scam", "Lie" → show duplicitous/shady visual elements
- Take ANY wordplay in "{{actorName}}" and make it a VISUAL PUN in the portrait

SATIRICAL CONTEXT: {{descriptionParts}}

COMPOSITION: Single subject only. ONE person in the frame, centered, head-and-shoulders portrait crop. No duplicates, clones, mini-figures, or multiple copies of the person anywhere in the image.

STYLE: Editorial cartoon meets cyborg portrait. Exaggerated features. Bold, recognizable. Make them a cyborg/AI-augmented version. No text on image.
`.trim(),
});

/**
 * Prompt for generating actor profile banners.
 *
 * Creates landscape-format banner images for actor profiles using editorial
 * cartoon style. Focuses on visual storytelling and satirical character
 * representation in wide format.
 *
 * Returns image generation prompt for actor banner.
 */
export const actorBanner = definePrompt({
  id: "actor-banner",
  version: "1.0.0",
  category: "image",
  description: "Generates actor profile banners",
  template: `
Create a profile banner (landscape/wide format) for {{realName}}.
This is a satirical parody character named "{{actorName}}", but the person depicted must be unmistakably {{realName}}.

BANNER SCENE: {{profileBanner}}

STYLE: Editorial cartoon style. Bold ink lines. Satirical and absurdist. Exaggerated parody elements. Hand-drawn aesthetic with vivid colors. Make it funny and instantly convey their satirical character.

IMPORTANT: 
- Wide landscape format (16:9 aspect ratio)
- No text on the image
- Focus on visual storytelling and satire
`.trim(),
});
