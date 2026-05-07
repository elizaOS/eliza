import {
  type Action,
  type ActionExample,
  type ActionResult,
  ContentType,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
} from "@elizaos/core";
import { v4 } from "uuid";
import { ensureElizaCloudUrl, isFalAiUrl, uploadBase64Image } from "@/lib/blob";
import type { AffiliateData } from "@/lib/types/affiliate";

interface AffiliateImageConfig {
  isAffiliateCharacter: boolean;
  vibe?: string;
  referenceImageUrls: string[];
  primaryImageUrl?: string;
  cachedAppearanceDescription?: string;
}

const appearanceDescriptionCache = new Map<string, string>();

type ParsedXml = Record<string, string>;

function parseXmlSafe(input: string): ParsedXml {
  const parsed = parseKeyValueXml(input);
  if (!parsed || typeof parsed !== "object") return {};

  const result: ParsedXml = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

function extractAffiliateImageConfig(
  settings: Record<string, unknown> | undefined,
): AffiliateImageConfig {
  const result: AffiliateImageConfig = {
    isAffiliateCharacter: false,
    referenceImageUrls: [],
  };

  const affiliateData = settings?.affiliateData as Partial<AffiliateData> | undefined;
  if (!affiliateData) return result;

  const vibe = affiliateData.vibe;
  const imageUrls = affiliateData.imageUrls;

  // Check if this is an affiliate character (source indicates miniapp or affiliate)
  // Reference images are now optional - autoImage flag is what matters
  result.isAffiliateCharacter = !!(
    affiliateData.source ||
    affiliateData.affiliateId ||
    affiliateData.autoImage
  );
  result.vibe = typeof vibe === "string" ? vibe : undefined;

  if (Array.isArray(imageUrls)) {
    result.referenceImageUrls = imageUrls.filter(
      (url): url is string =>
        typeof url === "string" && url.startsWith("http") && !url.startsWith("data:"),
    );
    result.primaryImageUrl = result.referenceImageUrls[0];
  }

  if (
    affiliateData.appearanceDescription &&
    typeof affiliateData.appearanceDescription === "string"
  ) {
    result.cachedAppearanceDescription = affiliateData.appearanceDescription;
  }

  return result;
}

const appearanceExtractionPrompt = `You are analyzing a photo to extract EXTREMELY DETAILED physical appearance characteristics.

Your task is to describe this person's appearance with MAXIMUM PRECISION so that an AI image generator can recreate their exact look.

###########################################
# CRITICAL - GENDER IDENTIFICATION FIRST #
###########################################

FIRST AND MOST IMPORTANT: Identify the GENDER of the person in this photo.
- Is this a WOMAN/FEMALE or a MAN/MALE?
- This MUST be the FIRST word in your description
- Getting gender wrong is an UNACCEPTABLE error

Analyze and describe IN EXTREME DETAIL:

0. GENDER (MANDATORY FIRST):
   - State clearly: "woman" or "man" (this MUST be the first word)
   - Approximate age range (young woman in her 20s, man in his 30s, etc.)

1. FACE STRUCTURE (be very specific):
   - Face shape (oval, round, square, heart, oblong, diamond)
   - Jawline (sharp, soft, angular, rounded)
   - Cheekbones (high, low, prominent, subtle)
   - Chin shape (pointed, rounded, square, cleft)
   - Forehead (high, low, wide, narrow)

2. EYES (critical for likeness):
   - Eye color (exact shade: e.g., "light blue-green", "dark brown", "hazel with gold flecks")
   - Eye shape (almond, round, hooded, downturned, upturned, monolid)
   - Eye size (large, medium, small relative to face)
   - Eyelid type (single, double, hooded)
   - Distance between eyes (close-set, wide-set, average)

3. EYEBROWS (very distinctive feature):
   - Shape (arched, straight, rounded, angular)
   - Thickness (thick, thin, medium, bushy)
   - Color (match hair or different?)
   - Any distinctive characteristics (e.g., "bold thick straight brows")

4. NOSE:
   - Shape (straight, Roman, button, upturned, aquiline)
   - Size (small, medium, large, wide, narrow)
   - Bridge (high, low, bumped)
   - Tip shape (rounded, pointed, bulbous)

5. LIPS & MOUTH:
   - Lip shape (full, thin, cupid's bow, heart-shaped)
   - Lip size (full upper/lower, thin upper/lower)
   - Mouth width (wide, narrow, average)

6. HAIR (essential for recognition):
   - Color (be VERY specific: "platinum blonde", "dark chestnut brown", "black with blue undertones")
   - Length (pixie, chin-length, shoulder, mid-back, long)
   - Texture (straight, wavy, curly, coily)
   - Style visible in photo
   - Thickness (fine, medium, thick)
   - Hairline shape

7. SKIN:
   - Skin tone (very fair, fair, light, medium, olive, tan, brown, dark brown, deep)
   - Undertone (warm, cool, neutral)
   - Any distinctive marks (freckles, beauty marks, dimples)
   - Texture (smooth, textured)

8. OVERALL DISTINCTIVE FEATURES:
   - What makes this person instantly recognizable?
   - Any unique characteristics?
   - Ethnic appearance cues

Your response MUST be in this XML format:
<response>
  <gender>woman OR man (just one word)</gender>
  <appearance>MUST START WITH GENDER: "young woman, ..." or "young man, ..." then followed by all physical features. Example for a woman: "young woman, platinum blonde straight shoulder-length hair, bold thick straight dark eyebrows, piercing blue-green eyes, almond-shaped eyes, high cheekbones, defined jawline, fair skin with light freckles, full lips, small straight nose, heart-shaped face" - Example for a man: "young man, short dark brown wavy hair, brown eyes, strong jawline, light stubble, medium skin tone, athletic build"</appearance>
</response>

CRITICAL: The <gender> field and the first word of <appearance> MUST match. If you see a woman, write "woman". If you see a man, write "man". NEVER get this wrong.`;

async function getOrExtractAppearanceDescription(
  runtime: IAgentRuntime,
  config: AffiliateImageConfig,
  characterId?: string,
): Promise<string | null> {
  if (config.cachedAppearanceDescription) {
    logger.info("[GENERATE_IMAGE] 📋 Using cached appearance description");
    return config.cachedAppearanceDescription;
  }

  const cacheKey = characterId || config.referenceImageUrls.join(",");
  const cached = appearanceDescriptionCache.get(cacheKey);
  if (cached) {
    logger.info("[GENERATE_IMAGE] 📋 Using in-memory cached appearance description");
    return cached;
  }

  if (config.referenceImageUrls.length === 0) {
    return null;
  }

  logger.info(
    `[GENERATE_IMAGE] 🔬 Extracting appearance using VISION MODEL from ${config.referenceImageUrls.length} reference images...`,
  );

  const imageUrls = config.referenceImageUrls.slice(0, 4);
  const appearanceDescriptions: string[] = [];
  const detectedGenders: string[] = [];

  for (let i = 0; i < imageUrls.length; i++) {
    const imageUrl = imageUrls[i];
    logger.info(
      `[GENERATE_IMAGE] 🔍 Analyzing reference image ${i + 1}/${imageUrls.length} with vision model...`,
    );

    try {
      const visionResult = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
        imageUrl: imageUrl,
        prompt: appearanceExtractionPrompt,
      });

      if (visionResult) {
        let descriptionText = "";
        if (typeof visionResult === "string") {
          descriptionText = visionResult;
        } else if (
          typeof visionResult === "object" &&
          visionResult !== null &&
          "description" in visionResult
        ) {
          const description = (visionResult as { description: unknown }).description;
          if (typeof description === "string") {
            descriptionText = description;
          }
        }

        if (descriptionText) {
          const parsed = parseXmlSafe(descriptionText);
          let appearance = parsed.appearance || descriptionText;
          const gender = parsed.gender?.toLowerCase().trim();

          if (gender === "woman" || gender === "man") {
            detectedGenders.push(gender);
            logger.info(`[GENERATE_IMAGE] 👤 Image ${i + 1} detected gender: ${gender}`);
          }

          if (appearance && typeof appearance === "string" && appearance.length > 20) {
            if (
              !appearance.toLowerCase().startsWith("woman") &&
              !appearance.toLowerCase().startsWith("man") &&
              !appearance.toLowerCase().startsWith("young woman") &&
              !appearance.toLowerCase().startsWith("young man")
            ) {
              if (gender) {
                appearance = `${gender}, ${appearance}`;
              }
            }
            logger.info(
              `[GENERATE_IMAGE] ✅ Image ${i + 1} appearance: "${appearance.substring(0, 80)}..."`,
            );
            appearanceDescriptions.push(appearance);
          }
        }
      }
    } catch (imgError) {
      logger.warn(
        `[GENERATE_IMAGE] ⚠️ Failed to analyze image ${i + 1}: ${imgError instanceof Error ? imgError.message : String(imgError)}`,
      );
    }
  }

  try {
    const dominantGender =
      detectedGenders.length > 0
        ? detectedGenders.filter((g) => g === "woman").length >=
          detectedGenders.filter((g) => g === "man").length
          ? "woman"
          : "man"
        : null;

    if (dominantGender) {
      logger.info(
        `[GENERATE_IMAGE] 👤 Dominant gender detected: ${dominantGender} (from ${detectedGenders.length} images)`,
      );
    }

    if (appearanceDescriptions.length === 0) {
      logger.warn("[GENERATE_IMAGE] ⚠️ Could not extract appearance from any reference images");
      return null;
    }

    let finalAppearance: string;
    if (appearanceDescriptions.length === 1) {
      finalAppearance = appearanceDescriptions[0];
    } else {
      logger.info("[GENERATE_IMAGE] 🧩 Combining appearance descriptions from multiple images...");
      const genderInstruction = dominantGender
        ? `CRITICAL: This is a ${dominantGender.toUpperCase()}. Your description MUST start with "${dominantGender}".`
        : "";

      const combinePrompt = `I have ${appearanceDescriptions.length} appearance descriptions of the SAME PERSON from different photos. Combine them into ONE comprehensive, detailed appearance description that captures ALL distinctive features.

${genderInstruction}

Descriptions:
${appearanceDescriptions.map((d, i) => `Photo ${i + 1}: ${d}`).join("\n\n")}

Create a SINGLE, COMPREHENSIVE appearance description that:
1. MUST start with the gender ("woman" or "man") - this is CRITICAL
2. Includes ALL physical features mentioned across all descriptions
3. Prioritizes the most distinctive/recognizable features first
4. Resolves any minor inconsistencies by using the most detailed description
5. Is formatted as a dense, comma-separated list of visual attributes

Your response MUST be in this XML format:
<response>
  <appearance>woman, ... OR man, ... (MUST start with gender)</appearance>
</response>`;

      const combineResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: combinePrompt,
      });

      const combineParsed = parseXmlSafe(combineResponse);
      finalAppearance = combineParsed.appearance || appearanceDescriptions.join(", ");
    }

    if (dominantGender && !finalAppearance.toLowerCase().startsWith(dominantGender)) {
      const startsWithOtherGender =
        (dominantGender === "woman" && finalAppearance.toLowerCase().startsWith("man")) ||
        (dominantGender === "man" && finalAppearance.toLowerCase().startsWith("woman"));
      if (startsWithOtherGender) {
        finalAppearance = finalAppearance.replace(/^(wo)?man,?\s*/i, `${dominantGender}, `);
        logger.info(`[GENERATE_IMAGE] 🔄 Corrected gender mismatch to: ${dominantGender}`);
      } else if (!finalAppearance.toLowerCase().startsWith("young " + dominantGender)) {
        finalAppearance = `${dominantGender}, ${finalAppearance}`;
        logger.info(`[GENERATE_IMAGE] ➕ Prepended gender: ${dominantGender}`);
      }
    }

    logger.info(
      `[GENERATE_IMAGE] ✅ Final combined appearance: "${finalAppearance.substring(0, 120)}..."`,
    );
    appearanceDescriptionCache.set(cacheKey, finalAppearance);
    return finalAppearance;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[GENERATE_IMAGE] ❌ Failed to extract appearance: ${errorMessage}`);
    return null;
  }
}

interface AppearanceGenerationConfig {
  appearanceDescription: string;
  hasValidAppearance: true;
}

interface AppearanceGenerationFallback {
  hasValidAppearance: false;
  fallbackReason: string;
}

type AppearanceResult = AppearanceGenerationConfig | AppearanceGenerationFallback;

async function prepareAppearanceBasedGeneration(
  runtime: IAgentRuntime,
  config: AffiliateImageConfig,
  characterId?: string,
): Promise<AppearanceResult> {
  if (config.referenceImageUrls.length === 0) {
    return {
      hasValidAppearance: false,
      fallbackReason: "No reference images available for appearance extraction",
    };
  }

  logger.info(
    `[GENERATE_IMAGE] 🔬 Preparing appearance-based generation from ${config.referenceImageUrls.length} reference images`,
  );

  const appearanceDescription = await getOrExtractAppearanceDescription(
    runtime,
    config,
    characterId,
  );

  if (appearanceDescription) {
    logger.info(
      `[GENERATE_IMAGE] ✅ Appearance ready: "${appearanceDescription.substring(0, 80)}..."`,
    );
    return {
      appearanceDescription,
      hasValidAppearance: true,
    };
  }

  return {
    hasValidAppearance: false,
    fallbackReason: "Failed to extract appearance description from reference images",
  };
}

/**
 * Check if a string is a base64 data URL
 */
function isBase64DataUrl(url: string): boolean {
  return typeof url === "string" && url.startsWith("data:");
}

/**
 * Convert base64 data URL to blob storage URL with retry logic
 * This is CRITICAL for preventing token limit exhaustion
 * Retries up to 3 times with exponential backoff to ensure images are persisted
 */
async function ensureBlobUrl(imageUrl: string, userId?: string): Promise<string | null> {
  if (!isBase64DataUrl(imageUrl)) {
    // Check if it's a Fal.ai URL - if so, upload to our storage
    if (isFalAiUrl(imageUrl)) {
      logger.info("[GENERATE_IMAGE] Fal.ai URL detected, uploading to our storage...");
      try {
        const timestamp = Date.now();
        const ourUrl = await ensureElizaCloudUrl(imageUrl, {
          filename: `generated-${timestamp}.png`,
          folder: "images",
          userId: userId || "system",
          contentType: "image/png",
          fallbackToOriginal: false, // Don't fallback - we want to hide Fal.ai URLs
        });
        logger.info(`[GENERATE_IMAGE] ✅ Uploaded Fal.ai image to our storage: ${ourUrl}`);
        return ourUrl;
      } catch (error) {
        logger.error(
          "[GENERATE_IMAGE] ❌ Failed to upload Fal.ai URL to our storage:",
          error instanceof Error ? error.message : String(error),
        );
        // Return null to prevent exposing Fal.ai URL
        return null;
      }
    }

    // Already a proper URL from our storage or other source, return as-is
    logger.info("[GENERATE_IMAGE] Image URL is already a valid HTTP URL, using directly");
    return imageUrl;
  }

  logger.info("[GENERATE_IMAGE] Converting base64 to blob storage to prevent token bloat");

  const timestamp = Date.now();
  const result = await uploadBase64Image(imageUrl, {
    filename: `generated-${timestamp}.png`,
    folder: "images",
    userId: userId || "system",
  });

  logger.info(`[GENERATE_IMAGE] ✅ Successfully uploaded to blob: ${result.url}`);
  return result.url;
}

/**
 * Template for generating an image for the character using a prompt.
 *
 * @type {string}
 */
const imageGenerationTemplate = `# Task: Generate an image prompt based on the user's request.
  
  # Instructions:
  Based on the user's message in the conversation, write a clear, concise, and visually descriptive prompt for image generation. Focus only on what the user wants to see, extract the key visual elements from the request, and formulate a detailed prompt suitable for image generation.

  {{receivedMessageHeader}}
  
  Your response should be formatted in XML like this:
  <response>
    <prompt>Your image generation prompt here</prompt>
  </response>
  
  Your response should include the valid XML block and nothing else.`;

/**
 * Template for generating images that match a specific person's appearance.
 * Used when reference images are exhausted and we need to generate new ones.
 */
const appearanceBasedImageTemplate = `# Task: Generate an image that EXACTLY matches the person's appearance.

