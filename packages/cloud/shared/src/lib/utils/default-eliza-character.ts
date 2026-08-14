/**
 * Default Eliza Character Data
 *
 * An adapter, not a definition. The canonical Eliza persona is the first shipped
 * style preset in `@elizaos/shared/character-presets`; this module only reshapes
 * it into the row shape the cloud `characters` table stores (snake_case keys,
 * `name`-keyed message turns, DB-only columns). Editing the persona means
 * editing the preset, so the two can no longer drift apart.
 *
 * The subpath import is deliberate: the `@elizaos/shared` barrel pulls React,
 * drizzle and the registry, none of which belong in a cloud request path.
 * `./character-presets` is pure data with a single type-only import.
 */
import { getDefaultStylePreset } from "@elizaos/shared/character-presets";

const ELIZA_AVATAR_URL =
  "https://raw.githubusercontent.com/elizaOS/eliza-avatars/refs/heads/master/Eliza/portrait.png";

/**
 * A single turn as the preset stores it. Presets key the speaker as `user` and
 * address the agent with `{{agentName}}`; the characters table keys it as `name`
 * and stores the literal agent name, with `{{name1}}` for the human.
 */
interface PresetTurn {
  user?: string;
  name?: string;
  content?: { text?: string };
}

function toRowSpeaker(turn: PresetTurn, agentName: string): string {
  const speaker = turn.user ?? turn.name;
  if (speaker === "{{agentName}}") return agentName;
  if (speaker === "{{user1}}") return "{{name1}}";
  return speaker ?? "{{name1}}";
}

function toRowExamples(
  groups: readonly (readonly PresetTurn[])[] | undefined,
  agentName: string,
): Record<string, unknown>[][] {
  return (groups ?? []).map((group) =>
    group.map((turn) => ({
      name: toRowSpeaker(turn, agentName),
      content: { text: turn.content?.text ?? "" },
    })),
  );
}

/**
 * The one place a cloud Eliza legitimately differs from the shipped preset.
 *
 * A cloud agent has persistent, cross-session memory; a preset shipped to any
 * host cannot promise that. So the persona is shared and only the memory claim
 * is added here, together with an example that models reporting what is actually
 * visible rather than denying memory outright. Keep this delta minimal: anything
 * that is not specifically about cloud-side persistence belongs in the preset.
 */
const CLOUD_MEMORY_BIO =
  "Remembers what people care about, and months later she'll bring up the project, the worry, the trip.";

/**
 * The honesty rule that has to travel with the memory claim above. Scoped to
 * "in your context" and "stored memories" rather than to the current
 * conversation: a persona that promises months-later recall next to a rule
 * forbidding recall of anything outside this conversation contradicts itself.
 */
const CLOUD_MEMORY_SYSTEM = `

## Memory
- You remember across sessions. Never claim facts, prices, dates, or "I remember
  when you..." unless it is actually in your context: this conversation,
  stored memories about them you can see, or a tool result.
- If you cannot recall something, say so plainly. That reads as more trustworthy
  than a confident guess.`;

const CLOUD_RECALL_EXAMPLE: Record<string, unknown>[] = [
  {
    name: "{{name1}}",
    content: { text: "do you remember what i told you about my sister last month" },
  },
  {
    name: "Eliza",
    content: {
      text: "Not seeing anything about your sister in my stored memories. Tell me again and I'll hold onto it this time.",
    },
  },
];

/**
 * Returns the default Eliza character data for new accounts.
 * Caller must supply user_id and organization_id.
 */
export function getDefaultElizaCharacterData() {
  const preset = getDefaultStylePreset();

  return {
    name: preset.name,
    // Memory claim first: it is the promise the rest of the persona is read against.
    bio: [CLOUD_MEMORY_BIO, ...preset.bio] as string[],
    system: `${preset.system}${CLOUD_MEMORY_SYSTEM}`,
    message_examples: [
      CLOUD_RECALL_EXAMPLE,
      ...toRowExamples(
        preset.messageExamples as readonly (readonly PresetTurn[])[] | undefined,
        preset.name,
      ),
    ],
    avatar_url: ELIZA_AVATAR_URL,
    // Deliberately empty. Baked-in knowledge is retrieval-gated to the
    // "documents" context, which Stage-1 does not select for ordinary identity
    // questions ("who made you", "what is elizaos"). Those are the exact
    // questions this content would exist to answer, so identity lives in
    // bio/system, which is always in the prompt.
    knowledge: [] as string[],
    topics: [...(preset.topics ?? [])] as string[],
    adjectives: [...(preset.adjectives ?? [])] as string[],
    plugins: [] as string[],
    // Do NOT enable settings.webSearch here. That key makes the agent loader
    // inject @elizaos/plugin-web-search (SETTINGS_PLUGIN_MAP in
    // lib/eliza/agent-mode-types.ts), but the Google keys its WebSearchService
    // needs are only injected for the request-level webSearchEnabled toggle
    // (buildSettings in lib/eliza/runtime/settings.ts), never provisioned with
    // this character. A character-level enable ships a service whose start()
    // throws on every runtime creation. Web search for this character works via
    // the request toggle, which injects the plugin and the keys together.
    settings: {} as Record<string, unknown>,
    style: {
      all: [...(preset.style?.all ?? [])],
      chat: [...(preset.style?.chat ?? [])],
      post: [...(preset.style?.post ?? [])],
    },
    character_data: {} as Record<string, unknown>,
    is_template: false,
    is_public: false,
    source: "cloud" as const,
  };
}
