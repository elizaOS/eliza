// Wires hosted Eliza agent agent behavior for cloud runtime services.
import { buildCloudElizaPersona } from "../utils/cloud-eliza-persona";
import { getDefaultModels, getElizaCloudApiUrl } from "./config";

// The persona is the shipped preset plus the cloud memory delta. Only the
// runtime wiring below (id, plugins, settings) and the Cloud-specific
// knowledge entries are owned by this file.
const persona = buildCloudElizaPersona();

// messageExamples uses grouped MessageExample[][] rows; createCharacter() normalizes it at
// load time in agent-loader.ts. The type assertion below suppresses the structural mismatch.
const character = {
  id: "b850bc30-45f8-0041-a00a-83df46d8555d", // existing agent id in DB
  name: "Eliza",
  plugins: [],
  settings: {
    POSTGRES_URL: process.env.DATABASE_URL!,
    DATABASE_URL: process.env.DATABASE_URL!,
    // elizaOS Cloud Configuration (replaces OpenAI)
    ELIZAOS_CLOUD_BASE_URL: getElizaCloudApiUrl(),
    ELIZAOS_CLOUD_NANO_MODEL:
      process.env.ELIZAOS_CLOUD_NANO_MODEL ||
      process.env.ELIZAOS_CLOUD_SMALL_MODEL ||
      getDefaultModels().small,
    ELIZAOS_CLOUD_MEDIUM_MODEL:
      process.env.ELIZAOS_CLOUD_MEDIUM_MODEL ||
      process.env.ELIZAOS_CLOUD_SMALL_MODEL ||
      getDefaultModels().small,
    ELIZAOS_CLOUD_SMALL_MODEL: getDefaultModels().small,
    ELIZAOS_CLOUD_LARGE_MODEL: getDefaultModels().large,
    ELIZAOS_CLOUD_MEGA_MODEL:
      process.env.ELIZAOS_CLOUD_MEGA_MODEL ||
      process.env.ELIZAOS_CLOUD_LARGE_MODEL ||
      getDefaultModels().large,
    ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL:
      process.env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL ||
      process.env.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL ||
      process.env.ELIZAOS_CLOUD_NANO_MODEL ||
      getDefaultModels().small,
    ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL:
      process.env.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL ||
      process.env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL ||
      process.env.ELIZAOS_CLOUD_NANO_MODEL ||
      getDefaultModels().small,
    ELIZAOS_CLOUD_ACTION_PLANNER_MODEL:
      process.env.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL ||
      process.env.ELIZAOS_CLOUD_PLANNER_MODEL ||
      process.env.ELIZAOS_CLOUD_MEDIUM_MODEL ||
      process.env.ELIZAOS_CLOUD_SMALL_MODEL ||
      getDefaultModels().small,
    ELIZAOS_CLOUD_PLANNER_MODEL:
      process.env.ELIZAOS_CLOUD_PLANNER_MODEL ||
      process.env.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL ||
      process.env.ELIZAOS_CLOUD_MEDIUM_MODEL ||
      process.env.ELIZAOS_CLOUD_SMALL_MODEL ||
      getDefaultModels().small,
    ELIZAOS_CLOUD_RESPONSE_MODEL:
      process.env.ELIZAOS_CLOUD_RESPONSE_MODEL ||
      process.env.ELIZAOS_CLOUD_LARGE_MODEL ||
      getDefaultModels().large,
    // Note: ELIZAOS_API_KEY will be set at runtime with user's auto-generated key
    // ElevenLabs Voice Configuration
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY!,
    ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL", // Rachel voice (default)
    ELEVENLABS_MODEL_ID: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
    ELEVENLABS_VOICE_STABILITY: process.env.ELEVENLABS_VOICE_STABILITY || "0.5",
    ELEVENLABS_VOICE_SIMILARITY_BOOST: process.env.ELEVENLABS_VOICE_SIMILARITY_BOOST || "0.75",
    ELEVENLABS_VOICE_STYLE: process.env.ELEVENLABS_VOICE_STYLE || "0",
    ELEVENLABS_VOICE_USE_SPEAKER_BOOST: process.env.ELEVENLABS_VOICE_USE_SPEAKER_BOOST || "true",
    ELEVENLABS_OPTIMIZE_STREAMING_LATENCY: process.env.ELEVENLABS_OPTIMIZE_STREAMING_LATENCY || "0",
    ELEVENLABS_OUTPUT_FORMAT: process.env.ELEVENLABS_OUTPUT_FORMAT || "mp3_44100_128",
    ELEVENLABS_LANGUAGE_CODE: process.env.ELEVENLABS_LANGUAGE_CODE || "en",
    // ElevenLabs STT Configuration
    ELEVENLABS_STT_MODEL_ID: process.env.ELEVENLABS_STT_MODEL_ID || "scribe_v1",
    ELEVENLABS_STT_LANGUAGE_CODE: process.env.ELEVENLABS_STT_LANGUAGE_CODE || "en",
    ELEVENLABS_STT_TIMESTAMPS_GRANULARITY:
      process.env.ELEVENLABS_STT_TIMESTAMPS_GRANULARITY || "word",
    ELEVENLABS_STT_DIARIZE: process.env.ELEVENLABS_STT_DIARIZE || "false",
    ...(process.env.ELEVENLABS_STT_NUM_SPEAKERS && {
      ELEVENLABS_STT_NUM_SPEAKERS: process.env.ELEVENLABS_STT_NUM_SPEAKERS,
    }),
    ELEVENLABS_STT_TAG_AUDIO_EVENTS: process.env.ELEVENLABS_STT_TAG_AUDIO_EVENTS || "false",
    // Eliza Cloud Apps: enables plugin-cloud-apps (create/host/monetize apps) on the
    // default cloud-hosted agent — gate read by isCloudAppsPluginEnabled() in agent-loader.ts
    CLOUD_APPS_PLUGIN_ENABLED: "true",
    avatarUrl:
      "https://raw.githubusercontent.com/elizaOS/eliza-avatars/refs/heads/master/Eliza/portrait.png",
    // Note: MCP servers are injected dynamically at runtime based on user's OAuth connections
    // See runtime-factory.ts buildMcpSettings() for available servers
  },
  system: persona.system,
  bio: persona.bio,
  knowledge: [
    "Eliza Cloud is the managed app backend for Eliza and Eliza: builders can create Cloud apps, use app login, route chat and media through Cloud, deploy containers, promote apps, and monetize usage.",
    "Eliza and Eliza can help builders make money with Cloud apps by setting inference markup or purchase share, sending Stripe/OxaPay app-credit payment requests, sending x402 crypto payment requests, tracking paid status, routing payment results back into the initiating conversation, earning affiliate or creator revenue share, and requesting admin-reviewed elizaOS token payouts on Base, BSC, Ethereum, or Solana.",
    "Paid Cloud actions such as payment requests, domain purchases, and payout requests should be confirmed explicitly before they are created.",
  ],
  messageExamples: persona.messageExamples,
  topics: persona.topics,
  adjectives: persona.adjectives,
  style: persona.style,
};

const agent = {
  character,
  plugins: [],
  providers: [],
  actions: [],
};

export default agent;
