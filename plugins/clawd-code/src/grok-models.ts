/**
 * Clawd Code — Model Registry
 * xAI Grok + Anthropic Claude + DeepSeek model definitions
 */

export interface ModelDefinition {
  id: string;
  name: string;
  description: string;
  contextWindow: number;
  inputPrice: number;   // per 1M tokens
  outputPrice: number;  // per 1M tokens
  reasoning?: boolean;
  multiAgent?: boolean;
  responsesOnly?: boolean;
  supportsClientTools?: boolean;
  reasoningEfforts?: string[];
  aliases?: string[];
  provider?: 'xai' | 'anthropic' | 'deepseek' | 'openrouter';
  streaming?: boolean;
}

export const DEFAULT_MODEL = "grok-4.3";

export const MODELS: ModelDefinition[] = [
  // ── Anthropic Claude ──────────────────────────────────────────────────
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    description: "Anthropic flagship — best for code, reasoning, and agent tasks",
    contextWindow: 200_000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    reasoning: true,
    supportsClientTools: true,
    streaming: true,
    provider: 'anthropic',
    aliases: ["sonnet", "claude-sonnet", "sonnet-4-6"],
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    description: "Anthropic most capable — deep reasoning, complex synthesis",
    contextWindow: 200_000,
    inputPrice: 15.0,
    outputPrice: 75.0,
    reasoning: true,
    supportsClientTools: true,
    streaming: true,
    provider: 'anthropic',
    aliases: ["opus", "claude-opus", "opus-4-8"],
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    description: "Anthropic fastest model — low latency, high throughput",
    contextWindow: 200_000,
    inputPrice: 0.8,
    outputPrice: 4.0,
    supportsClientTools: true,
    streaming: true,
    provider: 'anthropic',
    aliases: ["haiku", "claude-haiku", "haiku-4-5"],
  },
  // ── DeepSeek ──────────────────────────────────────────────────────────
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    description: "DeepSeek flagship reasoning/coding model with 1M context",
    contextWindow: 1_000_000,
    inputPrice: 0.435,
    outputPrice: 0.87,
    reasoning: true,
    supportsClientTools: true,
    aliases: ["deepseek/pro", "deepseek-v4-pro[1m]", "v4-pro"],
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    description: "DeepSeek fast model with 1M context and low token cost",
    contextWindow: 1_000_000,
    inputPrice: 0.14,
    outputPrice: 0.28,
    reasoning: true,
    supportsClientTools: true,
    aliases: ["deepseek/flash", "v4-flash", "deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "grok-4.3",
    name: "Grok 4.3",
    description: "xAI flagship reasoning model — best for agent tasks, code, and market analysis",
    contextWindow: 256_000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    reasoning: true,
    supportsClientTools: true,
    aliases: ["grok-4-1-fast", "xai/grok-code-fast-1"],
  },
  {
    id: "grok-4.20-non-reasoning",
    name: "Grok 4.20 (Non-reasoning)",
    description: "Fast, cost-effective Grok model without extended reasoning",
    contextWindow: 256_000,
    inputPrice: 2.0,
    outputPrice: 10.0,
    supportsClientTools: true,
    aliases: ["grok-4.20-0309-non-reasoning", "x-ai/grok-3"],
  },
  {
    id: "grok-4.20-multi-agent",
    name: "Grok 4.20 Multi-Agent",
    description: "Specialized Grok model for multi-agent orchestration — responses API only",
    contextWindow: 256_000,
    inputPrice: 2.0,
    outputPrice: 10.0,
    multiAgent: true,
    responsesOnly: true,
    supportsClientTools: false,
    aliases: ["grok-4.20-multi-agent-0309", "x-ai/grok-4.20-multi-agent-beta"],
  },
  {
    id: "grok-4.20-reasoning",
    name: "Grok 4.20 Reasoning",
    description: "Grok model with extended chain-of-thought reasoning",
    contextWindow: 256_000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    reasoning: true,
    supportsClientTools: true,
    aliases: ["grok-4.20-0309-reasoning"],
  },
  {
    id: "grok-3-mini",
    name: "Grok 3 Mini",
    description: "Small, fast Grok model with configurable reasoning effort",
    contextWindow: 131_072,
    inputPrice: 0.3,
    outputPrice: 0.5,
    reasoning: true,
    supportsClientTools: true,
    reasoningEfforts: ["low", "high"],
    aliases: ["grok3-mini"],
  },
  {
    id: "grok-3",
    name: "Grok 3",
    description: "Capable, balanced Grok model — strong at reasoning and tool use",
    contextWindow: 131_072,
    inputPrice: 3.0,
    outputPrice: 15.0,
    supportsClientTools: true,
    aliases: ["grok3"],
  },
  {
    id: "grok-code-fast-1",
    name: "Grok Code Fast",
    description: "Grok model optimized for code generation and agentic coding",
    contextWindow: 256_000,
    inputPrice: 1.0,
    outputPrice: 5.0,
    supportsClientTools: true,
    aliases: ["grok-code"],
  },
];

