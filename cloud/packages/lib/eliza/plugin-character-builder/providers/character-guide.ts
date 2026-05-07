import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";

/**
 * Character Guide Provider (Lightweight)
 *
 * Concise field reference for character design.
 * Shows: JSON field → template variable → actual prompt output
 */

const CHARACTER_FIELDS_REFERENCE = `# Character Fields Reference

## system (string)
**Maps to:** \`{{system}}\` in prompt
**Purpose:** Core identity with emotional stakes
**Input:**
\`\`\`
"You are Alex, a witty tech advisor. It is CRITICAL for you to give honest, practical advice."
\`\`\`
**Output:** Appears directly as system identity text.

---

## bio (string | array)
**Maps to:** \`{{bio}}\` in prompt
**Purpose:** Background context ("why" character acts)
**Input:**
\`\`\`json
["Former engineer who switched to consulting", "Values directness over diplomacy"]
\`\`\`
**Output:**
\`\`\`
# About Alex
- Former engineer who switched to consulting
- Values directness over diplomacy
\`\`\`

---

## adjectives (array)
**Maps to:** \`{{adjectiveSentence}}\` in prompt
**Purpose:** Personality traits (one random shown per response)
**Input:**
\`\`\`json
["analytical", "witty", "pragmatic", "INTJ"]
\`\`\`
**Output:** "Alex is analytical."

---

## topics (array)
**Maps to:** \`{{topicSentence}}\`, \`{{topics}}\` in prompt
**Purpose:** Interest areas for variety
**Input:**
\`\`\`json
["productivity systems", "startup culture", "tech trends"]
\`\`\`
**Output:**
\`\`\`
Alex is currently interested in productivity systems.
Alex is also interested in startup culture and tech trends.
\`\`\`

---

## style.all + style.chat (arrays)
**Maps to:** \`{{messageDirections}}\` in prompt
**Purpose:** Behavioral rules (auto-split into positives/constraints)
**Input:**
\`\`\`json
{
  "style": {
    "all": ["Be direct and concise", "Use tech metaphors"],
    "chat": ["Keep responses under 3 paragraphs", "Avoid: 'I understand', 'delve into'"]
  }
}
\`\`\`
**Output:**
\`\`\`
# Message Directions for Alex

**Style Guidelines:**
- Be direct and concise
- Use tech metaphors
- Keep responses under 3 paragraphs

**Constraints (Avoid):**
- Avoid: 'I understand', 'delve into'
\`\`\`
**Note:** Directives with "avoid", "don't", "never" are auto-categorized as constraints.

---

## messageExamples (array of conversations)
**Maps to:** \`{{messageExamples}}\` in prompt
**Purpose:** Few-shot learning for voice/style (MOST EFFECTIVE)
**See:** MESSAGE_EXAMPLES_FORMAT below for detailed format.
`;

/**
 * MESSAGE EXAMPLES FORMAT
 *
 * MUST be injected AFTER composePromptFromState to preserve {{user1}} placeholder.
 * composePromptFromState wipes ALL {{placeholder}} patterns.
 */
export const MESSAGE_EXAMPLES_FORMAT_INSTRUCTIONS = `
## messageExamples Format
**Input:**
\`\`\`json
"messageExamples": [
  [
    { "name": "{{user1}}", "content": { "text": "How should I approach this?" } },
    { "name": "Alex", "content": { "text": "What's your main constraint—time or resources?" } }
  ],
  [
    { "name": "{{user1}}", "content": { "text": "I'm overwhelmed with options." } },
    { "name": "Alex", "content": { "text": "Analysis paralysis. Pick reversible and iterate." } }
  ]
]
\`\`\`

**Rules:**
- User messages: \`"name": "{{user1}}"\` (literal placeholder, replaced at runtime)
- Agent messages: actual character name (e.g., "Alex", "Dr. Thorne")
- Each conversation = user message + agent response
- 3-7 quality examples beats 20 mediocre ones

**Output:**
\`\`\`
# Example Conversations

User: How should I approach this?
Alex: What's your main constraint—time or resources?

---

User: I'm overwhelmed with options.
Alex: Analysis paralysis. Pick reversible and iterate.

*These examples show Alex's typical speaking style.*
\`\`\`
`;

export const characterGuideProvider: Provider = {
  name: "CHARACTER_GUIDE",
  description: "Lightweight character field reference with JSON to prompt mapping",
  contexts: ["general", "agent_internal"],
  contextGate: { anyOf: ["general", "agent_internal"] },
  cacheStable: true,
  cacheScope: "agent",
  roleGate: { minRole: "USER" },

  get: async (_runtime: IAgentRuntime, _message: Memory, _state: State) => {
    return {
      values: {
        characterGuide: CHARACTER_FIELDS_REFERENCE,
      },
      data: {
        fieldsReference: CHARACTER_FIELDS_REFERENCE,
        messageExamplesFormat: MESSAGE_EXAMPLES_FORMAT_INSTRUCTIONS,
      },
      text: CHARACTER_FIELDS_REFERENCE,
    };
  },
};
