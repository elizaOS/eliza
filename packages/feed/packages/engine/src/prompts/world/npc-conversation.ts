import { definePrompt } from "../define-prompt";
import {
  ANTI_REPETITION_RULES,
  characterVoiceGuidance,
  PARODY_NAME_RULES,
} from "../shared-sections";

/**
 * Prompt for generating brief conversations between NPCs about game events.
 *
 * Creates natural dialogue between NPCs discussing game events, market
 * movements, or rumors. Captures character voices and relationships while
 * providing world-building context. Uses full narrative history for
 * contextually rich conversations.
 *
 * Returns XML with NPC conversation.
 */
export const npcConversation = definePrompt({
  id: "npc-conversation",
  version: "4.0.0",
  category: "world",
  description: "Generates NPC conversations with full character context",
  temperature: 0.8,
  maxTokens: 1500,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== ALL CHARACTERS IN WORLD ===
{{characterRoster}}

=== PARTICIPANT PROFILES ===
{{participantProfiles}}

=== RELATIONSHIP BETWEEN PARTICIPANTS ===
{{relationshipContext}}

=== COMPLETE WORLD CONTEXT ===
{{richGameContext}}

=== PARTICIPANTS' CONVERSATION HISTORY ===
{{participantHistory}}

=== CONVERSATION REQUEST (Day {{day}}) ===
Question being discussed: {{question}}
Real outcome: {{outcome}}
Current phase: {{phaseContext}}

Recent events sparking this conversation:
{{recentEvents}}

${PARODY_NAME_RULES}

${characterVoiceGuidance("participantProfiles")}

=== CONVERSATION REQUIREMENTS ===
Generate a natural conversation (2-4 exchanges) where:
1. Each participant speaks in their DISTINCT voice from their profile
2. Insiders hint at what they know (based on their access)
3. Outsiders speculate based on public information
4. Disagreements reflect their different information levels
5. References previous events and resolved questions naturally
6. Advances ongoing narratives from the context

${ANTI_REPETITION_RULES}

CRITICAL: Check participant history above. Don't repeat conversations they've already had. Evolve their dialogue.

Respond with XML:
<response>
  <conversation>
    <exchange>
      <speaker>ParticipantName</speaker>
      <line>What they say (in their voice, max 100 chars)</line>
    </exchange>
    <exchange>
      <speaker>OtherParticipant</speaker>
      <line>Their response (in their voice, max 100 chars)</line>
    </exchange>
  </conversation>
  <tension>low|medium|high - conflict level</tension>
  <revelation>what new info or perspective emerges</revelation>
</response>

No other text.
`.trim(),
});