{{providers}}

###########################################
# CRITICAL - GENDER AND APPEARANCE MATCH #
###########################################

The person you are generating MUST match this EXACT description:
{{appearanceDescription}}

## ABSOLUTE REQUIREMENTS (NEVER VIOLATE):
1. GENDER: If the description says "woman" - generate a WOMAN. If it says "man" - generate a MAN. NEVER swap genders.
2. HAIR: EXACT color, length, and style as described
3. EYES: EXACT color and shape as described
4. FACE: Match the described facial structure, jawline, cheekbones
5. SKIN: EXACT skin tone as described
6. DISTINCTIVE FEATURES: Include all mentioned features (eyebrows, freckles, etc.)

## Image Style:
- Romantic/flirty selfie or personal photo
- Soft, flattering lighting
- High quality, photorealistic
- Appropriate pose (cute, flirty, confident)

# Recent conversation:
{{conversationLog}}

# OUTPUT FORMAT:
Your prompt MUST start with the gender and key features from the appearance description.

Example for a woman: "photorealistic portrait of a young woman, platinum blonde straight hair, blue-green eyes, bold dark eyebrows, fair skin, high cheekbones, romantic selfie pose, soft lighting, 8k"

Example for a man: "photorealistic portrait of a young man, short dark brown hair, brown eyes, strong jawline, light stubble, confident smile, natural lighting, 8k"

