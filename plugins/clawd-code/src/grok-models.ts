/**
 * Clawd Code — Model Registry
 * Z.AI GLM + xAI Grok + Anthropic Claude + DeepSeek + OpenRouter model definitions
 *
 * Default model: Z.AI GLM-5.2 for code/REPL/trade/research.
 * Single source of truth used by cli.ts, modes/*, and the /inspect command.
 */

import {
  OPENROUTER_FABLE5,
  OPENROUTER_FABLE_LATESY,
  OPENROUTER_NEMO_MODEL1,
  OPENROUTER_NEMO_MODEL2,
  OPENROUTER_NEMO_MODEL3,
} from './openrouter.js';
import {
  ZAI_DEFAULT_MODEL,
  ZAI_FAST_MODEL,
  ZAI_IMAGE_FALLBACK_MODEL,
  ZAI_IMAGE_MODEL,
  ZAI_TRADE_VISION_MODEL,
  ZAI_VISION_FAST_MODEL,
  ZAI_VISION_MODEL,
} from './zai.js';

export type ClawdProvider = 'zai' | 'xai' | 'anthropic' | 'deepseek' | 'openrouter';

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
  provider: ClawdProvider;
  streaming?: boolean;
  /** Best-fit mode for this model (used by `clawd-code inspect` recommendations). */
  bestFor?: 'code' | 'research' | 'voice' | 'image' | 'general';
}

// ─── Default model constants (single source of truth) ───────────────────────
/** General-purpose default (code mode, REPL, trade). GLM-5.2 — 1M context, thinking, streaming. */
export const DEFAULT_MODEL = ZAI_DEFAULT_MODEL;
/** Default for research mode. */
export const DEFAULT_RESEARCH_MODEL = ZAI_DEFAULT_MODEL;
/** Default for image generation mode. */
export const DEFAULT_IMAGE_MODEL = ZAI_IMAGE_MODEL;
/** Default for voice agent mode (realtime voice). */
export const DEFAULT_VOICE_MODEL = 'grok-voice-think-fast-1.0';
/** Default for fast/cheap tasks. */
export const DEFAULT_FAST_MODEL = ZAI_FAST_MODEL;
/** Default for chart, screenshot, and multimodal analysis. */
export const DEFAULT_VISION_MODEL = ZAI_VISION_MODEL;
/** Default for trading chart vision analysis. */
export const DEFAULT_TRADE_VISION_MODEL = ZAI_TRADE_VISION_MODEL;
/** Default provider (Z.AI / GLM). */
export const DEFAULT_PROVIDER: ClawdProvider = 'zai';