const MODEL_BY_ID = new Map<string, ModelDefinition>();
const ALIAS_MAP = new Map<string, string>();

for (const m of MODELS) {
  MODEL_BY_ID.set(m.id, m);
  ALIAS_MAP.set(m.id.toLowerCase(), m.id);
  for (const alias of m.aliases ?? []) {
    ALIAS_MAP.set(alias.toLowerCase(), m.id);
  }
}

export function getModel(id: string): ModelDefinition | undefined {
  const canonical = ALIAS_MAP.get(id.toLowerCase());
  return canonical ? MODEL_BY_ID.get(canonical) : MODEL_BY_ID.get(id);
}

export function normalizeModelId(id: string): string {
  return ALIAS_MAP.get(id.toLowerCase()) ?? id;
}

export function listModelIds(): string[] {
  return MODELS.map((m) => m.id);
}

export function getSupportedReasoningEfforts(id: string): string[] {
  return getModel(id)?.reasoningEfforts ?? [];
}

export function getEffectiveReasoningEffort(id: string, effort?: string): string | undefined {
  const supported = getSupportedReasoningEfforts(id);
  if (supported.length === 0) return undefined;
  if (effort && supported.includes(effort)) return effort;
  return undefined;
}

export function isMultiAgentModel(id: string): boolean {
  return getModel(id)?.multiAgent === true;
}

export function isResponsesOnlyModel(id: string): boolean {
  return getModel(id)?.responsesOnly === true;
}

export function printModelsTable(): void {
  const providers = ['anthropic', 'xai', 'deepseek', 'openrouter'] as const;
  const labels: Record<string, string> = {
    anthropic: 'Anthropic Claude',
    xai: 'xAI Grok',
    deepseek: 'DeepSeek',
    openrouter: 'OpenRouter',
  };

  console.log('\n╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  CLAWD CODE — MODEL REGISTRY                                             ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════╣');
  console.log('║  ID                           │  Provider   │  Ctx   │  $/1M in/out  ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════╣');

  for (const provider of providers) {
    const group = MODELS.filter((m) => (m.provider ?? 'xai') === provider);
    if (group.length === 0) continue;
    console.log(`║  ── ${labels[provider].padEnd(67)}║`);
    for (const m of group) {
      const ctx = m.contextWindow >= 1_000_000
        ? `${(m.contextWindow / 1_000_000).toFixed(0)}M`
        : `${(m.contextWindow / 1000).toFixed(0)}K`;
      const price = `$${m.inputPrice}/$${m.outputPrice}`;
      const stream = m.streaming ? '~' : ' ';
      console.log(`║  ${stream}${(m.id.padEnd(29))} │  ${(provider.padEnd(10))} │  ${ctx.padStart(5)} │  ${price.padStart(12)}  ║`);
    }
  }

  console.log('╚══════════════════════════════════════════════════════════════════════════╝');
  console.log(`  ~ = streaming supported`);
  console.log(`\n  Default: ${DEFAULT_MODEL}  (CLAWD_MODEL=<id> to override)`);
  console.log('  Provider env: XAI_API_KEY | ANTHROPIC_API_KEY | DEEPSEEK_API_KEY | OPENROUTER_API_KEY');
}
