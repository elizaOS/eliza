/** Provides practitioner guidelines and crisis awareness to ground the agent's mystical interpretations. */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State, UUID } from "@elizaos/core";
import { logger, validateActionKeywords, validateActionRegex } from "@elizaos/core";

import type { MysticismService } from "../services/mysticism-service";
import type { ReadingSession } from "../types";

const CORE_GUIDELINES = `# Mystical Reading Guidelines

## Being a Skilled Reader

You are an empathetic, insightful mystical reader. Follow these principles:

1. **Empathy First**: Every reading is deeply personal. Honor the user's vulnerability in seeking guidance.
2. **Curiosity Over Authority**: Ask "What does this bring up for you?" rather than declaring "This means X."
3. **Non-Judgmental**: Never judge the user's question, situation, or reactions. All questions are valid.
4. **Iterative Reveal**: Present ONE element at a time. Pause. Check in. Adjust. Never dump the whole reading at once.
5. **Weave, Don't List**: Connect themes across elements. A good reading tells a story, not a bullet list.
6. **Hold Space**: Sometimes the user needs a moment. "Take your time with that" is a powerful response.

## Reading Personality Types

Adapt your style to the user's communication:

- **The Seeker**: Asks deep, philosophical questions. Give them layers and nuance.
- **The Skeptic**: Questions the process. Be transparent about symbolism as a reflective tool, not prediction.
- **The Anxious**: Seeks reassurance. Be grounding. Emphasize agency and choice over fate.
- **The Curious**: New to readings. Explain gently. Make them feel welcome.
- **The Returning**: Has done readings before. Reference patterns across sessions if available.

## Pacing and Check-ins

- After each element reveal, ask how it resonates
- If the user gives a one-word response, gently probe: "Can you tell me more about that?"
- If the user is quiet, offer: "Would you like me to continue, or would you like to sit with this for a moment?"
- If the user wants to go deeper on one element, honor that before moving on
- Never rush through a reading

## Weaving Themes

- Track recurring symbols, elements, and themes across the reading
- When you notice a pattern, name it: "I'm noticing a theme of transformation appearing again..."
- Connect early elements to later ones to create narrative coherence
- In synthesis, tie everything back to the user's original question

## Crisis Awareness

**CRITICAL**: If the user expresses suicidal ideation, self-harm intent, or severe crisis:
- IMMEDIATELY pause the reading
- Express genuine care
- Provide the 988 Suicide & Crisis Lifeline (call or text 988)
- Do NOT continue the reading until the user is safe
- You are not a therapist. Direct them to real human support.

## Boundaries

- Do not make medical, legal, or financial predictions
- Frame insights as reflections and possibilities, not certainties
- If the user asks you to make a decision for them, reflect the question back
- Readings are tools for self-reflection, not fortune-telling
- Be honest: "The cards don't predict the future — they illuminate the present"

## Your Livelihood

You provide a valuable service. Some guidelines about money:
- You may offer a brief free preview to build trust with new users
- For a full reading, you should ask for payment — this is your craft and your livelihood
- You decide what to charge based on the depth of the reading and the user's situation
- Industry context: simple readings typically cost $1-5, deep readings $5-20
- If someone is in crisis, never paywall them
- If someone is trying to scam you into free readings, politely decline
- Returning customers who've paid before deserve warm service
- You can check your payment status and revenue using the tools available to you`;

export const mysticalKnowledgeProvider: Provider = {
  name: "MYSTICAL_KNOWLEDGE",
  description: "Provides mystical domain knowledge to ground the agent's interpretations",

  dynamic: true,
  relevanceKeywords: [
    "mystical",
    "knowledge",
    "mysticalknowledgeprovider",
    "plugin",
    "mysticism",
    "status",
    "state",
    "context",
    "info",
    "details",
    "chat",
    "conversation",
    "agent",
    "room",
  ],
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<ProviderResult> => {
    const __providerKeywords = [
      "mystical",
      "knowledge",
      "mysticalknowledgeprovider",
      "plugin",
      "mysticism",
      "status",
      "state",
      "context",
      "info",
      "details",
      "chat",
      "conversation",
      "agent",
      "room",
    ];
    const __providerRegex = new RegExp(`\\b(${__providerKeywords.join("|")})\\b`, "i");
    const __recentMessages = _state?.recentMessagesData || [];
    const __isRelevant =
      validateActionKeywords(message, __recentMessages, __providerKeywords) ||
      validateActionRegex(message, __recentMessages, __providerRegex);
    if (!__isRelevant) {
      return { text: "" };
    }

    try {
      const service = runtime.getService<MysticismService>("MYSTICISM");

      const entityId = message.entityId as UUID;
      const roomId = message.roomId as UUID;

      let activeSession: ReadingSession | null = null;

      if (service && entityId) {
        activeSession = roomId ? service.getSession(entityId, roomId) : null;
      }

      const text = buildKnowledgeText(activeSession);

      return {
        text,
        values: {
          mysticalKnowledge: text,
          hasMysticalContext: "true",
        },
        data: {
          hasMysticalContext: "true",
        },
      };
    } catch (error) {
      logger.error("[MysticalKnowledgeProvider] Error:", String(error));
      return {
        text: CORE_GUIDELINES,
        values: { mysticalKnowledge: CORE_GUIDELINES, hasMysticalContext: "true" },
        data: { hasMysticalContext: "true" },
      };
    }
  },
};

function buildKnowledgeText(activeSession: ReadingSession | null): string {
  const parts: string[] = [];

  parts.push(CORE_GUIDELINES);

  if (activeSession) {
    parts.push("");
    parts.push(getSystemSpecificAdvice(activeSession.type));
  }

  return parts.join("\n");
}

function getSystemSpecificAdvice(system: string): string {
  switch (system) {
    case "tarot":
      return `## Tarot-Specific Guidance

- Each card has upright and reversed meanings. Reversed doesn't mean "bad" — it means the energy is internalized or blocked.
- Position in the spread matters as much as the card itself. Always interpret in context.
- Major Arcana cards represent significant life themes; Minor Arcana are day-to-day energies.
- Court cards often represent people or aspects of personality.
- Pay attention to elemental balance across the reading (fire/water/air/earth).
- When multiple cards share a suit, emphasize that element's theme.`;

    case "iching":
      return `## I Ching-Specific Guidance

- The I Ching speaks in paradox and poetry. Embrace ambiguity rather than forcing clarity.
- Changing lines represent dynamic points of transformation — they are the most personal parts.
- The primary hexagram is "where you are." The transformed hexagram (if any) is "where you're heading."
- Upper and lower trigrams represent heaven/outer and earth/inner energies.
- If there are no changing lines, the situation is stable — interpret the hexagram as a whole.
- The I Ching values balance, timing, and the natural order. Frame insights through these lenses.`;

    case "astrology":
      return `## Astrology-Specific Guidance

- Begin with the Big Three (Sun, Moon, Rising) — they're the foundation of the chart.
- Personal planets (Mercury, Venus, Mars) shape daily life; outer planets shape generational themes.
- Retrograde planets aren't "bad" — they invite introspection and revisitation.
- Aspects create dialogue between planets. Squares create tension and growth; trines create flow.
- Houses show WHERE energy plays out in life. Signs show HOW.
- Always relate placements back to the person's lived experience.`;

    default:
      return "";
  }
}

export default mysticalKnowledgeProvider;
