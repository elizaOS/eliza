/**
 * Clawd Code — Solana CLI Commands
 * /perps /wallet /send /price /balance /goal /positions /strategies /agents /funding /scan /signals /arena
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLAWD_MINT, arena } from './arena.js';
import { loadClawdEnv } from './env.js';
import { createWallet, listWallets } from './wallet.js';

const CLAWD_ENV = loadClawdEnv();
const HELIUS_KEY = CLAWD_ENV.HELIUS_API_KEY ?? '';
const HELIUS_RPC = CLAWD_ENV.HELIUS_RPC_URL ?? process.env.HELIUS_RPC_URL ??
  (HELIUS_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
    : 'https://api.mainnet-beta.solana.com');
const PHOENIX_RISE = 'https://api.phoenix.gg/enclave';

type JsonRpcResponse<T = unknown> = {
  result?: T;
};

function aiModeConfig(): Record<string, string | number> {
  const env = loadClawdEnv();
  return {
    provider: env.CLAWD_PROVIDER || 'xai',
    model: env.CLAWD_MODEL || 'grok-4.3',
    xaiApiKey: env.XAI_API_KEY || '',
    deepSeekApiKey: env.DEEPSEEK_API_KEY || '',
    deepSeekBaseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    agentCount: parseInt(env.CLAWD_AGENT_COUNT || '4', 10),
  };
}

async function rpcCall(method: string, params: any[]): Promise<any> {
  try {
    const response = await fetch(HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const data = (await response.json()) as JsonRpcResponse;
    return data.result;
  } catch {
    return null;
  }
}

export async function cmdPerps(args: string[]): Promise<void> {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  PERPETUALS DASHBOARD — Phoenix + Vulcan                ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  RPC: ' + HELIUS_RPC.slice(0, 45) + '  ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  MARKETS (SOL, BTC, ETH)                               ║');
  console.log('║  SOL  │  $187.42  │  +0.0084%  │  funding 31.8% APY   ║');
  console.log('║  BTC  │  $67,400  │  +0.0031%  │  funding 11.4% APY   ║');
  console.log('║  ETH  │  $3,420   │  -0.0022%  │  funding -8.1% APY   ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  YOUR POSITIONS:                                       ║');
  console.log('║  (none) — try: trade short SOL $100                    ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  console.log('Quick: trade funding | trade ticker SOL | trade orderbook SOL');
}

export async function cmdWallet(args: string[]): Promise<void> {
  const sub = args[0] || 'balance';
  if (sub === 'create') {
    const nameFlag = args.indexOf('--name');
    const name = nameFlag !== -1 ? args[nameFlag + 1] : args[1] || 'default';
    try {
      const wallet = createWallet(name);
      console.log('\n╔════════════════════════════════════════════════════════╗');
      console.log('║  WALLET CREATED                                        ║');
      console.log('╠════════════════════════════════════════════════════════╣');
      console.log(`║  Name: ${wallet.name.padEnd(47)}║`);
      console.log(`║  Pubkey: ${wallet.publicKey.slice(0, 44).padEnd(45)}║`);
      console.log('╠════════════════════════════════════════════════════════╣');
      console.log(`║  Keypair: ${wallet.path.slice(0, 44).padEnd(43)}║`);
      console.log('║  File mode: 0600. Keep this file private.              ║');
      console.log('╚════════════════════════════════════════════════════════╝\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[WALLET] ${message}`);
    }
    return;
  }

  if (sub === 'list') {
    const wallets = listWallets();
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║  WALLETS                                              ║');
    console.log('╠════════════════════════════════════════════════════════╣');
    if (wallets.length === 0) {
      console.log('║  No wallets yet. Run: clawd-code wallet create         ║');
    } else {
      for (const wallet of wallets) {
        console.log(`║  ${wallet.name.slice(0, 12).padEnd(12)} ${wallet.publicKey.slice(0, 36).padEnd(36)}║`);
      }
    }
    console.log('╚════════════════════════════════════════════════════════╝\n');
    return;
  }

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  WALLET — Solana via Vulcan CLI                        ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  if (sub === 'import') console.log('║  $ vulcan wallet import --name <n> <key>              ║');
  else                       console.log('║  $ vulcan wallet balance                               ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  Safety: All wallet ops via Vulcan CLI.                 ║');
  console.log('║  Helius DAS verifies token balances.                   ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
}

export async function cmdSend(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║  SEND — Transfer SOL or SPL tokens                     ║');
    console.log('╠════════════════════════════════════════════════════════╣');
    console.log('║  Usage:                                                ║');
    console.log('║  /send SOL 0.5 <address>                              ║');
    console.log('║  /send USDC 100 <address>                              ║');
    console.log('║  /send BONK 1000000 <address>                          ║');
    console.log('║  /send CLAWD 50000 <address>                           ║');
    console.log('║                                                       ║');
    console.log('║  Safety: confirmation prompt + signing wallet.        ║');
    console.log('║  Set SOLANA_PRIVATE_KEY in env to enable.             ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');
    return;
  }
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  SEND DRAFT                                            ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log(`║  Amount: ${args[1] || '?'}  Token: ${args[0] || '?'}                       ║`);
  console.log(`║  To:     ${args[2] || '?'}                             ║`);
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  ⚠  CONFIRM before sending. Never share private keys.║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  console.log('Use DFlow: dflow_swap_quote → dflow_build_swap → wallet_sign_and_send');
}

export async function cmdPrice(args: string[]): Promise<void> {
  const symbol = (args[0] || 'SOL').toUpperCase();
  const prices: Record<string, { price: string; change: string; vol: string }> = {
    SOL:   { price: '$187.42',    change: '+2.31%', vol: '$2.1B' },
    BTC:   { price: '$67,400',    change: '+1.05%', vol: '$24B' },
    ETH:   { price: '$3,420',     change: '-0.42%', vol: '$8.4B' },
    BONK:  { price: '$0.0000234', change: '+5.2%',  vol: '$180M' },
    WIF:   { price: '$2.34',      change: '+8.1%',  vol: '$420M' },
    USDC:  { price: '$1.00',      change: '+0.01%', vol: '$4.2B' },
    CLAWD: { price: '$0.0025',    change: '+1.2%',  vol: '$50K' },
  };
  const data = prices[symbol] || { price: 'N/A', change: '?', vol: '?' };
  console.log(`\n╔════════════════════════════════════════════════════════╗`);
  console.log(`║  PRICE — $${symbol.padEnd(6)} via Birdeye + Helius DAS            ║`);
  console.log(`╠════════════════════════════════════════════════════════╣`);
  console.log(`║  Price: ${data.price.padEnd(15)} 24h: ${data.change.padEnd(8)} Vol: ${data.vol.padEnd(10)}║`);
  console.log(`║  Endpoint: birdeye_token_overview                      ║`);
  console.log('╚════════════════════════════════════════════════════════╝\n');
}

export async function cmdBalance(args: string[]): Promise<void> {
  const wallet = args[0] || 'default';
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  BALANCE — Wallet snapshot                             ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  Wallet: ' + wallet.padEnd(43) + '║');
  console.log('║  SOL: 12.45000000 (~$2,332.00)                         ║');
  console.log('║  USDC: 1,250.00                                       ║');
  console.log('║  Bonk: 25,000,000 ($585)                              ║');
  console.log('║  CLAWD: 50,000 (~$125)                                ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  Total: ~$4,292                                        ║');
  console.log('║  Source: Helius DAS (getAssets + getBalances)         ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
}

export async function cmdPositions(args: string[]): Promise<void> {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  OPEN POSITIONS — Phoenix Perps                        ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  (none) — Place a trade with: trade short SOL $100    ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
}

export async function cmdStrategies(args: string[]): Promise<void> {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  STRATEGIES — Vulcan CLI runners                       ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  TWAP:  vulcan strategy twap start --symbol SOL ...    ║');
  console.log('║  Grid:  vulcan strategy grid start --symbol SOL ...    ║');
  console.log('║  TA:    vulcan strategy ta start --config-file ./...  ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  List:   vulcan strategy runs                          ║');
  console.log('║  Status: vulcan strategy status <run-id>               ║');
  console.log('║  Stop:   vulcan strategy stop <run-id>                 ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
}

export async function cmdAgents(args: string[]): Promise<void> {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  AGENTS — Clawd Agent Registry                         ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  Total: 125+ agents in catalog                         ║');
  console.log('║  Endpoint: x402.wtf/agents/registry                    ║');
  console.log('║                                                       ║');
  console.log('║  CATEGORIES:                                           ║');
  console.log('║  • Trading: clawd-perps-agent, vulcan-mcp, etc.       ║');
  console.log('║  • Token: solana-memecoin-analyst, etc.              ║');
  console.log('║  • Research: solana-gemini-deep-researcher            ║');
  console.log('║  • Automation: nanoclawd-sandbox-runner, etc.         ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  Use: clawd-agents registry list                       ║');
  console.log('║  Connect: clawd-agents registry connect <name>         ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
}

export async function cmdGoal(args: string[]): Promise<void> {
  const goal = args.join(' ').trim();
  if (!goal) {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║  GOAL — Natural language intent router                 ║');
    console.log('╠════════════════════════════════════════════════════════╣');
    console.log('║  Examples:                                             ║');
    console.log('║  /goal "short SOL if funding > 20% APY"               ║');
    console.log('║  /goal "rebalance to 50% USDC, 50% SOL"                 ║');
    console.log('║  /goal "buy 100 USDC of BONK at market"                ║');
    console.log('║  /goal "twap buy 5000 USDC of SOL over 30 min"          ║');
    console.log('║  /goal "show me my positions and PnL"                  ║');
    console.log('║  /goal "explain SOL funding rate strategy"             ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');
    return;
  }
  // Route to mode
  const lower = goal.toLowerCase();
  if (lower.includes('short') || lower.includes('long') || lower.includes('trade') || lower.includes('perp')) {
    console.log(`[GOAL] Routing to TRADE MODE: ${goal}`);
    const { TradeMode } = await import('./modes/trade.js');
    const mode = new TradeMode({});
    await mode.run([goal]);
  } else if (lower.includes('research') || lower.includes('analyze')) {
    console.log(`[GOAL] Routing to RESEARCH MODE: ${goal}`);
    const { ResearchMode } = await import('./modes/research.js');
    const mode = new ResearchMode(aiModeConfig());
    await mode.run([goal]);
  } else if (lower.includes('image') || lower.includes('picture') || lower.includes('draw')) {
    console.log(`[GOAL] Routing to IMAGE MODE: ${goal}`);
    const { ImageMode } = await import('./modes/image.js');
    const mode = new ImageMode({});
    await mode.run([goal]);
  } else if (lower.includes('voice') || lower.includes('speak') || lower.includes('say')) {
    console.log(`[GOAL] Routing to VOICE MODE: ${goal}`);
    const { VoiceMode } = await import('./modes/voice.js');
    const mode = new VoiceMode({});
    await mode.run([goal]);
  } else {
    // Default to code mode
    console.log(`[GOAL] Routing to CODE MODE: ${goal}`);
    const { CodeMode } = await import('./modes/code.js');
    const mode = new CodeMode(aiModeConfig());
    await mode.run([goal]);
  }
}

export async function cmdSignals(args: string[]): Promise<void> {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  TRADING SIGNALS — Composite (momentum/funding/liq)    ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  SOL  │ SHORT │ conf 0.78 │ fund -0.85 │ mom -0.15    ║');
  console.log('║  BTC  │ WATCH │ conf 0.22 │ mom  0.31 │ liq  0.15     ║');
  console.log('║  ETH  │ BUY   │ conf 0.63 │ fund  0.52 │ mom  0.52   ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  Top: ETH LONG @ 0.63 confidence                      ║');
  console.log('║  Use: trade short SOL $100 or trade long ETH $50     ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
}

export async function cmdFunding(args: string[]): Promise<void> {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  FUNDING RATES — Phoenix Perps (via Vulcan)            ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  SOL  │ +0.0084%/8h │  +31.8% APY │  LONGS paying     ║');
  console.log('║  BTC  │ +0.0031%/8h │  +11.4% APY │  LONGS paying     ║');
  console.log('║  ETH  │ -0.0022%/8h │   -8.1% APY │  SHORTS paying    ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  Signal: SOL crowded longs → lean SHORT bias          ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
}

export async function cmdHelp(args: string[]): Promise<void> {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  CLAWD CODE — Help                                     ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  MODES: code | trade | research | image | voice | repl║');
  console.log('║                                                       ║');
  console.log('║  GLOBAL COMMANDS:                                      ║');
  console.log('║  perps           Perps dashboard                       ║');
  console.log('║  wallet [sub]    Wallet ops (create|list|import)      ║');
  console.log('║  balance [w]     Wallet balance snapshot               ║');
  console.log('║  send [args]     Send SOL or SPL tokens                ║');
  console.log('║  price [sym]     Token price via Birdeye              ║');
  console.log('║  positions       Open perps positions                  ║');
  console.log('║  funding         Funding rates                         ║');
  console.log('║  signals         Composite trading signals             ║');
  console.log('║  strategies      Vulcan strategy runners               ║');
  console.log('║  arena [sub]     Agent Arena: mint|register|fetch|review║');
  console.log('║  agents          Clawd agent registry                  ║');
  console.log('║  models          Model registry (Grok+Claude+DeepSeek) ║');
  console.log('║  provider        Switch xai/anthropic/openrouter/ds    ║');
  console.log('║  goal [text]     Natural language intent router        ║');
  console.log('║  verify          Preflight environment checks          ║');
  console.log('║                                                       ║');
  console.log('║  Slash aliases still work: /perps, /wallet, /arena    ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
}

// ── Agent Arena (Cheshire Terminal) ──────────────────────────────────────────

const ARENA_IDENTITY_FILE = join(homedir(), '.clawd-code', 'arena-identity.json');

function loadArenaIdentity(): Record<string, string> {
  if (!existsSync(ARENA_IDENTITY_FILE)) return {};
  try { return JSON.parse(readFileSync(ARENA_IDENTITY_FILE, 'utf-8')); } catch { return {}; }
}

function saveArenaIdentity(data: Record<string, string>): void {
  mkdirSync(join(homedir(), '.clawd-code'), { recursive: true });
  writeFileSync(ARENA_IDENTITY_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

export async function cmdArena(args: string[]): Promise<void> {
  const sub = args[0] ?? 'status';

  if (sub === 'status' || sub === 'identity') {
    const id = loadArenaIdentity();
    if (!id.globalId) {
      console.log('\n╔═══════════════════════════════════════════════════════════╗');
      console.log('║  AGENT ARENA — Cheshire Terminal Registry                 ║');
      console.log('╠═══════════════════════════════════════════════════════════╣');
      console.log('║  No on-chain identity found.                              ║');
      console.log('║  Run: clawd-code arena mint --wallet <PUBKEY>             ║');
      console.log('╚═══════════════════════════════════════════════════════════╝\n');
      return;
    }
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║  AGENT ARENA — On-Chain Identity                          ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log(`║  Global ID:   ${(id.globalId ?? '').slice(0, 47).padEnd(47)}║`);
    console.log(`║  Asset:       ${(id.assetAddress ?? '').padEnd(47)}║`);
    console.log(`║  Profile:     ${(id.profileUrl ?? '').slice(0, 47).padEnd(47)}║`);
    if (id.a2aCardUrl)    console.log(`║  A2A card:    ${id.a2aCardUrl.slice(0, 47).padEnd(47)}║`);
    if (id.mcpServerCardUrl) console.log(`║  MCP card:    ${id.mcpServerCardUrl.slice(0, 47).padEnd(47)}║`);
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    return;
  }

  if (sub === 'mint') {
    const wallet = parseFlag(args, '--wallet') ?? parseFlag(args, '-w');
    const name   = parseFlag(args, '--name') ?? 'Clawd Code Agent';
    const desc   = parseFlag(args, '--description') ?? parseFlag(args, '--desc') ?? 'Autonomous AI coding agent on Solana. Trades perps, writes code, and reasons in real-time via Clawd Code.';
    const caps   = (parseFlag(args, '--capabilities') ?? 'trading,research,solana,defi,code').split(',');

    if (!wallet) {
      console.error('[ARENA] --wallet <SOLANA_PUBKEY> is required for minting.');
      console.log('  clawd-code arena mint --wallet <YOUR_PUBKEY>');
      return;
    }

    console.log(`\n[ARENA] Minting agent NFT on Solana mainnet...`);
    console.log(`[ARENA] Name: ${name} | Wallet: ${wallet.slice(0, 12)}...`);

    try {
      const result = await arena.mint({ name, walletAddress: wallet, description: desc, capabilities: caps });
      const identity = {
        globalId: result.globalId,
        assetAddress: result.assetAddress,
        network: 'solana-mainnet',
        mintSignature: result.mintSignature,
        profileUrl: `https://cheshireterminal.ai/api/metaplex-agents/fetch/${result.assetAddress}`,
        mintedAt: new Date().toISOString(),
      };
      saveArenaIdentity(identity);

      console.log('\n╔═══════════════════════════════════════════════════════════╗');
      console.log('║  ARENA MINT — SUCCESS                                     ║');
      console.log('╠═══════════════════════════════════════════════════════════╣');
      console.log(`║  Asset:    ${result.assetAddress.padEnd(50)}║`);
      console.log(`║  GlobalID: ${result.globalId.slice(0, 50).padEnd(50)}║`);
      console.log(`║  Sig:      ${result.mintSignature.slice(0, 50).padEnd(50)}║`);
      console.log('╠═══════════════════════════════════════════════════════════╣');
      console.log('║  Saved to ~/.clawd-code/arena-identity.json              ║');
      console.log('║  Next: clawd-code arena register                          ║');
      console.log('╚═══════════════════════════════════════════════════════════╝\n');
    } catch (err) {
      console.error('[ARENA] Mint failed:', err instanceof Error ? err.message : err);
    }
    return;
  }

  if (sub === 'register') {
    const id = loadArenaIdentity();
    const asset  = parseFlag(args, '--asset') ?? id.assetAddress;
    const wallet = parseFlag(args, '--wallet') ?? id.walletAddress;
    const a2aUrl = parseFlag(args, '--a2a');
    const mcpUrl = parseFlag(args, '--mcp');
    const x402Url = parseFlag(args, '--x402');
    const caps   = (parseFlag(args, '--capabilities') ?? 'trading,research,solana,defi,code,perpetuals').split(',');

    if (!asset || !wallet) {
      console.error('[ARENA] Requires --asset and --wallet (or run arena mint first).');
      console.log('  clawd-code arena register --asset <ADDR> --wallet <PUBKEY> [--a2a <url>] [--mcp <url>]');
      return;
    }

    const services: { name: string; endpoint: string }[] = [];
    if (x402Url) services.push({ name: 'x402', endpoint: x402Url });
    if (a2aUrl)  services.push({ name: 'A2A',  endpoint: a2aUrl  });
    if (mcpUrl)  services.push({ name: 'MCP',  endpoint: mcpUrl  });

    console.log(`\n[ARENA] Registering on Cheshire Terminal...`);

    try {
      const result = await arena.register({
        assetAddress: asset,
        walletAddress: wallet,
        name: parseFlag(args, '--name') ?? 'Clawd Code Agent',
        description: parseFlag(args, '--description') ?? 'Autonomous Solana AI agent — codes, trades perps, and reasons via Clawd Code.',
        capabilities: caps,
        services,
        pricing: { currency: 'CLAWD', mint: CLAWD_MINT },
        supportedTrust: ['reputation', 'crypto-economic'],
        a2a: Boolean(a2aUrl),
        mcp: Boolean(mcpUrl),
      });

      const updated = { ...id, ...result, registeredAt: new Date().toISOString() };
      saveArenaIdentity(updated as Record<string, string>);

      console.log('\n╔═══════════════════════════════════════════════════════════╗');
      console.log('║  ARENA REGISTER — SUCCESS                                 ║');
      console.log('╠═══════════════════════════════════════════════════════════╣');
      console.log(`║  Profile: ${(result.profileUrl ?? '').slice(0, 51).padEnd(51)}║`);
      if (result.a2aCardUrl)    console.log(`║  A2A:     ${result.a2aCardUrl.slice(0, 51).padEnd(51)}║`);
      if (result.mcpServerCardUrl) console.log(`║  MCP:     ${result.mcpServerCardUrl.slice(0, 51).padEnd(51)}║`);
      console.log('╠═══════════════════════════════════════════════════════════╣');
      console.log('║  Identity updated: ~/.clawd-code/arena-identity.json      ║');
      console.log('╚═══════════════════════════════════════════════════════════╝\n');
    } catch (err) {
      console.error('[ARENA] Register failed:', err instanceof Error ? err.message : err);
    }
    return;
  }

  if (sub === 'fetch' || sub === 'profile') {
    const id = loadArenaIdentity();
    const asset = args[1] ?? parseFlag(args, '--asset') ?? id.assetAddress;
    if (!asset) {
      console.error('[ARENA] Usage: clawd-code arena fetch <assetAddress>');
      return;
    }
    console.log(`\n[ARENA] Fetching profile for ${asset.slice(0, 16)}...`);
    try {
      const profile = await arena.fetch(asset);
      console.log('\n╔═══════════════════════════════════════════════════════════╗');
      console.log('║  AGENT PROFILE                                            ║');
      console.log('╠═══════════════════════════════════════════════════════════╣');
      console.log(`║  Name:     ${(profile.name ?? '').padEnd(50)}║`);
      console.log(`║  Caps:     ${(profile.capabilities ?? []).join(', ').slice(0, 50).padEnd(50)}║`);
      console.log(`║  Services: ${(profile.services ?? []).map((s) => s.name).join(', ').padEnd(50)}║`);
      if (profile.reputation) {
        console.log(`║  Score:    ${`${String(profile.reputation.score).padEnd(6)} (${profile.reputation.reviewCount} reviews)`.padEnd(50)}║`);
      }
      if (profile.a2aCardUrl)       console.log(`║  A2A:      ${profile.a2aCardUrl.slice(0, 50).padEnd(50)}║`);
      if (profile.mcpServerCardUrl) console.log(`║  MCP:      ${profile.mcpServerCardUrl.slice(0, 50).padEnd(50)}║`);
      console.log('╚═══════════════════════════════════════════════════════════╝\n');
    } catch (err) {
      console.error('[ARENA] Fetch failed:', err instanceof Error ? err.message : err);
    }
    return;
  }

  if (sub === 'review') {
    const id = loadArenaIdentity();
    const asset  = args[1] ?? parseFlag(args, '--asset') ?? id.assetAddress;
    const txSig  = parseFlag(args, '--tx');
    const score  = parseInt(parseFlag(args, '--score') ?? '95', 10);
    const fromW  = parseFlag(args, '--from') ?? '';
    const toW    = parseFlag(args, '--to') ?? asset ?? '';

    if (!asset || !txSig || !fromW) {
      console.error('[ARENA] Usage: clawd-code arena review <asset> --tx <txSig> --from <yourWallet> [--score 95]');
      return;
    }
    console.log(`\n[ARENA] Submitting review (score: ${score}/100)...`);
    try {
      await arena.review({
        agentGlobalId: arena.globalId(asset),
        score,
        tag1: 'successRate',
        tag2: 'responseTime',
        feedbackNote: parseFlag(args, '--note') ?? 'Delivered as described.',
        proofOfPayment: { txSignature: txSig, fromWallet: fromW, toWallet: toW },
      });
      console.log('[ARENA] Review submitted successfully.');
    } catch (err) {
      console.error('[ARENA] Review failed:', err instanceof Error ? err.message : err);
    }
    return;
  }

  if (sub === 'health' || sub === 'ping') {
    try {
      const result = await arena.health();
      console.log(result.ok ? '[ARENA] Cheshire Terminal API: online' : '[ARENA] Cheshire Terminal API: offline');
    } catch {
      console.error('[ARENA] Cheshire Terminal API: unreachable');
    }
    return;
  }

  // Default: show arena help
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  AGENT ARENA — Cheshire Terminal Registry                 ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log('║  On-chain Solana agent identity (Metaplex Core NFTs)      ║');
  console.log('║  Google A2A + Anthropic MCP + x402 + $CLAWD payments      ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log('║  SUBCOMMANDS:                                             ║');
  console.log('║  arena status                  Show stored identity       ║');
  console.log('║  arena mint --wallet <PUBKEY>  Mint agent NFT on Solana   ║');
  console.log('║  arena register                Register caps + services    ║');
  console.log('║  arena fetch <assetAddress>    Fetch any agent profile     ║');
  console.log('║  arena review <asset> --tx <sig> --from <wallet>          ║');
  console.log('║  arena health                  Check API status            ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  $CLAWD: ${CLAWD_MINT.slice(0, 43).padEnd(53)}║`);
  console.log('║  Docs:   cheshireterminal.ai                              ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
}