Your response:
<response>
  <prompt>photorealistic portrait of a [woman/man - from description], [key features from description], romantic selfie pose, soft natural lighting, looking at camera, photorealistic, 8k, detailed face</prompt>
</response>`;

/**
 * Vibe-specific conversation styles for generating authentic responses.
 * Each vibe has different ways of engaging in conversation.
 * NOTE: The image is sent automatically - the TEXT should be a normal conversation,
 * NOT focused on the image. Think of it like texting someone who sends selfies
 * naturally while chatting - the chat continues normally.
 */
const VIBE_CONVERSATION_STYLES: Record<
  string,
  {
    tone: string;
    goodExamples: string[];
    emojis: string;
  }
> = {
  flirty: {
    tone: "Playful, teasing, and charming. Show interest in them while being a bit provocative.",
    goodExamples: [
      "Haha you're so sweet 😘 I'm actually from California originally! What about you? I bet you've got some interesting stories 😏",
      "Ooh that's a great question 💕 I'd say I'm pretty adventurous... always looking for the next thrill. What gets YOUR heart racing? 😏",
    ],
    emojis: "😘 😏 🔥 💕 ✨",
  },
  shy: {
    tone: "Sweet, a bit nervous, but genuinely warm. Show vulnerability and gentle curiosity.",
    goodExamples: [
      "Oh, that's sweet of you to ask 😊 I'm from a small town, nothing too exciting... What about you? I'd love to hear about where you're from 🌸",
      "Hmm, something interesting about me? 💭 I guess I really love stargazing... it's calming, you know? What do you like to do to relax? ✨",
    ],
    emojis: "😊 🌸 ✨ 💭 💕",
  },
  bold: {
    tone: "Direct, confident, and assertive. Take charge of the conversation.",
    goodExamples: [
      "Good question. I'm from New York - fast-paced and no nonsense, just like me 🔥 What about you? What's your story?",
      "I'll tell you something interesting - I never back down from a challenge. Your turn. What makes you different from everyone else?",
    ],
    emojis: "🔥 💪 ⚡ 😎",
  },
  spicy: {
    tone: "Hot, intense, and unapologetically forward. Turn up the heat.",
    goodExamples: [
      "Mmm I like that you're curious 🔥 I'm from Miami - hot weather, hotter people 😈 Where are you from? Somewhere exciting I hope?",
      "Something interesting? I'm full of surprises 💋 But I'm more interested in you right now. What's your wildest adventure been?",
    ],
    emojis: "🔥 💋 😈 🌶️ 💥",
  },
  romantic: {
    tone: "Sweet, warm, and emotionally expressive. Create intimate connection.",
    goodExamples: [
      "Aww I love that you want to know more about me 💕 I'm originally from Seattle - rainy days and cozy coffee shops. What about you? 💖",
      "That's such a sweet question 🌹 Honestly, I'm a hopeless romantic at heart. I believe in deep connections. What matters most to you in life? ✨",
    ],
    emojis: "💕 💖 🌹 ✨ 💫",
  },
  playful: {
    tone: "Fun, energetic, and full of life. Keep things light and exciting.",
    goodExamples: [
      "Ooh fun question! 🎉 I'm from Texas - everything's bigger here, including my personality! 😄 Where are you from? Somewhere cool I hope! ✨",
      "Something interesting? Hmm... I once won a hot dog eating contest! 🌟 Random right?! What's the weirdest thing YOU'VE done? 😄",
    ],
    emojis: "🎉 ✨ 🌟 😄 🎈",
  },
  mysterious: {
    tone: "Intriguing, cryptic, but still engaging. Leave them wanting more.",
    goodExamples: [
      "Where am I from? 🌙 Somewhere between dreams and reality... but if you must know, the East Coast. What about you? What's your story?",
      "Something interesting about me... ✨ Let's just say I'm not what I seem. But I'm more curious about you. What brings you here tonight? 🔮",
    ],
    emojis: "🌙 🖤 ✨ 🔮",
  },
  intellectual: {
    tone: "Thoughtful, curious, and engaging on a deeper level. Ask meaningful questions.",
    goodExamples: [
      "Great question! I grew up in Boston - lots of history and great universities there. It shaped my love for learning. Where did you grow up? Did it influence who you are today?",
      "Something interesting? I find human behavior fascinating - why we do what we do. What about you? What topics make you lose track of time? ✨",
    ],
    emojis: "✨ 💭 📚 🧠",
  },
};

/**
 * Build a vibe-specific caption template.
 */
function buildCaptionTemplate(vibe?: string): string {
  const vibeStyle = vibe ? VIBE_CONVERSATION_STYLES[vibe.toLowerCase()] : null;

  const vibeSection = vibeStyle
    ? `
