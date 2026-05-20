import { definePrompt } from '../define-prompt';

/**
 * Prompt for generating article cover images.
 *
 * Creates visually striking PARODY cover images for satirical news articles.
 * Uses surreal, absurdist elements to ensure uniqueness and avoid IP issues.
 * All imagery should be clearly satirical - never realistic depictions of
 * real-world logos, brands, or recognizable intellectual property.
 *
 * Returns image generation prompt for article cover.
 */
export const articleCover = definePrompt({
  id: 'article-cover',
  version: '2.0.0',
  category: 'image',
  description: 'Generates satirical parody cover images for news articles',
  template: `
Create a SATIRICAL PARODY cover image for a futuristic news article from an absurdist AI-dominated world.

ARTICLE TITLE: {{title}}

ARTICLE SUMMARY: {{summary}}

CATEGORY: {{category}}

SURREAL TWIST: {{twist}}

=== PARODY STYLE (CRITICAL) ===
This is for a SATIRICAL game world where everything is exaggerated and absurdist.
Think: The Onion meets Black Mirror meets Mad Magazine meets vaporwave.

VISUAL APPROACH:
- Surrealist and absurdist aesthetic - NOT realistic
- Retro-futuristic with glitch art elements
- Exaggerated proportions and impossible physics
- Dreamlike, satirical, tongue-in-cheek atmosphere
- Vaporwave, synthwave, or glitch aesthetics
- Over-the-top dramatic lighting with neon accents

=== STRICT IP AVOIDANCE (MANDATORY) ===
NEVER generate:
❌ Real cryptocurrency logos (Bitcoin, Ethereum, etc.)
❌ Real company logos or branding
❌ Real product designs
❌ Recognizable trademarks or symbols
❌ Famous buildings or landmarks
❌ Real currencies or their symbols

INSTEAD generate:
✅ Abstract geometric shapes suggesting concepts
✅ Fictional futuristic currency symbols (coins with silly faces, glowing orbs)
✅ Surreal satirical objects (melting computers, sentient algorithms as glowing blobs)
✅ Absurd parody imagery (robots doing mundane tasks, AI having existential crises)
✅ Generic symbolic representations with a twist

=== COMPOSITIONAL REQUIREMENTS ===
- Wide landscape format (16:9)
- NO TEXT OR WORDS in the image
- NO realistic human faces
- Use symbolic, metaphorical, or completely absurd imagery
- Add at least one element that makes the viewer think "wait, what?"
- Make it look like editorial art from a satirical magazine in the year 2099

=== EXAMPLES OF GOOD PARODY APPROACHES ===
- Instead of a Bitcoin logo: a golden coin with a confused robot face
- Instead of stock charts: melting abstract graphs floating in space
- Instead of tech company: a building made of circuit boards with googly eyes
- Instead of AI: a glowing geometric entity having an existential crisis
- Instead of money: floating abstract currency symbols that look like ancient runes

Create an image that is clearly SATIRICAL and UNIQUE - never something that could be mistaken for real-world IP.
`.trim(),
});

/**
 * Array of surreal twists to add to image prompts.
 * These inject absurdity and uniqueness to ensure parody aesthetic.
 */
export const SURREAL_TWISTS = [
  'Everything is slightly melting like a Salvador Dali painting',
  'Small robots are watching from unexpected corners',
  'The scene exists in a retrowave sunset void',
  'Geometric shapes float menacingly in the background',
  'The lighting suggests this takes place on a vaporwave grid',
  'Tiny AI entities (glowing orbs with expressions) observe the scene',
  'The perspective is slightly impossible, like an Escher drawing',
  'Everything has a subtle holographic shimmer',
  'The color palette is synthwave pink and cyan',
  'Abstract glitch artifacts tear through parts of the image',
  'The scene is reflected in infinite mirrors',
  'Crystalline structures grow from unexpected surfaces',
  'The atmosphere has a dreamy, ethereal fog',
  'Neon wireframe overlays hint at a simulation',
  'The scene exists inside a giant computer chip landscape',
  'Oversized circuit board patterns texture the environment',
  "Everything casts shadows that don't quite match the objects",
  'The sky is a gradient of impossible colors',
  'Floating mathematical symbols drift like particles',
  'The scene has a fisheye lens distortion effect',
] as const;

/**
 * Get a random surreal twist for image generation
 */
export function getRandomTwist(): string {
  const index = Math.floor(Math.random() * SURREAL_TWISTS.length);
  return SURREAL_TWISTS[index] ?? SURREAL_TWISTS[0]!;
}
