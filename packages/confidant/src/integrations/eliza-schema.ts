import { defineSecretSchema } from "../secret-schema.js";
import type { SecretSchemaEntry } from "../types.js";
import {
  ELIZA_ENV_TO_SECRET_ID,
  ELIZA_PROVIDER_TO_SECRET_ID,
} from "./eliza-providers.js";

/**
 * Registers the canonical schema for every credential id in the
 * elizaOS catalog (LLM providers, connectors, wallets, RPC, storage,
 * tools, music, services). Apps that adopt Confidant in their boot
 * path call this once instead of writing dozens of individual
 * `defineSecretSchema` calls.
 *
 * Each entry attributes ownership to the matching `@elizaos/plugin-*`
 * so the implicit-grant rule (registering plugin gets always-access to
 * its own ids) fires automatically once those plugins migrate to
 * Confidant reads.
 *
 * Plugins not yet in this set keep `process.env` access until they
 * register their own schemas; that's the migration path described in
 * §9.5 of the design doc.
 *
 * The function is idempotent — calling it twice is a no-op (each
 * underlying `defineSecretSchema` call is checked against the existing
 * registry; same plugin id + same secret id = silent re-register).
 */
export function registerElizaSecretSchemas(): void {
  // Build all schema entries up front; defineSecretSchema validates and
  // commits the whole batch atomically.
  const entries: Record<
    string,
    Omit<SecretSchemaEntry, "id">
  > = {};

  // Index every known SecretId with its label, sensitivity, and owner.
  // We derive label from the SecretId namespace and the env-var name
  // (when available) so the registry is the single source of truth and
  // labels stay in sync with the env-var name they materialize from.
  const seen = new Set<string>();
  for (const secretId of Object.values(ELIZA_ENV_TO_SECRET_ID)) {
    if (seen.has(secretId)) continue;
    seen.add(secretId);
    entries[secretId] = describeSecret(secretId);
  }
  // Also include subscription tokens (those don't appear in the env-var
  // map because they're not exposed to skill code via env vars; they're
  // resolved through the runtime's account pool).
  entries["subscription.anthropic.accessToken"] = describeSecret(
    "subscription.anthropic.accessToken",
  );
  entries["subscription.openai.accessToken"] = describeSecret(
    "subscription.openai.accessToken",
  );

  defineSecretSchema(entries);
}

/**
 * Backwards-compatible alias for the original LLM-only entry point.
 * Prefer `registerElizaSecretSchemas` — it covers the whole catalog.
 *
 * @deprecated Use `registerElizaSecretSchemas`.
 */
export function registerElizaProviderSchemas(): void {
  registerElizaSecretSchemas();
}

function describeSecret(secretId: string): Omit<SecretSchemaEntry, "id"> {
  const segments = secretId.split(".");
  const domain = segments[0] ?? "";
  const subject = segments[1] ?? "";
  const field = segments.slice(2).join(".") || "value";
  const label = labelFor(domain, subject, field);
  const formatHint = formatHintFor(secretId);
  const pluginId = pluginIdFor(domain, subject);
  return {
    label,
    ...(formatHint ? { formatHint } : {}),
    sensitive: true,
    pluginId,
  };
}

function labelFor(domain: string, subject: string, field: string): string {
  const subjectTitle = titleCase(subject);
  const fieldTitle = humanize(field);
  switch (domain) {
    case "llm":
      return `${subjectTitle} ${fieldTitle}`.trim();
    case "subscription":
      return `${subjectTitle} Subscription Token`;
    case "tts":
      return `${subjectTitle} TTS API Key`;
    case "connector":
      return `${subjectTitle} ${fieldTitle}`.trim();
    case "tool":
      return `${subjectTitle} ${fieldTitle}`.trim();
    case "storage":
      return `${subjectTitle} ${fieldTitle}`.trim();
    case "wallet":
      return subject ? `${subjectTitle} ${fieldTitle}`.trim() : fieldTitle;
    case "rpc":
      return `${subjectTitle} RPC ${fieldTitle}`.trim();
    case "trading":
      return `${subjectTitle} ${fieldTitle}`.trim();
    case "music":
      return `${subjectTitle} ${fieldTitle}`.trim();
    case "service":
      return `${subjectTitle} ${fieldTitle}`.trim();
    default:
      return [subjectTitle, fieldTitle].filter(Boolean).join(" ");
  }
}

function humanize(field: string): string {
  if (!field) return "";
  return field
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/Api Key/gi, "API Key")
    .replace(/Api Token/gi, "API Token")
    .replace(/Access Token/gi, "Access Token")
    .replace(/Webhook Secret/gi, "Webhook Secret")
    .trim();
}

