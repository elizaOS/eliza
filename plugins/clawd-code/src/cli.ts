#!/usr/bin/env node
/**
 * Clawd Code — CLI Entry Point
 * Headless lobster-native AI coding agent for the Clawd ecosystem
 * Default provider: Z.AI. Default model: glm-5.2 (code/REPL/trade/research).
 */

import * as C from './commands.js';
import { ENV_FILE_PATHS, loadClawdEnv, maskSecret } from './env.js';
import {
  DEFAULT_FAST_MODEL,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_RESEARCH_MODEL,
  DEFAULT_TRADE_VISION_MODEL,
  DEFAULT_VISION_MODEL,
  defaultModelFor,
  getModel,
  isStreamingSupported,
  listModelsByProvider,
  normalizeModelId,
  printModelsTable,
} from './grok-models.js';
import {
  getOpenRouterProviderModels,
  OPENROUTER_AUTO_MODEL,
  OPENROUTER_FABLE5,
  OPENROUTER_FABLE_LATESY,
  OPENROUTER_NEMO_MODEL1,
  OPENROUTER_NEMO_MODEL2,
  OPENROUTER_NEMO_MODEL3,
} from './openrouter.js';
import {
  getImperialConfig,
  imperialUnderwriterLabel,
  maskImperialCredential,
  type ImperialConfig,
} from './imperial.js';
import {
  getZaiEnvConfig,
  normalizeZaiReasoningEffort,
  normalizeZaiThinking,
  ZAI_AGENT_BASE_URL,
  ZAI_DEFAULT_MODEL,
  ZAI_IMAGE_MODEL,
  ZAI_SLIDE_AGENT_ID,
  ZAI_VISION_MODEL,
  type ZaiReasoningEffort,
  type ZaiThinkingType,
} from './zai.js';
import { createXaiClient } from './xai.js';
import { EnvironmentVerifier } from './verify.js';
import { runTelegramRelay } from './telegram.js';

type Mode = 'CODE' | 'TRADE' | 'RESEARCH' | 'IMAGE' | 'VOICE' | 'REPL';

interface ClawdCodeConfig {
  mode: Mode;
  provider: 'zai' | 'xai' | 'openrouter' | 'deepseek' | 'anthropic';
  liveTrading: boolean;
  operatorConfirmed: boolean;
  perpsSimOnly: boolean;
  perpsMaxNotional: number;
  perpsMaxLeverage: number;
  imperial: ImperialConfig;
  rpcUrl: string;
  xaiApiKey: string;
  zaiApiKey: string;
  zaiBaseUrl: string;
  zaiAgentBaseUrl: string;
  zaiChartModel: string;
  zaiChartVisionModel: string;
  zaiThinking: ZaiThinkingType;
  zaiReasoningEffort: ZaiReasoningEffort;
  zaiVisionModel: string;
  zaiTradeVisionModel: string;
  zaiImageModel: string;
  anthropicApiKey: string;
  deepSeekApiKey: string;
  deepSeekBaseUrl: string;
  heliusApiKey: string;
  phoenixRiseUrl: string;
  vulcanMcpUrl: string;
  agentCount: 4 | 16;
  model: string;
  stream: boolean;
}

const DEFAULT_HELIUS_RPC = process.env.HELIUS_RPC_URL ||
  (process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : 'https://api.mainnet-beta.solana.com');

