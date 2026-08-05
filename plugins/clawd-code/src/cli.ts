#!/usr/bin/env node
/**
 * Clawd Code — CLI Entry Point
 * Headless lobster-native AI coding agent for the Clawd ecosystem
 */

import * as C from './commands.js';
import { loadClawdEnv, maskSecret } from './env.js';
import { normalizeModelId, printModelsTable } from './grok-models.js';
import { DEFAULT_FREE_MODEL } from './openrouter.js';
import { EnvironmentVerifier } from './verify.js';

type Mode = 'CODE' | 'TRADE' | 'RESEARCH' | 'IMAGE' | 'VOICE' | 'REPL';

interface ClawdCodeConfig {
  mode: Mode;
  provider: 'xai' | 'openrouter' | 'deepseek' | 'anthropic';
  liveTrading: boolean;
  operatorConfirmed: boolean;
  rpcUrl: string;
  xaiApiKey: string;
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
  const provider = normalizeProvider(env.CLAWD_PROVIDER || process.env.CLAWD_PROVIDER || 'xai');
  return {
    mode: (env.CLAWD_MODE as Mode) || 'CODE',
    provider,
    liveTrading: env.LIVE_TRADING === 'true',
    operatorConfirmed: env.OPERATOR_CONFIRMED === 'true',
    rpcUrl: env.SOLANA_RPC_URL || env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || DEFAULT_HELIUS_RPC,
    xaiApiKey: env.XAI_API_KEY || process.env.XAI_API_KEY || '',
    anthropicApiKey: env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '',
    deepSeekApiKey: env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || '',
    deepSeekBaseUrl: env.DEEPSEEK_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    heliusApiKey: env.HELIUS_API_KEY || process.env.HELIUS_API_KEY || '',
    phoenixRiseUrl: env.PHOENIX_RISE_URL || 'https://api.phoenix.gg/enclave',
    vulcanMcpUrl: env.VULCAN_MCP_URL || 'http://localhost:3001',
    agentCount: parseInt(env.CLAWD_AGENT_COUNT || '4', 10) as 4 | 16,
    model: env.CLAWD_MODEL || 'grok-4.20-multi-agent',
    stream: env.CLAWD_STREAM === 'true',
  };
}