// ─── Model catalog ──────────────────────────────────────────────────────────
export const MODELS: ModelDefinition[] = [
  // ── Z.AI GLM (default) ───────────────────────────────────────────────
  {
    id: ZAI_DEFAULT_MODEL,
    name: 'GLM-5.2',
    description: 'Z.AI strongest coding model — 1M context, thinking mode, reasoning_effort. DEFAULT for code/REPL/trade.',
    contextWindow: 1_000_000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: true,
    supportsClientTools: true,
    streaming: true,
    provider: 'zai',
    bestFor: 'code',
    aliases: ['glm5.2', 'glm-5-2', 'glm', 'zai', 'default'],
  },
  {
    id: ZAI_FAST_MODEL,
    name: 'GLM-5 Turbo',
    description: 'Z.AI faster GLM route for lower-latency coding and chat turns',
    contextWindow: 200_000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: true,
    supportsClientTools: true,
    streaming: true,
    provider: 'zai',
    bestFor: 'general',
    aliases: ['glm-5-fast', 'glm-fast', 'zai-fast'],
  },
  {
    id: ZAI_VISION_MODEL,
    name: 'GLM-5V-Turbo',
    description: 'Z.AI multimodal coding model for screenshots, charts, trading vision, and real-time visual analysis',
    contextWindow: 200_000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: true,
    supportsClientTools: true,
    streaming: true,
    provider: 'zai',
    bestFor: 'general',
    aliases: ['glm5v', 'glm-5v', 'glm-vision', 'zai-vision', 'chart-vision'],
  },
  {
    id: ZAI_VISION_FAST_MODEL,
    name: 'GLM-4.6V FlashX',
    description: 'Z.AI fast vision model for lightweight chart and screenshot analysis',
    contextWindow: 128_000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: true,
    supportsClientTools: true,
    streaming: true,
    provider: 'zai',
    bestFor: 'general',
    aliases: ['glm-4.6v-fast', 'glm-vision-fast', 'zai-vision-fast'],
  },
  {
    id: ZAI_IMAGE_MODEL,
    name: 'GLM-Image',
    description: 'Z.AI flagship image generation model — text-to-image via /images/generations. DEFAULT for image mode.',
    contextWindow: 0,
    inputPrice: 0,
    outputPrice: 0,
    supportsClientTools: false,
    streaming: false,
    provider: 'zai',
    bestFor: 'image',
    aliases: ['glm-image-gen', 'zai-image', 'image'],
  },
  {
    id: ZAI_IMAGE_FALLBACK_MODEL,
    name: 'CogView-4',
    description: 'Z.AI text-to-image fallback model',
    contextWindow: 0,
    inputPrice: 0,
    outputPrice: 0,
    supportsClientTools: false,
    streaming: false,
    provider: 'zai',
    bestFor: 'image',
    aliases: ['cogview', 'cogview4'],
  },
  // ── Anthropic Claude ──────────────────────────────────────────────────
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    description: 'Anthropic flagship — best for code, reasoning, and agent tasks',
    contextWindow: 200_000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    reasoning: true,
    supportsClientTools: true,
    streaming: true,
    provider: 'anthropic',
    bestFor: 'code',
    aliases: ['sonnet', 'claude-sonnet', 'sonnet-4-6'],
  },
  {
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    description: 'Anthropic most capable — deep reasoning, complex synthesis',
    contextWindow: 200_000,
    inputPrice: 15.0,
    outputPrice: 75.0,
    reasoning: true,
    supportsClientTools: true,
    streaming: true,
    provider: 'anthropic',
    bestFor: 'research',
    aliases: ['opus', 'claude-opus', 'opus-4-8'],
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    description: 'Anthropic fastest model — low latency, high throughput',
    contextWindow: 200_000,
    inputPrice: 0.8,
    outputPrice: 4.0,
    supportsClientTools: true,
    streaming: true,
    provider: 'anthropic',
    bestFor: 'general',
    aliases: ['haiku', 'claude-haiku', 'haiku-4-5'],
  },
  // ── DeepSeek ──────────────────────────────────────────────────────────
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    description: 'DeepSeek flagship reasoning/coding model with 1M context',
    contextWindow: 1_000_000,
    inputPrice: 0.435,
    outputPrice: 0.87,
    reasoning: true,
    supportsClientTools: true,
    provider: 'deepseek',
    bestFor: 'code',
    aliases: ['deepseek/pro', 'deepseek-v4-pro[1m]', 'v4-pro'],
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    description: 'DeepSeek fast model with 1M context and low token cost',
    contextWindow: 1_000_000,
    inputPrice: 0.14,
    outputPrice: 0.28,
    reasoning: true,
    supportsClientTools: true,
    provider: 'deepseek',
    bestFor: 'general',
    aliases: ['deepseek/flash', 'v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
  },
  // ── OpenRouter / NVIDIA Nemotron + Claude Fable ─────────────────────
  {
    id: OPENROUTER_NEMO_MODEL1,
    name: 'NVIDIA Nemotron 3 Ultra 550B Free',
    description: 'OpenRouter free high-intelligence default for balanced code and general prompts',
    contextWindow: 0,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: true,
    supportsClientTools: false,
    streaming: true,
    provider: 'openrouter',
    bestFor: 'code',
    aliases: ['nemo-ultra-free', 'nemo-balanced', 'openrouter-nemo', 'or-nemo'],
  },
  {
    id: OPENROUTER_NEMO_MODEL2,
    name: 'NVIDIA Nemotron 3 Ultra 550B',
    description: 'OpenRouter most-intelligent Nemo route for complex coding, research, and synthesis',
    contextWindow: 0,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: true,
    supportsClientTools: false,
    streaming: true,
    provider: 'openrouter',
    bestFor: 'research',
    aliases: ['nemo-ultra', 'nemo-intelligent', 'or-intelligent'],
  },
  {
    id: OPENROUTER_NEMO_MODEL3,
    name: 'NVIDIA Nemotron 3 Super 120B Free',
    description: 'OpenRouter fastest Nemo route for short prompts, summaries, and quick edits',
    contextWindow: 0,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: true,
    supportsClientTools: false,
    streaming: true,
    provider: 'openrouter',
    bestFor: 'general',
    aliases: ['nemo-super-free', 'nemo-fast', 'or-fast'],
  },
  {
    id: OPENROUTER_FABLE5,
    name: 'Claude Fable 5 (OpenRouter)',
    description: 'OpenRouter Anthropic Claude Fable 5 route for provider-backed code and reasoning tasks',
    contextWindow: 0,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: true,
    supportsClientTools: false,
    streaming: true,
    provider: 'openrouter',
    bestFor: 'code',
    aliases: ['fable5', 'fable-5', 'claude-fable-5', 'openrouter-fable5', 'or-fable5'],
  },
  {
    id: OPENROUTER_FABLE_LATESY,
    name: 'Claude Fable Latest (OpenRouter)',
    description: 'OpenRouter Anthropic Claude Fable latest alias for tracking the current Fable route',
    contextWindow: 0,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: true,
    supportsClientTools: false,
    streaming: true,
    provider: 'openrouter',
    bestFor: 'research',
    aliases: ['fable', 'fable-latest', 'claude-fable-latest', 'openrouter-fable-latest', 'or-fable-latest'],
  },
  // ── xAI Grok ──────────────────────────────────────────────────────────
  {
    id: 'grok-4.3',
    name: 'Grok 4.3',
    description: 'xAI flagship reasoning model — best for agent tasks, code, and market analysis.',
    contextWindow: 256_000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    reasoning: true,
    supportsClientTools: true,
    streaming: true,
    provider: 'xai',
    bestFor: 'code',
    aliases: ['grok-4-1-fast', 'xai/grok-code-fast-1', 'grok'],
  },
  {
    id: 'grok-4.3-fast',
    name: 'Grok 4.3 Fast',
    description: 'Faster, cost-optimised Grok 4.3 — same family, lower latency, lower $/M tokens.',
    contextWindow: 256_000,
    inputPrice: 0.6,
    outputPrice: 2.5,
    reasoning: true,
    supportsClientTools: true,
    streaming: true,
    provider: 'xai',
    bestFor: 'general',
    aliases: ['grok-fast', 'grok-4.3-fast-reasoning'],
  },
  {
    id: 'grok-4.20-non-reasoning',
    name: 'Grok 4.20 (Non-reasoning)',
    description: 'Fast, cost-effective Grok model without extended reasoning',
    contextWindow: 256_000,
    inputPrice: 2.0,
    outputPrice: 10.0,
    supportsClientTools: true,
    streaming: true,
    provider: 'xai',
    bestFor: 'general',
    aliases: ['grok-4.20-0309-non-reasoning', 'x-ai/grok-3'],
  },
  {
    id: 'grok-4.20-multi-agent',
    name: 'Grok 4.20 Multi-Agent',
    description: 'Specialized Grok model for multi-agent orchestration — responses API only.',
    contextWindow: 256_000,
    inputPrice: 2.0,
    outputPrice: 10.0,
    multiAgent: true,
    responsesOnly: true,
    supportsClientTools: false,
    streaming: true,
    provider: 'xai',
    bestFor: 'research',
    aliases: ['grok-4.20-multi-agent-0309', 'x-ai/grok-4.20-multi-agent-beta', 'multi-agent'],
  },
  {
    id: 'grok-4.20-reasoning',
    name: 'Grok 4.20 Reasoning',
    description: 'Grok model with extended chain-of-thought reasoning',
    contextWindow: 256_000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    reasoning: true,
    supportsClientTools: true,
    streaming: true,
    provider: 'xai',
    bestFor: 'code',
    aliases: ['grok-4.20-0309-reasoning'],
  },
  {
    id: 'grok-3-mini',
    name: 'Grok 3 Mini',
    description: 'Small, fast Grok model with configurable reasoning effort',
    contextWindow: 131_072,
    inputPrice: 0.3,
    outputPrice: 0.5,
    reasoning: true,
    supportsClientTools: true,
    streaming: true,
    reasoningEfforts: ['low', 'high'],
    provider: 'xai',
    bestFor: 'general',
    aliases: ['grok3-mini'],
  },
  {
    id: 'grok-3',
    name: 'Grok 3',
    description: 'Capable, balanced Grok model — strong at reasoning and tool use',
    contextWindow: 131_072,
    inputPrice: 3.0,
    outputPrice: 15.0,
    supportsClientTools: true,
    streaming: true,
    provider: 'xai',
    bestFor: 'general',
    aliases: ['grok3'],
  },
  {
    id: 'grok-code-fast-1',
    name: 'Grok Code Fast',
    description: 'Grok model optimized for code generation and agentic coding',
    contextWindow: 256_000,
    inputPrice: 1.0,
    outputPrice: 5.0,
    supportsClientTools: true,
    streaming: true,
    provider: 'xai',
    bestFor: 'code',
    aliases: ['grok-code', 'code-fast'],
  },
  {
    id: 'grok-imagine-image-quality',
    name: 'Grok Imagine Image Quality',
    description: 'xAI image generation & editing model — text-to-image and image-to-image via the xAI image API.',
    contextWindow: 0,
    inputPrice: 0,
    outputPrice: 0,
    supportsClientTools: false,
    streaming: false,
    provider: 'xai',
    bestFor: 'image',
    aliases: ['grok-imagine', 'imagine', 'grok-image'],
  },
  {
    id: 'grok-voice-think-fast-1.0',
    name: 'Grok Voice Think Fast 1.0',
    description: 'xAI realtime voice model — for the voice agent REPL with Solana tools. DEFAULT for voice --agent mode.',
    contextWindow: 0,
    inputPrice: 0,
    outputPrice: 0,
    supportsClientTools: true,
    streaming: true,
    provider: 'xai',
    bestFor: 'voice',
    aliases: ['grok-voice', 'voice', 'voice-fast'],
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

export function listModelsByProvider(provider: ClawdProvider): ModelDefinition[] {
  return MODELS.filter((m) => m.provider === provider);
}

/** Best default model for a given mode. */
export function defaultModelFor(mode: 'code' | 'research' | 'voice' | 'image' | 'general' | 'repl' | 'trade' | 'vision'): string {
  switch (mode) {
    case 'research': return DEFAULT_RESEARCH_MODEL;
    case 'image':    return DEFAULT_IMAGE_MODEL;
    case 'vision':   return DEFAULT_VISION_MODEL;
    case 'voice':    return DEFAULT_VOICE_MODEL;
    case 'code':
    case 'repl':
    case 'trade':
    case 'general':
    default:         return DEFAULT_MODEL;
  }
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

export function isStreamingSupported(id: string): boolean {
  return getModel(id)?.streaming === true;
}

/**
 * If the requested model is not usable for the given mode (e.g. responses-only
 * models can't do client-side tool calls in code mode), return a sensible
 * fallback. Otherwise return the requested id unchanged.
 */
export function resolveModelForMode(
  requested: string,
  mode: 'code' | 'repl' | 'trade' | 'research' | 'voice' | 'image' | 'general',
): string {
  if (mode !== 'research' && isResponsesOnlyModel(requested)) {
    return DEFAULT_MODEL;
  }
  return normalizeModelId(requested) || DEFAULT_MODEL;
}

export function printModelsTable(): void {
  const providers: ClawdProvider[] = ['zai', 'xai', 'anthropic', 'deepseek', 'openrouter'];
  const labels: Record<ClawdProvider, string> = {
    zai: 'Z.AI GLM  ⭐ default',
    xai: 'xAI Grok',
    anthropic: 'Anthropic Claude',
    deepseek: 'DeepSeek',
    openrouter: 'OpenRouter',
  };

  console.log('\n╔════════════════════════════════════════════════════════════════════════════╗');
  console.log('║  CLAWD CODE — MODEL REGISTRY (Z.AI GLM is the default provider)            ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════╣');
  console.log('║  ID                              │  Provider   │  Ctx   │  $/1M in/out  │ M ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════╣');

  const fit = (value: string, width: number): string =>
    value.length > width ? `${value.slice(0, width - 3)}...` : value.padEnd(width);

  for (const provider of providers) {
    const group = MODELS.filter((m) => m.provider === provider);
    if (group.length === 0) continue;
    console.log(`║  ── ${labels[provider].padEnd(72)}║`);
    for (const m of group) {
      const ctx = m.contextWindow >= 1_000_000
        ? `${(m.contextWindow / 1_000_000).toFixed(0)}M`
        : m.contextWindow >= 1000
          ? `${(m.contextWindow / 1000).toFixed(0)}K`
          : '—';
      const price = m.provider === 'openrouter'
        ? 'OpenRouter'
        : m.provider === 'zai'
          ? 'see Z.AI'
          : m.inputPrice || m.outputPrice
            ? `$${m.inputPrice}/$${m.outputPrice}`
            : 'see API';
      const stream = m.streaming ? '~' : ' ';
      const best = m.bestFor ? m.bestFor[0].toUpperCase() : ' ';
      console.log(`║  ${stream}${fit(m.id, 32)} │  ${(provider.padEnd(10))} │  ${ctx.padStart(5)} │  ${price.padStart(12)}  │ ${best} ║`);
    }
  }

  console.log('╚════════════════════════════════════════════════════════════════════════════╝');
  console.log('  ~ = streaming supported    M = best-fit mode (C=code, R=research, V=voice, I=image, G=general)');
  console.log(`\n  Default provider: ${DEFAULT_PROVIDER}    Default model: ${DEFAULT_MODEL}`);
  console.log(`  Research default: ${DEFAULT_RESEARCH_MODEL}    Vision default: ${DEFAULT_VISION_MODEL}    Image default: ${DEFAULT_IMAGE_MODEL}`);
  console.log('  Override: CLAWD_MODEL=<id|auto>  |  CLAWD_PROVIDER=zai|xai|anthropic|openrouter|deepseek');
  console.log('  API keys: ZAI_API_KEY | XAI_API_KEY | ANTHROPIC_API_KEY | DEEPSEEK_API_KEY | OPENROUTER_API_KEY');
}