function loadConfig(): ClawdCodeConfig {
  const env = loadClawdEnv();
  const provider = normalizeProvider(env.CLAWD_PROVIDER || process.env.CLAWD_PROVIDER || DEFAULT_PROVIDER);
  const zai = getZaiEnvConfig(env);
  const configuredModel = env.CLAWD_MODEL || defaultModelForProvider(provider);
  const imperial = getImperialConfig(env);
  // Default model is the registry default (glm-5.2). Provider-specific fallbacks
  // are applied only when the user explicitly changes CLAWD_PROVIDER.
  return {
    mode: (env.CLAWD_MODE as Mode) || 'CODE',
    provider,
    liveTrading: env.LIVE_TRADING === 'true',
    operatorConfirmed: env.OPERATOR_CONFIRMED === 'true',
    perpsSimOnly: env.PERPS_SIM_ONLY !== 'false',
    perpsMaxNotional: Number(env.PERPS_MAX_NOTIONAL_USD || imperial.maxNotionalUsd || 250),
    perpsMaxLeverage: Number(env.PERPS_MAX_LEVERAGE || imperial.maxLeverage || 3),
    imperial,
    rpcUrl: env.SOLANA_RPC_URL || env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || DEFAULT_HELIUS_RPC,
    xaiApiKey: env.XAI_API_KEY || process.env.XAI_API_KEY || '',
    zaiApiKey: env.ZAI_API_KEY || process.env.ZAI_API_KEY || '',
    zaiBaseUrl: zai.baseUrl,
    zaiAgentBaseUrl: zai.agentBaseUrl,
    zaiChartModel: zai.chartModel,
    zaiChartVisionModel: zai.chartVisionModel,
    zaiThinking: zai.thinkingType,
    zaiReasoningEffort: zai.reasoningEffort,
    zaiVisionModel: zai.visionModel,
    zaiTradeVisionModel: zai.tradeVisionModel,
    zaiImageModel: zai.imageModel,
    anthropicApiKey: env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '',
    deepSeekApiKey: env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || '',
    deepSeekBaseUrl: env.DEEPSEEK_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    heliusApiKey: env.HELIUS_API_KEY || process.env.HELIUS_API_KEY || '',
    phoenixRiseUrl: env.PHOENIX_RISE_URL || 'https://api.phoenix.gg/enclave',
    vulcanMcpUrl: env.VULCAN_MCP_URL || 'http://localhost:3001',
    agentCount: parseInt(env.CLAWD_AGENT_COUNT || '4', 10) as 4 | 16,
    model: provider === 'openrouter' && !env.CLAWD_MODEL ? OPENROUTER_AUTO_MODEL : configuredModel,
    stream: env.CLAWD_STREAM === 'true',
  };
}

function normalizeProvider(provider: string): 'zai' | 'xai' | 'openrouter' | 'deepseek' | 'anthropic' {
  const normalized = provider.toLowerCase();
  if (normalized === 'or') return 'openrouter';
  if (normalized === 'ds') return 'deepseek';
  if (normalized === 'claude' || normalized === 'ant') return 'anthropic';
  if (normalized === 'z' || normalized === 'zai' || normalized === 'z.ai' || normalized === 'glm') return 'zai';
  if (normalized === 'anthropic' || normalized === 'deepseek' || normalized === 'openrouter' || normalized === 'xai' || normalized === 'zai') return normalized;
  return DEFAULT_PROVIDER;
}

function defaultModelForProvider(provider: ClawdCodeConfig['provider']): string {
  switch (provider) {
    case 'zai': return DEFAULT_MODEL;
    case 'xai': return 'grok-4.3';
    case 'anthropic': return 'claude-sonnet-4-6';
    case 'deepseek': return 'deepseek-v4-pro';
    case 'openrouter': return OPENROUTER_AUTO_MODEL;
  }
}

async function runCodeMode(args: string[], config: ClawdCodeConfig): Promise<void> {
  const { CodeMode } = await import('./modes/code.js');
  await new CodeMode(config).run(args);
}

async function runTradeMode(args: string[], config: ClawdCodeConfig): Promise<void> {
  const { TradeMode } = await import('./modes/trade.js');
  await new TradeMode(config).run(args);
}

async function runResearchMode(args: string[], config: ClawdCodeConfig): Promise<void> {
  const { ResearchMode } = await import('./modes/research.js');
  await new ResearchMode(config).run(args);
}

async function runImageMode(args: string[], config: ClawdCodeConfig): Promise<void> {
  const { ImageMode } = await import('./modes/image.js');
  await new ImageMode(config).run(args);
}

async function runVoiceMode(args: string[], config: ClawdCodeConfig): Promise<void> {
  const { VoiceMode } = await import('./modes/voice.js');
  await new VoiceMode(config).run(args);
}

async function runReplMode(config: ClawdCodeConfig): Promise<void> {
  const { ReplMode } = await import('./modes/repl.js');
  await new ReplMode(config).run();
}

