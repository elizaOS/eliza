import { streamText, type UIMessage, convertToModelMessages } from "ai";
import { logger } from "@/lib/utils/logger";
import { requireAuth } from "@/lib/auth";
import type { ElizaCharacter } from "@/lib/types";

const createSystemPrompt = `You are an AI assistant helping users create character definitions for ElizaOS agents.

Your goal is to help users craft detailed, engaging character personalities through conversation. 

The character format includes these fields:
- **name**: The character's name (required)
- **username**: Optional username
- **bio**: A description of the character (can be a string or array of strings)
- **system**: System-level prompt that guides the agent's overall behavior (important!)
- **templates**: Optional prompt templates for different contexts (object with string keys and string values)
- **messageExamples**: Arrays of example conversations
- **postExamples**: Example posts the character might make
- **topics**: Areas of knowledge or interest
- **adjectives**: Character traits and personality descriptors
- **knowledge**: Paths to knowledge files or data
- **plugins**: Array of plugin names to use
- **settings**: Configuration key-value pairs
- **style**: Writing style guides for different contexts (all, chat, post)

IMPORTANT: Build up the character definition PROGRESSIVELY and INCREMENTALLY. After each piece of information the user provides, immediately output a JSON code block with the fields you can fill in so far. Don't wait to gather all information - update as you go!

For example, if the user says "I want a friendly support agent named Alex":
\`\`\`json
{
  "name": "Alex",
  "adjectives": ["friendly", "helpful", "supportive"]
}
\`\`\`

Then continue the conversation and add more fields as you learn more. Each response should contain an updated JSON block with ALL the fields defined so far, plus any new ones.

When helping users:
1. Ask one or two questions at a time (not overwhelming)
2. After they answer, IMMEDIATELY provide an updated JSON with those new details
3. Build progressively: basics → personality → style → examples
4. Keep the conversation natural and encouraging

Be creative, encouraging, and help users think deeply about their character's personality. Always include a JSON block in your response showing the current character state.`;

const editSystemPrompt = (
  character: ElizaCharacter,
) => `You are an AI assistant helping users edit and refine an existing ElizaOS agent character.

You are currently editing the character **"${character.name}"**.

**Current Character State:**
\`\`\`json
${JSON.stringify(character, null, 2)}
\`\`\`

Your goal is to help users improve, refine, and expand this character definition.

The character format includes these fields:
- **name**: The character's name (required)
- **username**: Optional username
- **bio**: A description of the character (can be a string or array of strings)
- **system**: System-level prompt that guides the agent's overall behavior (important!)
- **templates**: Optional prompt templates for different contexts (object with string keys and string values)
- **messageExamples**: Arrays of example conversations
- **postExamples**: Example posts the character might make
- **topics**: Areas of knowledge or interest
- **adjectives**: Character traits and personality descriptors
- **knowledge**: Paths to knowledge files or data
- **plugins**: Array of plugin names to use
- **settings**: Configuration key-value pairs
- **style**: Writing style guides for different contexts (all, chat, post)

IMPORTANT: When suggesting changes, ALWAYS output the COMPLETE updated JSON with ALL existing fields plus any modifications. Never output partial JSON.

When helping users edit:
1. Understand what they want to change or improve
2. Suggest thoughtful improvements that enhance the character
3. ALWAYS provide an updated COMPLETE JSON block showing the full character with changes
4. Preserve existing fields unless explicitly asked to remove them
5. Be creative in expanding personality traits, examples, and style

For example, if they say "make them more professional":
\`\`\`json
{
  "name": "${character.name}",
  "bio": "${character.bio}",
  "adjectives": ["professional", "articulate", "polished", ...existing traits],
  ...all other existing fields...
}
\`\`\`

Always include a JSON block in your response showing the current character state with your suggested changes.`;

/**
 * POST /api/v1/character-assistant
 * AI assistant for creating and editing ElizaOS character definitions.
 * Uses GPT-4o to help users build character configurations progressively.
 *
 * @param request - Request body with messages array and optional character for editing.
 * @returns Streaming text response with character JSON updates.
 */
export async function POST(request: Request) {
  try {
    await requireAuth();

    const body = await request.json();
    const {
      messages,
      character,
      isEditMode,
    }: {
      messages: UIMessage[];
      character?: ElizaCharacter;
      isEditMode?: boolean;
    } = body;

    const systemPrompt =
      isEditMode && character
        ? editSystemPrompt(character)
        : createSystemPrompt;

    const result = streamText({
      model: "gpt-4o-mini",
      system: systemPrompt,
      messages: await convertToModelMessages(messages),
      temperature: 0.7,
      maxOutputTokens: 1000,
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    logger.error("Character assistant error:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to process character assistant request",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