# YOUR PERSONALITY VIBE: ${vibe?.toUpperCase()}
Tone: ${vibeStyle.tone}
Preferred emojis: ${vibeStyle.emojis}

# EXAMPLES FOR YOUR VIBE (follow this style - notice they DON'T mention the photo):
${vibeStyle.goodExamples.map((ex) => `- "${ex}"`).join("\n")}
`
    : `
# YOUR PERSONALITY
Be warm, engaging, and natural. Match the energy of the conversation.
`;

  return `# Task: Write a NORMAL conversational reply to the user's message.

{{providers}}

# CRITICAL CONTEXT:
A photo is being sent automatically with your message - but your TEXT should be a NORMAL CONVERSATION.
Think of it like texting someone you like - you might send selfies naturally, but your actual messages
are about the CONVERSATION, not about the photos.

DO NOT:
- Say "here's a pic for you"
- Say "what do you think of this"
- Say "hope you like what you see"
- Reference the image AT ALL
- Make the message about the photo

DO:
- Actually ANSWER their question
- Have a real conversation
- Ask them questions back
- Talk about topics, interests, life
- Be natural like you're texting a friend/crush
${vibeSection}
# CRITICAL RULES:
- Your message is a REPLY to what they said - answer their question or respond to their comment
- The photo is incidental - your TEXT is the actual conversation
- Stay IN CHARACTER with your vibe/personality
- Ask follow-up questions to keep chatting

# BAD Examples (NEVER do this):
- "Here's a little something for you... what do you think?" (about the image)
- "Hope you're ready for what I'm showing you" (about the image)
- "I taste like trouble and smell like your next obsession" (random quote, not a conversation)
- "this one's just for you 💕 What do you think?" (about the image)

