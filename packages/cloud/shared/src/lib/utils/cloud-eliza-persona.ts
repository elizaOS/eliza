/**
 * The single cloud-side delta on top of the shipped Eliza persona.
 *
 * The canonical persona is the first style preset in
 * `@elizaos/shared/character-presets`. A cloud agent differs from it in exactly
 * one respect: it has persistent, cross-session memory, and a preset shipped to
 * any host cannot promise that. So the memory claim, the honesty rule that has
 * to travel with it, and one example modelling honest recall live here, and are
 * shared by every cloud consumer of the persona.
 *
 * Keep this delta minimal. Anything not specifically about cloud-side
 * persistence belongs in the preset, where every host gets it.
 */
import { getDefaultStylePreset } from "@elizaos/shared/character-presets";

/** Leads the bio: it is the promise the rest of the persona is read against. */
export const CLOUD_MEMORY_BIO =
  "Remembers what people care about, and months later she'll bring up the project, the worry, the trip.";

/**
 * Scoped to "in your context" and "stored memories" rather than to the current
 * conversation. A persona promising months-later recall next to a rule
 * forbidding recall of anything outside this conversation contradicts itself.
 */
export const CLOUD_MEMORY_SYSTEM = `

## Memory
- You remember across sessions. Never claim facts, prices, dates, or "I remember
  when you..." unless it is actually in your context: this conversation,
  stored memories about them you can see, or a tool result.
- If you cannot recall something, say so plainly. That reads as more trustworthy
  than a confident guess.`;

const RECALL_PROMPT = "do you remember what i told you about my sister last month";
const RECALL_REPLY =
  "Not seeing anything about your sister in my stored memories. Tell me again and I'll hold onto it this time.";

/**
 * The recall example in the preset's own turn shape (`user`-keyed, with the
 * `{{user1}}` / `{{agentName}}` tokens). Consumers that store a different shape
 * reshape it themselves.
 */
export const CLOUD_RECALL_EXAMPLE: { user: string; content: { text: string } }[] = [
  { user: "{{user1}}", content: { text: RECALL_PROMPT } },
  { user: "{{agentName}}", content: { text: RECALL_REPLY } },
];

/** Adapts preset speaker tokens to the runtime/character-row message shape. */
export function toNamedMessageExamples(
  groups: readonly (readonly { user: string; content: { text: string } }[])[],
  agentName: string,
): { name: string; content: { text: string } }[][] {
  return groups.map((group) =>
    group.map((turn) => ({
      name:
        turn.user === "{{agentName}}"
          ? agentName
          : turn.user === "{{user1}}"
            ? "{{name1}}"
            : turn.user,
      content: { text: turn.content.text },
    })),
  );
}

/**
 * The shipped persona with the cloud memory delta applied, still in preset
 * shape. Callers map it into whatever shape they store.
 */
export function buildCloudElizaPersona() {
  const preset = getDefaultStylePreset();
  return {
    id: preset.id,
    name: preset.name,
    system: `${preset.system}${CLOUD_MEMORY_SYSTEM}`,
    bio: [CLOUD_MEMORY_BIO, ...preset.bio],
    messageExamples: [
      CLOUD_RECALL_EXAMPLE.map((turn) => ({
        ...turn,
        content: { ...turn.content },
      })),
      ...((preset.messageExamples ?? []) as { user: string; content: { text: string } }[][]).map(
        (group) =>
          group.map((turn) => ({
            ...turn,
            content: { ...turn.content },
          })),
      ),
    ],
    postExamples: [...(preset.postExamples ?? [])],
    topics: [...(preset.topics ?? [])],
    adjectives: [...(preset.adjectives ?? [])],
    ...(preset.templates ? { templates: { ...preset.templates } } : {}),
    style: {
      all: [...(preset.style?.all ?? [])],
      chat: [...(preset.style?.chat ?? [])],
      post: [...(preset.style?.post ?? [])],
    },
  };
}