function normalizeProvider(provider: string): 'xai' | 'openrouter' | 'deepseek' | 'anthropic' {
  const normalized = provider.toLowerCase();
  if (normalized === 'or') return 'openrouter';
  if (normalized === 'ds') return 'deepseek';
  if (normalized === 'claude' || normalized === 'ant') return 'anthropic';
  if (normalized === 'anthropic' || normalized === 'deepseek' || normalized === 'openrouter' || normalized === 'xai') return normalized;
  return 'xai';
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
║  xAI · Anthropic · DeepSeek · Solana · Phoenix · Vulcan  ║
╚═══════════════════════════════════════════════════════════╝
`);
}

function printUsage(): void {
  printBanner();
  console.log(`
USAGE:
  clawd-code [mode] [command] [options]

MODES:
  code       Write, review, and ship production code (streaming)
  trade      Perpetuals trading with Phoenix Rise + Vulcan MCP
  research   Multi-agent deep research with grok-4.20-multi-agent
  image      Generate images via DALL-E or Gemini
  voice      Text-to-speech and voice synthesis
  repl       Interactive multi-turn conversation REPL

GLOBAL COMMANDS:
  /verify                 Run preflight checks
  /models                 List all available models (Grok + Claude + DeepSeek)
  /models <id>            Switch to a specific model
  /provider               Show current AI provider + API key status
  /provider <name>        Switch provider: xai | anthropic | openrouter | deepseek

COMMANDS:
  clawd-code code "Build a Jupiter swap bot"
  clawd-code trade "SOL funding rate?"
  clawd-code research "AI agent frameworks 2025"
  clawd-code image "cyberpunk Solana trading desk"
  clawd-code voice "Hello from Clawd Code"
  clawd-code repl

OPTIONS:
  --mode <mode>          Set mode (code|trade|research|image|voice|repl)
  --agents <n>           Number of agents for research (4|16)
  --live                 Enable live trading (requires ARM flags)
  --paper                Paper trading mode (default)
  --model <model>        Override model (grok-4.3 | claude-sonnet-4-6 | ...)
  --provider <name>      Override provider for this session
  --stream               Stream output token-by-token (code + research modes)
  --format <fmt>         Output format: text (default) | json (JSONL)

EXAMPLES:
  clawd-code trade "short SOL $100"
  clawd-code research --agents 16 "Solana perps funding arb"
  clawd-code code --stream --model claude-sonnet-4-6 "Build an Anchor staking program"
  clawd-code code --provider anthropic "Review this TypeScript for bugs"
  clawd-code repl

ENVIRONMENT:
  SOLANA_RPC_URL         Solana RPC endpoint (default: Helius)
  XAI_API_KEY            xAI API key for Grok models
  ANTHROPIC_API_KEY      Anthropic API key for Claude models
  DEEPSEEK_API_KEY       DeepSeek API key for deepseek-v4-pro/flash
  DEEPSEEK_BASE_URL      Default: https://api.deepseek.com
  OPENROUTER_API_KEY     OpenRouter API key (free models supported)
  OPENROUTER_FREE_MODEL  Default: nex-agi/nex-n2-pro:free
  CLAWD_PROVIDER         xai (default) | anthropic | openrouter | deepseek
  CLAWD_STREAM           true to enable streaming by default
  HELIUS_API_KEY         Helius API key for DAS
  PHOENIX_RISE_URL       Phoenix Rise endpoint
  VULCAN_MCP_URL         Vulcan MCP server URL
  LIVE_TRADING           Enable live trading (true|false)
  OPERATOR_CONFIRMED     Operator confirmed (true|false)
  CLAWD_MODE             Default mode (code|trade|research|image|voice|repl)
  CLAWD_AGENT_COUNT      Agent count for research (4|16)

First run: cp .env.example ~/.clawd-code/.env
`);
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

  // /verify command
  if (args[0] === '/verify' || args[0] === 'verify') {
    EnvironmentVerifier.loadEnvFile();
    const verifier = new EnvironmentVerifier();
    const results = verifier.verifyAll();
    const report = verifier.printReport(results);
    process.exit(report.ok ? 0 : 1);
  }

  // /provider command — switch between xai and openrouter
  if (args[0] === '/provider' || args[0] === 'provider') {
    const env = loadClawdEnv();
    const current = normalizeProvider(env.CLAWD_PROVIDER || 'xai');
    if (args[1]) {
      const normalized = normalizeProvider(args[1]);
      const valid = ['xai', 'anthropic', 'openrouter', 'deepseek'];
      if (valid.includes(normalized)) {
        console.log(`\n[CLAWD CODE] Switched provider: ${current} -> ${normalized}`);
        console.log(`Set CLAWD_PROVIDER=${normalized} in ~/.clawd-code/.env to persist.`);
        if (normalized === 'anthropic') {
          console.log('Set ANTHROPIC_API_KEY=<key> and CLAWD_MODEL=claude-sonnet-4-6 (or opus/haiku).');
        } else if (normalized === 'deepseek') {
          console.log('Set DEEPSEEK_API_KEY=<key> and CLAWD_MODEL=deepseek-v4-pro or deepseek-v4-flash.');
        }
      } else {
        console.log(`\n[CLAWD CODE] Unknown provider: ${args[1]}`);
        console.log('Available: xai, anthropic (claude), openrouter (or), deepseek (ds)');
      }
    } else {
      console.log('\n╔═════════════════════════════════════════════════════════════╗');
      console.log('║  CLAWD CODE — AI PROVIDERS                                  ║');
      console.log('╠═════════════════════════════════════════════════════════════╣');
      console.log(`║  Current: ${current.padEnd(50)}║`);
      console.log('╠═════════════════════════════════════════════════════════════╣');
      console.log('║  xai         xAI Grok 4.x models (default)                 ║');
      console.log('║  anthropic   Claude Sonnet/Opus/Haiku — streaming native    ║');
      console.log('║  openrouter  Free + paid models via OpenRouter              ║');
      console.log('║  deepseek    deepseek-v4-pro / v4-flash                     ║');
      console.log('╚═════════════════════════════════════════════════════════════╝');
      console.log(`\n  xai        key=${maskSecret(env.XAI_API_KEY)}`);
      console.log(`  anthropic  key=${maskSecret(env.ANTHROPIC_API_KEY)}`);
      console.log(`  deepseek   key=${maskSecret(env.DEEPSEEK_API_KEY)}`);
      console.log(`  openrouter key=${maskSecret(env.OPENROUTER_API_KEY)}  free model: ${DEFAULT_FREE_MODEL}`);
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
    '/arena':      C.cmdArena,
    'arena':       C.cmdArena,
    '/agents':     C.cmdAgents,
    'agents':      C.cmdAgents,
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