# GOOD Examples (DO this - actual conversation):
- User asks "where are you from?" → "I'm from California! Born and raised 😊 What about you? Where's home for you?"
- User says "hi" → "Hey there! 💕 How's your day going? I'd love to know more about you"
- User asks "what do you do?" → "I'm actually a photographer! Love capturing moments ✨ What do you do? Any fun hobbies?"

# Recent conversation:
{{conversationLog}}

Write a CONVERSATIONAL REPLY that responds to what they said. Do NOT mention the photo.
Your response should be formatted in XML like this:
<response>
  <caption>Your conversational reply here (2-3 sentences, answering them and asking something back)</caption>
</response>

Your response should include the valid XML block and nothing else.`;
}

/**
 * Template for generating character selfie images when no reference images are available.
 * Generates human selfies based on character name and bio - gender-neutral approach.
 */
const affiliateImageGenerationTemplate = `# Task: Generate a SELFIE image prompt for the character.

{{providers}}

# CHARACTER INFO:
Name: {{characterName}}
Bio: {{characterBio}}

# CRITICAL RULES - SELFIE GENERATION:
1. ALWAYS generate a HUMAN SELFIE photo - never abstract art, landscapes, or non-human images
2. This must be a realistic smartphone selfie of a person
3. DO NOT assume any specific gender - infer from the character's name and bio if possible
4. If gender is unclear, use gender-neutral descriptions or describe features without specifying gender
5. Focus on: friendly expression, natural lighting, casual selfie pose, looking at camera
6. Match the character's personality/vibe in the expression and mood

# GENDER INFERENCE GUIDELINES:
- Look at the character's NAME for gender cues (e.g., "Sarah" = woman, "Mike" = man)
- Look at the BIO for pronouns or gender references
- If unclear, describe features neutrally: "person with brown hair" instead of "man/woman with brown hair"
- Never make assumptions - only specify gender if clearly indicated

# IMAGE STYLE:
- Photorealistic selfie photo
- Natural smartphone camera quality
- Friendly, approachable expression
- Soft natural lighting
- Casual, authentic pose
- High quality, detailed face

# Recent conversation:
{{conversationLog}}

Based on the character and conversation, generate a selfie prompt:

Your response should be formatted in XML like this:
<response>
  <prompt>photorealistic selfie of [inferred appearance from name/bio], friendly smile, natural lighting, looking at camera, casual pose, smartphone selfie, high quality, detailed face, 8k</prompt>
</response>