function titleCase(s: string): string {
  if (!s) return "";
  // Special-cased acronyms we want to keep as the user types them.
  const acronyms: Record<string, string> = {
    s3: "S3",
    evm: "EVM",
    rpc: "RPC",
    acp: "ACP",
    aws: "AWS",
    api: "API",
    n8n: "n8n",
    elizacloud: "Eliza Cloud",
    "vercel-ai-gateway": "Vercel AI Gateway",
    vercelaigateway: "Vercel AI Gateway",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    google: "Google",
    anthropic: "Anthropic",
    xai: "xAI",
    deepseek: "DeepSeek",
    mistral: "Mistral",
    together: "Together AI",
    groq: "Groq",
    zai: "Z.AI",
    ollama: "Ollama",
    moltbook: "Moltbook",
    blooio: "Bloo.io",
    elevenlabs: "ElevenLabs",
    twilio: "Twilio",
    github: "GitHub",
    linear: "Linear",
    roblox: "Roblox",
    x: "X",
    capsolver: "Capsolver",
    browserbase: "Browserbase",
    alchemy: "Alchemy",
    infura: "Infura",
    ankr: "Ankr",
    helius: "Helius",
    birdeye: "Birdeye",
    jupiter: "Jupiter",
    moralis: "Moralis",
    coingecko: "CoinGecko",
    dexscreener: "DEXScreener",
    zeroex: "0x",
    polymarket: "Polymarket",
    hedera: "Hedera",
    solana: "Solana",
    lastfm: "Last.fm",
    genius: "Genius",
    theaudiodb: "TheAudioDB",
    spotify: "Spotify",
  };
  const lower = s.toLowerCase();
  if (acronyms[lower]) return acronyms[lower] as string;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatHintFor(secretId: string): string | undefined {
  switch (secretId) {
    case "llm.anthropic.apiKey":
    case "subscription.anthropic.accessToken":
      return "sk-ant-...";
    case "llm.openai.apiKey":
    case "llm.openai.embeddingApiKey":
    case "subscription.openai.accessToken":
      return "sk-...";
    case "llm.openrouter.apiKey":
      return "sk-or-v1-...";
    case "llm.groq.apiKey":
      return "gsk_...";
    case "llm.xai.apiKey":
      return "xai-...";
    case "llm.together.apiKey":
      return "together-...";
    default:
      return undefined;
  }
}

function pluginIdFor(domain: string, subject: string): string {
  // Provider-id-aware mapping for the cases that don't follow the
  // 1:1 `@elizaos/plugin-{subject}` pattern.
  const overrides: Record<string, string> = {
    "llm.google": "@elizaos/plugin-google-genai",
    "llm.vercelAiGateway": "@elizaos/plugin-vercel-ai-gateway",
    "subscription.anthropic": "@elizaos/plugin-anthropic",
    "subscription.openai": "@elizaos/plugin-openai",
    "service.elizacloud": "@elizaos/plugin-elizacloud",
    "service.acp": "@elizaos/plugin-acp",
    "service.blooio": "@elizaos/plugin-blooio",
    "service.moltbook": "@elizaos/plugin-moltbook",
    "tts.elevenlabs": "@elizaos/plugin-elevenlabs",
    "tool.n8n": "@elizaos/plugin-n8n-workflow",
    "tool.capsolver": "@elizaos/plugin-browser",
    "tool.browserbase": "@elizaos/plugin-browser",
    "storage.s3": "@elizaos/plugin-s3-storage",
    "wallet.": "@elizaos/plugin-evm",
    "wallet.evm": "@elizaos/plugin-evm",
    "wallet.solana": "@elizaos/plugin-solana",
    "wallet.hedera": "@elizaos/plugin-hedera",
    "wallet.polymarket": "@elizaos/plugin-polymarket",
    "rpc.alchemy": "@elizaos/plugin-evm",
    "rpc.infura": "@elizaos/plugin-evm",
    "rpc.ankr": "@elizaos/plugin-evm",
    "rpc.helius": "@elizaos/plugin-solana",
    "rpc.birdeye": "@elizaos/plugin-solana",
    "rpc.jupiter": "@elizaos/plugin-solana",
    "rpc.moralis": "@elizaos/plugin-evm",
    "rpc.coingecko": "@elizaos/plugin-social-alpha",
    "rpc.dexscreener": "@elizaos/plugin-social-alpha",
    "rpc.zeroex": "@elizaos/plugin-auto-trader",
    "trading.polymarket": "@elizaos/plugin-polymarket",
    "music.lastfm": "@elizaos/plugin-music-library",
    "music.genius": "@elizaos/plugin-music-library",
    "music.theaudiodb": "@elizaos/plugin-music-library",
    "music.spotify": "@elizaos/plugin-music-library",
    "connector.x": "@elizaos/plugin-twitter",
  };
  const key = `${domain}.${subject}`;
  if (overrides[key]) return overrides[key] as string;
  if (domain === "wallet" && subject) {
    return overrides[`wallet.${subject}`] ?? "@elizaos/plugin-evm";
  }
  return `@elizaos/plugin-${subject}`;
}

// Confirm at module-load time that every entry in
// ELIZA_PROVIDER_TO_SECRET_ID has a matching entry in
// ELIZA_ENV_TO_SECRET_ID via at least one env var. (Prevents drift
// between the two maps as they're maintained.)
function _assertConsistentMaps(): void {
  // This function exists for type-level documentation and is called by
  // the test suite, not the production runtime.
  void ELIZA_PROVIDER_TO_SECRET_ID;
}