function printBanner(): void {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  🦞 CLAWD CODE                                           ║
║  Lobster-native headless AI coding agent                  ║
║  Default: Z.AI GLM-5.2 (code/research) · GLM-Image        ║
║  Z.AI · xAI · Anthropic · DeepSeek · Solana · Phoenix    ║
╚═══════════════════════════════════════════════════════════╝
`);
}

function printUsage(): void {
  printBanner();
  console.log(`
USAGE:
  clawd-code [mode] [command] [options]

DEFAULT MODEL:
  Provider:  Z.AI
  Code/REPL: ${ZAI_DEFAULT_MODEL}  (1M context, thinking mode, streaming)
  Research:  ${ZAI_DEFAULT_MODEL}  (thinking + reasoning_effort)
  Vision:    ${ZAI_VISION_MODEL}  (trade charts, screenshots, visual analysis)
  Chart:     ${ZAI_DEFAULT_MODEL} + ${ZAI_VISION_MODEL} + ${ZAI_SLIDE_AGENT_ID}
  Voice:     grok-voice-think-fast-1.0  (realtime voice agent)
  Image:     ${ZAI_IMAGE_MODEL}  (text-to-image)

MODES:
  code       Write, review, and ship production code (streaming)
  chain      Solana blockchain RPC harness with Z.AI planning
  chart      GLM-5.2 chart/report agent with GLM-5V vision
  slides     GLM Slide/Poster Agent deck export
  poster     GLM Slide/Poster Agent poster export
  trade      Perpetuals trading with Phoenix Rise + Vulcan MCP
  imperial   Imperial router status, auth, funding, balances, positions, orders
  research   Deep research with GLM-5.2 thinking mode
  image      Generate images via GLM-Image, DALL-E, or Gemini fallback
  voice      Text-to-speech, sherpa-onnx, or xAI voice agent REPL
  repl       Interactive multi-turn conversation REPL

GLOBAL COMMANDS:
  /verify                 Run preflight checks for Z.AI, RPC, and trading gates
  /models                 List all available models (Z.AI + Grok + Claude + DeepSeek)
  /models <id>            Switch to a specific model (alias or canonical id)
  /provider               Show current AI provider + API key status
  /provider <name>        Switch provider: zai | xai | anthropic | openrouter | deepseek
  /spinner                List/install themed spinner packs
  /inspect                Print discovered config, models, and provider health

COMMANDS:
  clawd-code code "Build a Jupiter swap bot"
  clawd-code chain status
  clawd-code chain balance default
  clawd-code chain ask "inspect this program safely"
  clawd-code chart "analyze chart" --image ./chart.png
  clawd-code slides "weekly Solana market report" --pages 6
  clawd-code poster "launch poster for a new charting model"
  clawd-code trade "SOL funding rate?"
  clawd-code imperial status
  clawd-code imperial auth imperial --arm-live
  clawd-code research "AI agent frameworks 2025"
  clawd-code image "cyberpunk Solana trading desk"
  clawd-code voice "Hello from Clawd Code"
  clawd-code repl
  clawd-code spinner install developer

OPTIONS:
  --mode <mode>          Set mode (code|chain|chart|trade|research|image|voice|repl)
  --agents <n>           Number of agents for research (4|16)
  --live                 Enable live trading (requires ARM flags)
  --paper                Paper trading mode (default)
  --model <model>        Override model (glm-5.2 | grok-4.3 | auto | ...)
  --provider <name>      Override provider for this session
  --stream               Stream output token-by-token (code + research modes)
  --thinking             Enable Z.AI thinking mode for this session
  --no-thinking          Disable Z.AI thinking mode for this session
  --reasoning-effort <n> Z.AI effort: max|xhigh|high|medium|low|minimal|none
  --format <fmt>         Output format: text (default) | json (JSONL)

EXAMPLES:
  clawd-code trade "short SOL $100"
  clawd-code research --agents 16 "Solana perps funding arb"
  clawd-code code --stream --model glm-5.2 "Build an Anchor staking program"
  clawd-code code --provider anthropic "Review this TypeScript for bugs"
  clawd-code trade "analyze chart" --chart ./chart.png
  clawd-code chart "portfolio drawdown dashboard" --slides --pages 5
  clawd-code image "cyberpunk Solana trading desk" --model glm-image
  clawd-code spinner list
  clawd-code repl
  clawd-code inspect

ENVIRONMENT:
  SOLANA_RPC_URL         Solana RPC endpoint (default: Helius)
  SOLANA_CLUSTER         mainnet-beta | devnet | testnet | localnet
  SOLANA_COMMITMENT      processed | confirmed (default) | finalized
  SOLANA_HARNESS_READONLY true by default; set false only with live gates for send-raw
  ZAI_API_KEY            Z.AI API key for GLM-5.2 / GLM-5V / GLM-Image (required for default)
  ZAI_BASE_URL           Default: https://api.z.ai/api/paas/v4
  ZAI_AGENT_BASE_URL     Default: ${ZAI_AGENT_BASE_URL}
  ZAI_MODEL              Default: ${ZAI_DEFAULT_MODEL}
  ZAI_CHART_MODEL        Default: ${ZAI_DEFAULT_MODEL}
  ZAI_VISION_MODEL       Default: ${DEFAULT_VISION_MODEL}
  ZAI_TRADE_VISION_MODEL Default: ${DEFAULT_TRADE_VISION_MODEL}
  ZAI_CHART_VISION_MODEL Default: ${DEFAULT_TRADE_VISION_MODEL}
  ZAI_IMAGE_MODEL        Default: ${ZAI_IMAGE_MODEL}
  ZAI_THINKING           enabled (default) | disabled
  ZAI_REASONING_EFFORT   max (default) | xhigh | high | medium | low | minimal | none
  XAI_API_KEY            xAI API key for Grok / Voice Agent API
  ANTHROPIC_API_KEY      Anthropic API key for Claude models
  DEEPSEEK_API_KEY       DeepSeek API key for deepseek-v4-pro/flash
  DEEPSEEK_BASE_URL      Default: https://api.deepseek.com
  OPENROUTER_API_KEY     OpenRouter API key (free models supported)
  OPENROUTER_NEMO_MODEL1 Balanced/free route. Default: ${OPENROUTER_NEMO_MODEL1}
  OPENROUTER_NEMO_MODEL2 Most-intelligent route. Default: ${OPENROUTER_NEMO_MODEL2}
  OPENROUTER_NEMO_MODEL3 Fast/free route. Default: ${OPENROUTER_NEMO_MODEL3}
  OPENROUTER_FABLE5     Claude Fable 5 route. Default: ${OPENROUTER_FABLE5}
  OPENROUTER_FABLE_LATESY Claude Fable latest route. Default: ${OPENROUTER_FABLE_LATESY}
  OPENROUTER_FREE_MODEL  Legacy alias for the balanced/free OpenRouter default
  CLAWD_PROVIDER         zai (default) | xai | anthropic | openrouter | deepseek
  CLAWD_MODEL            Default: ${ZAI_DEFAULT_MODEL}  (use auto with OpenRouter for prompt routing)
  CLAWD_STREAM           true to enable streaming by default
  HELIUS_API_KEY         Helius API key for DAS
  PHOENIX_RISE_URL       Phoenix Rise endpoint
  VULCAN_MCP_URL         Vulcan MCP server URL
  LIVE_TRADING           Enable live trading (true|false)
  OPERATOR_CONFIRMED     Operator confirmed (true|false)
  PERPS_SIM_ONLY         Keep perps simulated unless explicitly false
  IMPERIAL_ENABLED       Enable Imperial API reads/routing (true|false)
  IMPERIAL_LIVE          Enable Imperial live order path after global gates
  IMPERIAL_WALLET        Wallet pubkey that owns Imperial JWT/profile
  IMPERIAL_JWT           Imperial mobile JWT (secret trading credential)
  IMPERIAL_PROFILE_INDEX Profile 0..5; default convention is 0
  IMPERIAL_DEFAULT_UNDERWRITER Phoenix default: 2
  CLAWD_MODE             Default mode (code|chain|chart|trade|research|image|voice|repl)
  CLAWD_AGENT_COUNT      Agent count for research (4|16)

GROK CONFIG (optional):
  ~/.grok/config.toml    xAI-style config — see parseGrokConfigToml() in src/env.ts
  ./.grok/config.toml    Project-level Grok config (overrides user)

First run: cp .env.example ~/.clawd-code/.env
`);
}

async function cmdInspect(): Promise<void> {
  const env = loadClawdEnv();
  const provider = normalizeProvider(env.CLAWD_PROVIDER || DEFAULT_PROVIDER);
  const model = env.CLAWD_MODEL || DEFAULT_MODEL;
  const openRouterModels = getOpenRouterProviderModels(env);
  const zai = getZaiEnvConfig(env);
  const fit = (value: string, width: number): string =>
    value.length > width ? `${value.slice(0, width - 3)}...` : value.padEnd(width);

  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  CLAWD CODE — INSPECT  (Grok-compatible discovery report)            ║');
  console.log('╠══════════════════════════════════════════════════════════════════════╣');

  // 1. Config sources
  console.log('║                                                                      ║');
  console.log('║  CONFIG SOURCES                                                      ║');
  for (const [label, path] of Object.entries(ENV_FILE_PATHS)) {
    const ok = (await import('node:fs')).existsSync(path);
    console.log(`║  ${ok ? '✓' : '·'} ${label.padEnd(14)} ${(ok ? path : `(${path} not found)`).padEnd(56)}║`);
  }

  // 2. Active provider + model
  console.log('║                                                                      ║');
  console.log('║  ACTIVE PROVIDER / MODEL                                             ║');
  console.log(`║    provider : ${fit(provider, 58)}║`);
  console.log(`║    model    : ${fit(model, 58)}║`);
  const def = getModel(model);
  if (def) {
    console.log(`║    name     : ${fit(def.name, 58)}║`);
    console.log(`║    stream   : ${fit(isStreamingSupported(model) ? 'yes (SSE)' : 'no', 58)}║`);
    if (def.reasoningEfforts && def.reasoningEfforts.length) {
      console.log(`║    efforts  : ${fit(def.reasoningEfforts.join(', '), 58)}║`);
    }
  }

  // 3. API key health
  console.log('║                                                                      ║');
  console.log('║  API KEY STATUS                                                      ║');
  console.log(`║    xai         ${maskSecret(env.XAI_API_KEY).padEnd(58)}║`);
  console.log(`║    zai         ${maskSecret(env.ZAI_API_KEY).padEnd(58)}║`);
  console.log(`║    anthropic   ${maskSecret(env.ANTHROPIC_API_KEY).padEnd(58)}║`);
  console.log(`║    deepseek    ${maskSecret(env.DEEPSEEK_API_KEY).padEnd(58)}║`);
  console.log(`║    openrouter  ${maskSecret(env.OPENROUTER_API_KEY).padEnd(58)}║`);
  const imperial = getImperialConfig(env);
  console.log(`║    imperial    ${maskImperialCredential(imperial.jwt).padEnd(58)}║`);
  console.log(`║    OR route 1  ${fit(openRouterModels.model1, 58)}║`);
  console.log(`║    OR route 2  ${fit(openRouterModels.model2, 58)}║`);
  console.log(`║    OR route 3  ${fit(openRouterModels.model3, 58)}║`);
  console.log(`║    OR fable5   ${fit(openRouterModels.fable5, 58)}║`);
  console.log(`║    OR latest   ${fit(openRouterModels.latest, 58)}║`);
  console.log(`║    ZAI model   ${fit(zai.model, 58)}║`);
  console.log(`║    ZAI chart   ${fit(zai.chartModel, 58)}║`);
  console.log(`║    ZAI vision  ${fit(zai.visionModel, 58)}║`);
  console.log(`║    ZAI c-viz   ${fit(zai.chartVisionModel, 58)}║`);
  console.log(`║    ZAI image   ${fit(zai.imageModel, 58)}║`);
  console.log(`║    ZAI agent   ${fit(zai.agentBaseUrl, 58)}║`);
  console.log(`║    ZAI think   ${fit(`${zai.thinkingType} / ${zai.reasoningEffort}`, 58)}║`);
  console.log(`║    Imperial    ${fit(`${imperial.enabled ? 'enabled' : 'disabled'} / ${imperial.live ? 'live requested' : 'read/paper'} / ${imperialUnderwriterLabel(imperial.defaultUnderwriter)}`, 58)}║`);
  console.log(`║    Imp wallet  ${fit(imperial.wallet ? `${imperial.wallet.slice(0, 8)}...${imperial.wallet.slice(-4)}` : '(unset)', 58)}║`);

  // 4. xAI live ping
  const xai = createXaiClient(env.XAI_API_KEY);
  if (xai) {
    process.stdout.write('║    xai /v1/models  … ');
    const ping = await xai.ping();
    if (ping.ok) {
      const sample = (ping.models ?? []).slice(0, 4).join(', ');
      console.log(`online (${ping.models?.length ?? 0} models, e.g. ${sample})`.padEnd(34) + '║');
    } else {
      console.log(`offline (${ping.error ?? 'unknown'})`.padEnd(48) + '║');
    }
  } else {
    console.log('║    xai /v1/models  · (skipped — no XAI_API_KEY)                       ║');
  }

  // 5. Per-mode defaults
  console.log('║                                                                      ║');
  console.log('║  PER-MODE DEFAULTS                                                   ║');
  const modes: Array<['code' | 'research' | 'voice' | 'image' | 'repl' | 'trade' | 'general', string]> = [
    ['code', 'code/REPL/trade default'],
    ['research', 'research (multi-agent)'],
    ['image', 'image generation'],
    ['voice', 'voice agent'],
  ];
  for (const [mode, label] of modes) {
    const m = defaultModelFor(mode);
    const canonical = normalizeModelId(m);
    const tag = canonical === m ? '' : ` (alias → ${canonical})`;
    console.log(`║    ${label.padEnd(24)} ${(m + tag).padEnd(46)}║`);
  }

  // 6. Provider model summary
  console.log('║                                                                      ║');
  console.log('║  AVAILABLE MODELS BY PROVIDER                                        ║');
  for (const prov of ['zai', 'xai', 'anthropic', 'deepseek', 'openrouter'] as const) {
    const ms = listModelsByProvider(prov);
    if (ms.length === 0) continue;
    const ids = ms.map((m) => m.id).join(', ');
    console.log(`║    ${prov.padEnd(11)} (${String(ms.length).padStart(2)})  ${ids.substring(0, 50).padEnd(52)}║`);
  }

  // 7. Footer
  console.log('║                                                                      ║');
  console.log(`║  Default provider: ${DEFAULT_PROVIDER.padEnd(48)}║`);
  console.log(`║  Default model   : ${DEFAULT_MODEL.padEnd(48)}║`);
  console.log(`║  Research model  : ${DEFAULT_RESEARCH_MODEL.padEnd(48)}║`);
  console.log(`║  Fast model      : ${DEFAULT_FAST_MODEL.padEnd(48)}║`);
  console.log(`║  Vision model    : ${DEFAULT_VISION_MODEL.padEnd(48)}║`);
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');
}

async function main(): Promise<void> {
  loadClawdEnv();
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  // /models command
  if (args[0] === '/models' || args[0] === 'models') {
    if (args[1]) {
      const normalized = normalizeModelId(args[1]);
      console.log(`\n[CLAWD CODE] Switched model to: ${normalized}`);
      console.log(`Set CLAWD_MODEL=${normalized} in ~/.clawd-code/.env to persist.`);
    } else {
      printModelsTable();
    }
    process.exit(0);
  }

  // /telegram command — long-poll relay: chat/CLI only, no computer-use control
  if (args[0] === '/telegram' || args[0] === 'telegram') {
    await runTelegramRelay();
    process.exit(0);
  }

  // /verify command
  if (args[0] === '/verify' || args[0] === 'verify') {
    EnvironmentVerifier.loadEnvFile();
    const verifier = new EnvironmentVerifier();
    const results = await verifier.verifyAll();
    const report = verifier.printReport(results);
    process.exit(report.ok ? 0 : 1);
  }

  // /inspect command — grok inspect equivalent
  if (args[0] === '/inspect' || args[0] === 'inspect') {
    await cmdInspect();
    process.exit(0);
  }

  // /provider command — switch between AI providers
  if (args[0] === '/provider' || args[0] === 'provider') {
    const env = loadClawdEnv();
    const current = normalizeProvider(env.CLAWD_PROVIDER || DEFAULT_PROVIDER);
    if (args[1]) {
      const normalized = normalizeProvider(args[1]);
      const valid = ['zai', 'xai', 'anthropic', 'openrouter', 'deepseek'];
      if (valid.includes(normalized)) {
        console.log(`\n[CLAWD CODE] Switched provider: ${current} -> ${normalized}`);
        console.log(`Set CLAWD_PROVIDER=${normalized} in ~/.clawd-code/.env to persist.`);
        if (normalized === 'zai') {
          console.log(`Set ZAI_API_KEY=<key> and (optionally) CLAWD_MODEL=${ZAI_DEFAULT_MODEL} (default).`);
        } else if (normalized === 'xai') {
          console.log('Set XAI_API_KEY=<key> and (optionally) CLAWD_MODEL=grok-4.3.');
        } else if (normalized === 'anthropic') {
          console.log('Set ANTHROPIC_API_KEY=<key> and CLAWD_MODEL=claude-sonnet-4-6 (or opus/haiku).');
        } else if (normalized === 'deepseek') {
          console.log('Set DEEPSEEK_API_KEY=<key> and CLAWD_MODEL=deepseek-v4-pro or deepseek-v4-flash.');
        } else if (normalized === 'openrouter') {
          console.log(`Set OPENROUTER_API_KEY=<key> and CLAWD_MODEL=${OPENROUTER_AUTO_MODEL} for Nemo routing, or CLAWD_MODEL=fable5/fable-latest.`);
        }
      } else {
        console.log(`\n[CLAWD CODE] Unknown provider: ${args[1]}`);
        console.log('Available: zai (default), xai, anthropic (claude), openrouter (or), deepseek (ds)');
      }
    } else {
      console.log('\n╔═════════════════════════════════════════════════════════════════════╗');
      console.log('║  CLAWD CODE — AI PROVIDERS                                          ║');
      console.log('╠═════════════════════════════════════════════════════════════════════╣');
      console.log(`║  Current: ${current.padEnd(56)}║`);
      console.log('╠═════════════════════════════════════════════════════════════════════╣');
      console.log('║  zai         Z.AI GLM-5.2 / GLM-5V / GLM-Image ⭐ default        ║');
      console.log('║  xai         xAI Grok 4.x models                                  ║');
      console.log('║  anthropic   Claude Sonnet/Opus/Haiku — streaming native            ║');
      console.log('║  openrouter  Free + paid models via OpenRouter                      ║');
      console.log('║  deepseek    deepseek-v4-pro / v4-flash                             ║');
      console.log('╚═════════════════════════════════════════════════════════════════════╝');
      const zai = getZaiEnvConfig(env);
      console.log(`\n  zai       key=${maskSecret(env.ZAI_API_KEY)}  model=${zai.model}`);
      console.log(`            vision=${zai.visionModel}  image=${zai.imageModel}  thinking=${zai.thinkingType}/${zai.reasoningEffort}`);
      console.log(`  xai        key=${maskSecret(env.XAI_API_KEY)}`);
      console.log(`  anthropic  key=${maskSecret(env.ANTHROPIC_API_KEY)}`);
      console.log(`  deepseek   key=${maskSecret(env.DEEPSEEK_API_KEY)}`);
      const openRouterModels = getOpenRouterProviderModels(env);
      console.log(`  openrouter key=${maskSecret(env.OPENROUTER_API_KEY)}  auto=${OPENROUTER_AUTO_MODEL}`);
      console.log(`    balanced: ${openRouterModels.model1}`);
      console.log(`    smart   : ${openRouterModels.model2}`);
      console.log(`    fast    : ${openRouterModels.model3}`);
      console.log(`    fable5  : ${openRouterModels.fable5}`);
      console.log(`    latest  : ${openRouterModels.latest}`);
      console.log('\n  Switch: clawd-code /provider anthropic');
    }
    process.exit(0);
  }

  // Solana-style slash commands and install-friendly aliases
  const directCommands: Record<string, (a: string[]) => Promise<void>> = {
    '/perps':      C.cmdPerps,
    'perps':       C.cmdPerps,
    '/wallet':     C.cmdWallet,
    'wallet':      C.cmdWallet,
    '/chain':      C.cmdChain,
    'chain':       C.cmdChain,
    '/solana':     C.cmdChain,
    'solana':      C.cmdChain,
    '/chart':      C.cmdChart,
    'chart':       C.cmdChart,
    '/charts':     C.cmdChart,
    'charts':      C.cmdChart,
    '/slides':     C.cmdSlides,
    'slides':      C.cmdSlides,
    '/poster':     C.cmdPoster,
    'poster':      C.cmdPoster,
    '/send':       C.cmdSend,
    'send':        C.cmdSend,
    '/price':      C.cmdPrice,
    'price':       C.cmdPrice,
    '/balance':    C.cmdBalance,
    'balance':     C.cmdBalance,
    '/positions':  C.cmdPositions,
    'positions':   C.cmdPositions,
    '/funding':    C.cmdFunding,
    'funding':     C.cmdFunding,
    '/signals':    C.cmdSignals,
    'signals':     C.cmdSignals,
    '/strategies': C.cmdStrategies,
    'strategies':  C.cmdStrategies,
    '/imperial':   C.cmdImperial,
    'imperial':    C.cmdImperial,
    '/arena':      C.cmdArena,
    'arena':       C.cmdArena,
    '/agents':     C.cmdAgents,
    'agents':      C.cmdAgents,
    '/spinner':    C.cmdSpinner,
    'spinner':     C.cmdSpinner,
    '/spinners':   C.cmdSpinner,
    'spinners':    C.cmdSpinner,
    '/goal':       C.cmdGoal,
    'goal':        C.cmdGoal,
    '/help':       C.cmdHelp,
    'help':        C.cmdHelp,
  };

  if (directCommands[args[0]]) {
    await directCommands[args[0]](args.slice(1));
    process.exit(0);
  }

  // Headless output format
  const formatFlag = args.indexOf('--format');
  const format = formatFlag !== -1 ? args[formatFlag + 1] : 'text';
  if (format === 'json' || format === 'text') {
    process.env.CLAWD_OUTPUT_FORMAT = format;
  }

  const config = loadConfig();
  const modeArg = args[0].toLowerCase();
  if (['code', 'trade', 'research', 'image', 'voice', 'repl'].includes(modeArg)) {
    config.mode = modeArg.toUpperCase() as Mode;
  }

  // Parse global flags
  if (args.includes('--live')) config.liveTrading = true;
  if (args.includes('--paper')) config.liveTrading = false;
  if (args.includes('--stream')) config.stream = true;
  if (args.includes('--thinking')) config.zaiThinking = 'enabled';
  if (args.includes('--no-thinking')) config.zaiThinking = 'disabled';

  if (args.includes('--agents')) {
    const idx = args.indexOf('--agents');
    config.agentCount = parseInt(args[idx + 1], 10) as 4 | 16;
  }
  if (args.includes('--model')) {
    const idx = args.indexOf('--model');
    config.model = args[idx + 1];
  }
  if (args.includes('--provider')) {
    const idx = args.indexOf('--provider');
    config.provider = normalizeProvider(args[idx + 1]);
    if (!args.includes('--model')) {
      config.model = defaultModelForProvider(config.provider);
    }
  }
  if (args.includes('--reasoning-effort')) {
    const idx = args.indexOf('--reasoning-effort');
    config.zaiReasoningEffort = normalizeZaiReasoningEffort(args[idx + 1]);
  }
  if (args.includes('--thinking-mode')) {
    const idx = args.indexOf('--thinking-mode');
    config.zaiThinking = normalizeZaiThinking(args[idx + 1]);
  }

  printBanner();
  const streamLabel = config.stream ? ' | stream: on' : '';
  console.log(`[CLAWD CODE] Mode: ${config.mode} | Provider: ${config.provider} | Model: ${config.model}${streamLabel}\n`);

  try {
    switch (modeArg) {
      case 'code':
        await runCodeMode(args.slice(1), config);
        break;
      case 'trade':
        await runTradeMode(args.slice(1), config);
        break;
      case 'research':
        await runResearchMode(args.slice(1), config);
        break;
      case 'image':
        await runImageMode(args.slice(1), config);
        break;
      case 'voice':
        await runVoiceMode(args.slice(1), config);
        break;
      case 'repl':
        await runReplMode(config);
        break;
      default:
        await runCodeMode(args, config);
    }
  } catch (error) {
    console.error('[CLAWD CODE] Error:', error);
    process.exit(1);
  }
}

main().catch(console.error);