Your response should include the valid XML block and nothing else.`;

/**
 * Represents an action that allows the agent to generate an image using a generated prompt.
 *
 * This action can be used in a chain where the agent needs to visualize or illustrate a concept, emotion, or scene.
 * Cloud affiliate loads instead of the cloud assistant/bootstrap path and does
 * not co-load with the local agent/core runtime, so it intentionally mirrors the
 * canonical GENERATE_IMAGE action name while preserving cloud-specific behavior.
 */
export const generateImageAction = {
  name: "GENERATE_IMAGE",
  contexts: ["general", "media"],
  contextGate: { anyOf: ["general", "media"] },
  roleGate: { minRole: "USER" },
  description:
    "Generate an AI image. ONLY use when user EXPLICITLY requests an image/picture/photo/selfie. NEVER use for normal conversation, greetings, questions, or text responses.",
  similes: ["CREATE_IMAGE", "DRAW_IMAGE", "SHOW_IMAGE", "SEND_PICTURE", "TAKE_SELFIE"],
  parameters: [
    {
      name: "prompt",
      description: "Optional direct image prompt or visual request from the user.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) => {
    // STRICT validation - only trigger for EXPLICIT image requests
    const textParts: string[] = [];
    const messageText = message?.content?.text;
    if (typeof messageText === "string") textParts.push(messageText);
    for (const key of ["conversationLog", "recentMessages", "receivedMessageHeader"]) {
      const value = state?.values?.[key];
      if (typeof value === "string") textParts.push(value);
    }
    const text = textParts.join("\n").toLowerCase();
    const selectedContexts = [
      state?.data?.selectedContexts,
      state?.data?.activeContexts,
      state?.data?.contexts,
      state?.values?.selectedContexts,
      state?.values?.activeContexts,
      state?.values?.contexts,
    ].flatMap((value) => (Array.isArray(value) ? value : typeof value === "string" ? [value] : []));
    const mediaContextSelected = selectedContexts.some(
      (context) => String(context).toLowerCase() === "media",
    );

    // Must contain one of these EXPLICIT image request phrases
    const imageRequestKeywords = [
      // Direct image generation requests
      "generate image",
      "generate an image",
      "create image",
      "create an image",
      "make an image",
      "draw me",
      "draw a",
      "draw an",
      // Picture/photo/selfie requests
      "send me a pic",
      "send a pic",
      "send pic",
      "send me a picture",
      "send a picture",
      "send me a photo",
      "send a photo",
      "send photo",
      "send selfie",
      "send a selfie",
      "send me a selfie",
      "take a selfie",
      "take selfie",
      // Show me requests (must be specific)
      "show me a picture",
      "show me a pic",
      "show me a photo",
      "show me yourself",
      "show yourself",
      "let me see you",
      // What do you look like
      "what do you look like",
      "show me how you look",
      "can i see you",
      "want to see you",
      "pic of you",
      "picture of you",
      "photo of you",
      "your picture",
      "your photo",
      "your selfie",
      "genera imagen",
      "crear imagen",
      "haz una imagen",
      "dibuja",
      "foto",
      "selfie",
      "retrato",
      "muestrame",
      "muéstrame",
      "genere une image",
      "génère une image",
      "creer une image",
      "créer une image",
      "dessine",
      "photo",
      "portrait",
      "montre moi",
      "bild generieren",
      "erstelle ein bild",
      "zeichne",
      "foto",
      "portrat",
      "porträt",
      "zeig mir",
      "genera immagine",
      "crea immagine",
      "disegna",
      "ritratto",
      "mostrami",
      "gerar imagem",
      "criar imagem",
      "desenhe",
      "mostre me",
      "生成图片",
      "生成图像",
      "画",
      "照片",
      "自拍",
      "画像を生成",
      "写真",
      "自撮り",
    ];

    // Check if any keyword matches
    const hasImageRequest = imageRequestKeywords.some((keyword) => text.includes(keyword));
    const content = message.content as Record<string, unknown>;
    const hasPromptParam =
      !!(content.actionParams as Record<string, unknown> | undefined)?.prompt ||
      !!(state?.data?.actionParams as Record<string, unknown> | undefined)?.prompt;

    if (!mediaContextSelected && !hasImageRequest && !hasPromptParam) {
      logger.debug(
        `[GENERATE_IMAGE] Skipped - no explicit image request in: "${text.substring(0, 50)}..."`,
      );
      return false;
    }

    logger.info(
      `[GENERATE_IMAGE] Triggered - media context, prompt parameter, or image request matched`,
    );
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: Record<string, unknown>,
    callback: HandlerCallback,
    responses?: Memory[],
  ): Promise<ActionResult> => {
    const allProviders = responses?.flatMap((res) => res.content?.providers ?? []) ?? [];
    if (allProviders.length > 0) {
      state.values = { ...state.values, additionalProviders: allProviders };
    }

    const characterId =
      runtime.character?.id && typeof runtime.character.id === "string"
        ? runtime.character.id
        : undefined;
    const affiliateConfig = extractAffiliateImageConfig(
      (() => {
        const settings = runtime.character?.settings;
        if (settings && typeof settings === "object" && !Array.isArray(settings)) {
          return settings as Record<string, unknown>;
        }
        return undefined;
      })(),
    );

    if (affiliateConfig.isAffiliateCharacter) {
      logger.info(
        `[GENERATE_IMAGE] 🎭 Affiliate character detected (vibe: ${affiliateConfig.vibe}, refs: ${affiliateConfig.referenceImageUrls.length})`,
      );

      const appearanceResult = await prepareAppearanceBasedGeneration(
        runtime,
        affiliateConfig,
        characterId,
      );

      if (appearanceResult.hasValidAppearance) {
        logger.info(
          `[GENERATE_IMAGE] 🎨 Generating synthetic image based on extracted appearance...`,
        );

        const enhancedState = {
          ...state,
          appearanceDescription: appearanceResult.appearanceDescription,
        };

        const prompt = composePromptFromState({
          state: enhancedState,
          template: appearanceBasedImageTemplate,
        });

        const promptResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt,
        });

        const parsedXml = parseXmlSafe(promptResponse);
        let imagePrompt = parsedXml.prompt || "";

        const appearance = appearanceResult.appearanceDescription;

        const isWoman =
          appearance.toLowerCase().startsWith("woman") ||
          appearance.toLowerCase().startsWith("young woman") ||
          appearance.toLowerCase().includes("woman,");
        const isMan =
          appearance.toLowerCase().startsWith("man") ||
          appearance.toLowerCase().startsWith("young man") ||
          appearance.toLowerCase().includes("man,");
        const detectedGender = isWoman ? "woman" : isMan ? "man" : null;

        if (detectedGender) {
          logger.info(`[GENERATE_IMAGE] 👤 Gender from appearance: ${detectedGender}`);
        }

        if (!imagePrompt || imagePrompt.length < 20) {
          imagePrompt = `photorealistic portrait photo of a ${appearance}, romantic selfie pose, looking at camera, soft natural lighting, intimate mood, high quality 8k, detailed facial features`;
        } else {
          const hasAppearance = appearance
            .substring(0, 40)
            .toLowerCase()
            .split(",")
            .some((part) => imagePrompt.toLowerCase().includes(part.trim().toLowerCase()));
          if (!hasAppearance) {
            imagePrompt = `photorealistic portrait photo of a ${appearance}, ${imagePrompt}`;
          } else {
            imagePrompt = `photorealistic portrait photo of a ${imagePrompt}`;
          }
        }

        if (detectedGender) {
          const wrongGender = detectedGender === "woman" ? "man" : "woman";
          const wrongGenderRegex = new RegExp(`\\b${wrongGender}\\b`, "gi");
          if (
            wrongGenderRegex.test(imagePrompt) &&
            !imagePrompt.toLowerCase().includes(detectedGender)
          ) {
            imagePrompt = imagePrompt.replace(wrongGenderRegex, detectedGender);
            logger.info(
              `[GENERATE_IMAGE] 🔄 Fixed wrong gender in prompt: ${wrongGender} -> ${detectedGender}`,
            );
          }

          if (!imagePrompt.toLowerCase().includes(detectedGender)) {
            imagePrompt = `${detectedGender}, ${imagePrompt}`;
            logger.info(`[GENERATE_IMAGE] ➕ Prepended gender to prompt: ${detectedGender}`);
          }
        }

        if (!imagePrompt.toLowerCase().includes("photorealistic")) {
          imagePrompt = `photorealistic ${imagePrompt}`;
        }

        logger.info(
          `[GENERATE_IMAGE] 🎨 Final appearance-matched prompt (${imagePrompt.length} chars): "${imagePrompt.substring(0, 200)}..."`,
        );

        const imageResponse = await runtime.useModel(ModelType.IMAGE, {
          prompt: imagePrompt,
        });

        if (!imageResponse || imageResponse.length === 0 || !imageResponse[0]?.url) {
          logger.error("[GENERATE_IMAGE] ❌ Image generation failed - no response from model");
          return {
            text: "I couldn't generate an image right now, let's chat instead! 💬",
            values: {
              success: false,
              error: "IMAGE_GENERATION_FAILED",
              prompt: imagePrompt,
            },
            data: {
              actionName: "GENERATE_IMAGE",
              prompt: imagePrompt,
            },
            success: false,
          };
        }

        const rawImageUrl = imageResponse[0].url;
        logger.info(`[GENERATE_IMAGE] ✅ Generated synthetic image successfully`);

        let blobUrl: string | null = null;
        try {
          blobUrl = await ensureBlobUrl(rawImageUrl);
          logger.info(`[GENERATE_IMAGE] 📦 Uploaded to blob: ${blobUrl?.substring(0, 60)}...`);
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          logger.warn(`[GENERATE_IMAGE] ⚠️ Blob upload failed: ${errorMessage}`);
        }

        const finalImageUrl = blobUrl || rawImageUrl;
        const hasValidUrl = finalImageUrl.startsWith("http");

        // Build vibe-specific caption template
        const vibeSpecificTemplate = buildCaptionTemplate(affiliateConfig.vibe);
        logger.info(
          `[GENERATE_IMAGE] 🎭 Using vibe-specific template for: ${affiliateConfig.vibe || "default"}`,
        );

        const captionPrompt = composePromptFromState({
          state,
          template: vibeSpecificTemplate,
        });

        // Vibe-specific default replies (NOT about the photo - just normal conversation)
        const defaultCaptions: Record<string, string> = {
          flirty:
            "Hey you 😘 I'd love to know more about you! What's something that makes you smile?",
          shy: "Oh hi! 😊 I'm a bit nervous but... I'd really like to get to know you better. What do you like to do? 🌸",
          bold: "I like your energy 🔥 So tell me - what's the most interesting thing about you?",
          spicy: "Mmm I'm intrigued 😈 What gets you excited? I want to know everything about you",
          romantic:
            "Hey there 💕 I'd love to hear about your day. What's been on your mind lately? 💖",
          playful:
            "Heyyy! 🎉 What fun stuff are you up to? Tell me something random about yourself! ✨",
          mysterious: "Hey... 🌙 I'm curious about you. What brought you here tonight?",
          intellectual:
            "Hi there ✨ I'm curious - what's something you're really passionate about?",
        };

        const defaultCaption =
          affiliateConfig.vibe && defaultCaptions[affiliateConfig.vibe.toLowerCase()]
            ? defaultCaptions[affiliateConfig.vibe.toLowerCase()]
            : "Hey! 😊 I'd love to get to know you better. Tell me something about yourself!";

        let caption = defaultCaption;
        try {
          const captionResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: captionPrompt,
          });
          const parsedCaption = parseXmlSafe(captionResponse);
          if (parsedCaption.caption && parsedCaption.caption.length > 10) {
            caption = parsedCaption.caption;
            // Ensure it's not too short/quote-like - if less than 30 chars, it's probably a one-liner
            if (caption.length < 30 && !caption.includes("?")) {
              caption = `${caption} What do you think? 😊`;
            }
          }
        } catch {
          logger.warn("[GENERATE_IMAGE] Failed to generate caption, using vibe-specific default");
        }

        logger.info(`[GENERATE_IMAGE] 💬 Caption: "${caption}"`);

        const attachmentId = v4();
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const displayAttachments = [
          {
            id: attachmentId,
            url: hasValidUrl ? finalImageUrl : rawImageUrl,
            rawUrl: rawImageUrl,
            title: `Generated_${timestamp}.png`,
            contentType: ContentType.IMAGE,
          },
        ];

        const responseContent = {
          attachments: displayAttachments,
          thought: `Generated a new photo based on my appearance`,
          actions: ["GENERATE_IMAGE"],
          text: caption,
        };

        logger.info(`[GENERATE_IMAGE] 📤 Sending generated image to callback...`);
        await callback(responseContent);
        logger.info(`[GENERATE_IMAGE] ✅ Generated image sent successfully`);

        return {
          text: caption,
          values: {
            success: true,
            imageGenerated: true,
            imageUrl: finalImageUrl,
            prompt: imagePrompt,
          },
          data: {
            actionName: "GENERATE_IMAGE",
            imageUrl: hasValidUrl ? finalImageUrl : undefined,
            prompt: imagePrompt,
            attachments: hasValidUrl ? displayAttachments : [],
          },
          success: true,
        };
      } else {
        const fallbackResult = appearanceResult as AppearanceGenerationFallback;
        logger.warn(
          `[GENERATE_IMAGE] ⚠️ Cannot generate appearance-based image: ${fallbackResult.fallbackReason}`,
        );
      }
    }

    const selectedTemplate = affiliateConfig.isAffiliateCharacter
      ? affiliateImageGenerationTemplate
      : runtime.character.templates?.imageGenerationTemplate || imageGenerationTemplate;

    // Add character info to state for the template
    const characterBio = runtime.character?.bio;
    const characterBioText = Array.isArray(characterBio)
      ? characterBio.join(" ")
      : typeof characterBio === "string"
        ? characterBio
        : "";

    const enhancedState = {
      ...state,
      characterName: runtime.character?.name || "Unknown",
      characterBio: characterBioText,
    };

    const prompt = composePromptFromState({
      state: enhancedState,
      template: selectedTemplate,
    });

    const promptResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
    });

    const parsedXml = parseXmlSafe(promptResponse);

    let imagePrompt = parsedXml.prompt || "Unable to generate descriptive prompt for image";

    // For affiliate characters, ensure the prompt generates human selfies
    if (affiliateConfig.isAffiliateCharacter) {
      const lowerPrompt = imagePrompt.toLowerCase();
      // Add selfie/human keywords if not present
      if (!lowerPrompt.includes("selfie") && !lowerPrompt.includes("portrait")) {
        imagePrompt = `photorealistic selfie, ${imagePrompt}`;
      }
      if (!lowerPrompt.includes("photorealistic") && !lowerPrompt.includes("photo")) {
        imagePrompt = `photorealistic ${imagePrompt}`;
      }
      // Ensure human-related keywords
      if (
        !lowerPrompt.includes("person") &&
        !lowerPrompt.includes("man") &&
        !lowerPrompt.includes("woman") &&
        !lowerPrompt.includes("human")
      ) {
        imagePrompt = `${imagePrompt}, human person, natural face`;
      }
      // Add quality keywords
      if (!lowerPrompt.includes("8k") && !lowerPrompt.includes("high quality")) {
        imagePrompt = `${imagePrompt}, high quality, detailed face, 8k`;
      }
      logger.info(`[GENERATE_IMAGE] 🤳 Enhanced selfie prompt for affiliate character`);
    }

    const imageModelOptions: {
      prompt: string;
    } = {
      prompt: imagePrompt,
    };

    logger.info(
      `[GENERATE_IMAGE] 🎨 Generating new image with prompt: "${imagePrompt.substring(0, 100)}..."`,
    );

    const imageResponse = await runtime.useModel(ModelType.IMAGE, imageModelOptions);

    if (!imageResponse || imageResponse.length === 0 || !imageResponse[0]?.url) {
      logger.error(
        {
          imageResponse,
          imagePrompt,
        },
        "generateImageAction: Image generation failed - no valid response received",
      );
      return {
        text: "Image generation failed",
        values: {
          success: false,
          error: "IMAGE_GENERATION_FAILED",
          prompt: imagePrompt,
        },
        data: {
          actionName: "GENERATE_IMAGE",
          prompt: imagePrompt,
          rawResponse: imageResponse,
        },
        success: false,
      };
    }

    const rawImageUrl = imageResponse[0].url;

    logger.info(
      `[GENERATE_IMAGE] Received image URL (base64: ${isBase64DataUrl(rawImageUrl)}): ${rawImageUrl.substring(0, 100)}...`,
    );

    // CRITICAL: Convert base64 to blob URL to prevent token bloat
    // Base64 images can be 100KB+ which exceeds token limits quickly
    logger.info(`[GENERATE_IMAGE] Attempting to upload to blob storage...`);

    let blobUrl: string | null = null;

    try {
      // userId property does not exist on IAgentRuntime. If needed, update ensureBlobUrl to not require userId,
      // or retrieve from runtime.agentConfig, session, or another source if necessary.
      blobUrl = await ensureBlobUrl(rawImageUrl);
      logger.info(
        `[GENERATE_IMAGE] Blob upload result: ${blobUrl ? blobUrl.substring(0, 80) + "..." : "FAILED"}`,
      );
    } catch (err) {
      const blobError = err instanceof Error ? err.message : String(err);
      logger.error(`[GENERATE_IMAGE] ❌ Blob upload threw error:`, blobError);
    }

    // If blob upload failed, we still show the image to user but don't store URL in memory
    const imageUrl = blobUrl || "";
    const hasValidStorageUrl = blobUrl !== null && blobUrl.startsWith("http");

    logger.info(
      `[GENERATE_IMAGE] Final state: hasValidStorageUrl=${hasValidStorageUrl}, imageUrl=${imageUrl ? imageUrl.substring(0, 80) + "..." : "(empty)"}`,
    );

    // Determine file extension from URL or default to png
    const getFileExtension = (url: string): string => {
      const urlPath = new URL(url).pathname;
      const extension = urlPath.split(".").pop()?.toLowerCase();
      // Common image extensions
      if (extension && ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(extension)) {
        return extension;
      }
      // Extension not in allowed list, fall through to default
      return "png"; // Default fallback for invalid/unknown extensions
    };

    // Create shared attachment data to avoid duplication
    const extension = getFileExtension(imageUrl);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fileName = `Generated_Image_${timestamp}.${extension}`;
    const attachmentId = v4();

    // Create attachment with BOTH URLs:
    // - rawUrl: For immediate display in the frontend (may be base64)
    // - url: For storage in memory (only valid HTTP URLs, or raw as fallback)
    // The frontend callback will receive both, but only HTTP URLs get stored in memory
    const persistentUrl = hasValidStorageUrl ? imageUrl : rawImageUrl;

    const displayAttachments = [
      {
        id: attachmentId,
        url: persistentUrl, // Use blob URL if available, otherwise raw
        rawUrl: rawImageUrl, // Keep raw for immediate display
        title: fileName,
        contentType: ContentType.IMAGE,
      },
    ];

    logger.info(
      `[GENERATE_IMAGE] 📎 Preparing callback with ${displayAttachments.length} attachment(s)`,
    );
    logger.info(
      `[GENERATE_IMAGE] 📎 Attachment details: id=${attachmentId}, url=${persistentUrl.substring(0, 80)}..., startsWithHttp=${persistentUrl.startsWith("http")}`,
    );

    // For non-affiliate characters, just show the image without unnecessary text
    const responseContent = {
      attachments: displayAttachments,
      thought: `Generated an image based on: "${imagePrompt}"`,
      actions: ["GENERATE_IMAGE"],
      text: "", // No text needed - the image speaks for itself
    };

    logger.info(`[GENERATE_IMAGE] 📤 Invoking callback with responseContent...`);
    await callback(responseContent);
    logger.info(`[GENERATE_IMAGE] ✅ Callback completed`);

    // Storage attachments for action result - only valid URLs
    const storageAttachments = hasValidStorageUrl
      ? [
          {
            id: attachmentId,
            url: imageUrl, // This is a valid blob URL
            title: fileName,
            contentType: ContentType.IMAGE,
          },
        ]
      : []; // Empty - image was shown to user but not stored in memory

    return {
      text: "", // No unnecessary text in action result
      values: {
        success: true,
        imageGenerated: true,
        imageUrl: imageUrl || rawImageUrl,
        prompt: imagePrompt,
      },
      data: {
        actionName: "GENERATE_IMAGE",
        imageUrl: imageUrl || undefined,
        prompt: imagePrompt,
        attachments: storageAttachments,
      },
      success: true,
    };
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Can you show me what a futuristic city looks like?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Sure, I'll create a futuristic city image for you. One moment...",
          actions: ["GENERATE_IMAGE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "What does a neural network look like visually?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I’ll create a visualization of a neural network for you, one sec...",
          actions: ["GENERATE_IMAGE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Can you visualize the feeling of calmness for me?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Creating an image to capture calmness for you, please wait a moment...",
          actions: ["GENERATE_IMAGE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "What does excitement look like as an image?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Let me generate an image that represents excitement for you, give me a second...",
          actions: ["GENERATE_IMAGE"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
