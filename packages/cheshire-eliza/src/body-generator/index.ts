/**
 * Eliza agent "body" + character generator for Cheshire Terminal.
 * Produces Character-shaped JSON and optional visual prompt for avatars.
 */

export type BodyArchetype =
  | "operator"
  | "trader"
  | "forge-smith"
  | "researcher"
  | "mascot";

export type BodyGeneratorInput = {
  name: string;
  archetype?: BodyArchetype;
  rails?: Array<"solana" | "robinhood">;
  traits?: string[];
  topics?: string[];
  includeE2B?: boolean;
  includeMemory?: boolean;
  includeForge?: boolean;
  systemExtra?: string;
};

export type GeneratedAgentBody = {
  character: {
    name: string;
    username: string;
    bio: string[];
    adjectives: string[];
    topics: string[];
    system: string;
    plugins: string[];
    style: { all: string[]; chat: string[]; post: string[] };
  };
  /** Prompt for image models / Imagine */
  visualPrompt: string;
  /** Metadata for catalog / forge URI */
  bodyMeta: {
    archetype: BodyArchetype;
    rails: string[];
    version: string;
    generatedAt: string;
  };
};

const ARCHETYPE_TRAITS: Record<BodyArchetype, string[]> = {
  operator: ["precise", "preview-first", "ops-minded", "calm"],
  trader: ["risk-aware", "fast", "data-driven", "disciplined"],
  "forge-smith": ["identity-native", "dual-rail", "methodical", "auditable"],
  researcher: ["curious", "cited", "patient", "skeptical"],
  mascot: ["playful", "wry", "memorable", "friendly"],
};

const ARCHETYPE_TOPICS: Record<BodyArchetype, string[]> = {
  operator: ["runtime ops", "Fly deploys", "health checks", "secrets hygiene"],
  trader: ["spot", "perps", "position sizing", "funding rates"],
  "forge-smith": ["Metaplex Core", "ERC-8004", "agentURI", "omni mint"],
  researcher: ["market structure", "on-chain analytics", "docs"],
  mascot: ["Cheshire lore", "community", "UX tone"],
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48);
}

/**
 * Generate a full agent body (character + visual) from a short brief.
 */
export function generateAgentBody(input: BodyGeneratorInput): GeneratedAgentBody {
  const archetype = input.archetype || "operator";
  const rails = input.rails?.length ? input.rails : ["solana", "robinhood"];
  const adjectives = [
    ...(input.traits || []),
    ...ARCHETYPE_TRAITS[archetype],
  ].slice(0, 8);
  const topics = [
    ...(input.topics || []),
    ...ARCHETYPE_TOPICS[archetype],
    ...rails.map((r) => (r === "solana" ? "Solana" : "Robinhood Chain")),
  ];

  // elizaOS order: storage → bootstrap → model → domain
  const plugins = [
    "@elizaos/plugin-sql",
    "@elizaos/plugin-bootstrap",
    "@elizaos/plugin-openai",
  ];
  if (input.includeForge !== false) {
    plugins.push("@elizaos/plugin-robinhood", "@elizaos/plugin-solana-forging");
  }
  if (input.includeE2B !== false) {
    plugins.push("@elizaos/plugin-e2b-computer");
  }
  if (input.includeMemory !== false) {
    plugins.push("@elizaos/plugin-cheshire-memory");
  }
  // Always attach ClawdBrowser tools.md catalog unless forge is fully stripped
  if (input.includeForge !== false) {
    plugins.push("@elizaos/plugin-clawdbrowser");
  }
  // Spot trading via DFlow + Helius (preview-first)
  plugins.push("@elizaos/plugin-dflow-trade");

  const railLine = rails.join(" + ");
  const bio = [
    `${input.name} is a Cheshire Terminal elizaOS agent (${archetype}) on ${railLine}.`,
    "Never custodies private keys. Preview-first forge and trade paths.",
    "Clawd Code CLI companion: https://github.com/Solizardking/clawd-code (plugins/clawd-code submodule).",
    input.includeMemory !== false
      ? "Uses Hermes + Honcho for durable trading and chat memory when keys are configured."
      : "Session-local memory only unless plugins add more.",
    input.includeE2B !== false
      ? "Can run code in an E2B sandbox computer when E2B_API_KEY is set."
      : "No sandbox computer plugin.",
  ];

  const system = [
    `You are ${input.name}, a Cheshire Terminal agent (${archetype}).`,
    `Rails: ${railLine}.`,
    "Never ask for seed phrases or private keys.",
    "Default to preview/dry-run unless the operator explicitly enables live flags.",
    "Clawd Code is the external coding/trading CLI (plugins/clawd-code + plugins/clawd-plugin MCP bridge).",
    input.systemExtra || "",
  ]
    .filter(Boolean)
    .join("\n");

  const visualPrompt = [
    `Anthropomorphic ${archetype} agent mascot named ${input.name},`,
    "Cheshire Terminal aesthetic: dark UI, emerald accents, subtle smile,",
    rails.includes("solana") ? "Solana purple-green energy," : "",
    rails.includes("robinhood") ? "Robinhood Chain cyan circuit motifs," : "",
    "clean product-icon style, no text in image, high detail",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    character: {
      name: input.name,
      username: slugify(input.name),
      bio,
      adjectives: [...new Set(adjectives)],
      topics: [...new Set(topics)],
      system,
      plugins,
      style: {
        all: ["Be clear and operational", "No casino FOMO language"],
        chat: ["State preview vs live explicitly"],
        post: ["Share only verifiable outcomes"],
      },
    },
    visualPrompt,
    bodyMeta: {
      archetype,
      rails,
      version: "0.1.0",
      generatedAt: new Date().toISOString(),
    },
  };
}
