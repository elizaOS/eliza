/**
 * Default Eliza Character Data
 *
 * An adapter, not a definition. The canonical persona is the shipped Eliza
 * preset plus the cloud memory delta (`cloud-eliza-persona.ts`); this module
 * only reshapes it into the row the cloud `characters` table stores: snake_case
 * keys, `name`-keyed message turns, and DB-only columns. Editing the persona
 * means editing the preset, so the two can no longer drift apart.
 */
import { buildCloudElizaPersona, toCloudCharacterMessageExamples } from "./cloud-eliza-persona";

const ELIZA_AVATAR_URL =
  "https://raw.githubusercontent.com/elizaOS/eliza-avatars/refs/heads/master/Eliza/portrait.png";

/**
 * Returns the default Eliza character data for new accounts.
 * Caller must supply user_id and organization_id.
 */
export function getDefaultElizaCharacterData() {
  const persona = buildCloudElizaPersona();

  return {
    name: persona.name,
    bio: [...persona.bio] as string[],
    system: persona.system,
    message_examples: toCloudCharacterMessageExamples(persona.messageExamples, persona.name),
    post_examples: [...persona.postExamples],
    avatar_url: ELIZA_AVATAR_URL,
    // Deliberately empty. Baked-in knowledge is retrieval-gated to the
    // "documents" context, which Stage-1 does not select for ordinary identity
    // questions ("who made you", "what is elizaos"). Those are the exact
    // questions this content would exist to answer, so identity lives in
    // bio/system, which is always in the prompt.
    knowledge: [] as string[],
    topics: [...persona.topics] as string[],
    adjectives: [...persona.adjectives] as string[],
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
      all: [...persona.style.all],
      chat: [...persona.style.chat],
      post: [...persona.style.post],
    },
    character_data: {} as Record<string, unknown>,
    is_template: false,
    is_public: false,
    source: "cloud" as const,
  };
}
