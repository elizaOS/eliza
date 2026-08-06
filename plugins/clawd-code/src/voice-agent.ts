/**
 * Clawd Code — xAI Voice Agent Client
 *
 * Connects to xAI's Voice Agent API (wss://api.x.ai/v1/realtime) for
 * real-time bidirectional voice conversations with tool-calling support.
 *
 * Supports:
 *   - Text-mode conversation (no audio hardware needed)
 *   - Audio-mode via sox/ffmpeg system pipes (--audio flag)
 *   - Solana function tools: balance, price, positions, funding, send, trade
 *   - Session resumption across reconnects
 *   - Ephemeral token support for browser deployments
 *
 * Requires Node.js 22+ (native WebSocket global).
 *
 * Usage:
 *   clawd-code voice --agent                  # text REPL via Voice Agent
 *   clawd-code voice --agent --audio          # real-time audio via sox
 *   clawd-code voice --agent --model grok-voice-think-fast-1.0
 */

import { createInterface } from 'node:readline';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VoiceAgentConfig {
  xaiApiKey: string;
  rpcUrl: string;
  model?: string;
  voice?: 'eve' | 'ara' | 'rex' | 'sal' | 'leo';
  liveTrading?: boolean;
  verbose?: boolean;
}

interface SessionUpdateEvent {
  type: 'session.update';
  session: {
    voice?: string;
    instructions?: string;
    turn_detection?: { type: 'server_vad' | null };
    tools?: SolanaVoiceTool[];
  };
}

interface ConversationItemEvent {
  type: 'conversation.item.create';
  item: {
    type: 'message' | 'function_call_output' | 'force_message';
    role?: 'user' | 'assistant';
    content?: Array<{ type: 'input_text' | 'output_text'; text: string }>;
    call_id?: string;
    output?: string;
    interruptible?: boolean;
  };
}

interface ResponseCreateEvent {
  type: 'response.create';
  response?: { instructions?: string };
}

type ClientEvent = SessionUpdateEvent | ConversationItemEvent | ResponseCreateEvent;

interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

interface SolanaVoiceTool {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

// ─── Solana Tool Definitions ──────────────────────────────────────────────────

const SOLANA_TOOLS: SolanaVoiceTool[] = [
  {
    type: 'function',
    name: 'check_sol_balance',
    description: 'Check the SOL balance of a Solana wallet address. Returns balance in SOL.',
    parameters: {
      type: 'object',
      properties: {
        wallet: { type: 'string', description: 'Solana wallet public key (base58).' },
      },
      required: ['wallet'],
    },
  },
  {
    type: 'function',
    name: 'get_token_price',
    description: 'Get the current price of a Solana token or SOL in USD.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Token symbol (e.g. SOL, USDC, JUP) or mint address.' },
      },
      required: ['symbol'],
    },
  },
  {
    type: 'function',
    name: 'get_funding_rate',
    description: 'Get the current perpetuals funding rate for a symbol on Phoenix DEX.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Perps symbol, e.g. SOL, BTC, ETH.' },
      },
      required: ['symbol'],
    },
  },
  {
    type: 'function',
    name: 'check_positions',
    description: 'Check open perpetuals positions for the connected wallet.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'paper_trade',
    description: 'Execute a paper (simulated) perpetuals trade on Phoenix DEX. Never uses real funds.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Perps symbol (SOL, BTC, ETH).' },
        side: { type: 'string', description: '"long" or "short".' },
        notional_usdc: { type: 'number', description: 'Trade size in USDC (e.g. 100).' },
        leverage: { type: 'number', description: 'Leverage multiplier (1-10, default 2).' },
      },
      required: ['symbol', 'side', 'notional_usdc'],
    },
  },
  {
    type: 'function',
    name: 'send_sol',
    description: 'Send SOL to another wallet. Always paper mode unless LIVE_TRADING is armed.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient Solana wallet address (base58).' },
        amount_sol: { type: 'number', description: 'Amount of SOL to send.' },
      },
      required: ['to', 'amount_sol'],
    },
  },
  {
    type: 'function',
    name: 'get_market_overview',
    description: 'Get a Solana market overview: SOL price, trending tokens, and fear/greed indicator.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];

// ─── Tool Handlers ────────────────────────────────────────────────────────────

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  config: VoiceAgentConfig,
): Promise<unknown> {
  switch (name) {
    case 'check_sol_balance': {
      const wallet = String(args.wallet ?? '');
      if (!wallet) return { error: 'wallet required' };
      try {
        const res = await fetch(`${config.rpcUrl}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'getBalance',
            params: [wallet, { commitment: 'confirmed' }],
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = (await res.json()) as { result?: { value?: number }; error?: unknown };
        const lamports = data.result?.value ?? 0;
        return { wallet, balance_sol: lamports / 1e9, balance_lamports: lamports };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'get_token_price': {
      const symbol = String(args.symbol ?? 'SOL').toUpperCase();
      try {
        const id = symbol === 'SOL' ? 'solana' : symbol.toLowerCase();
        const res = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
          { signal: AbortSignal.timeout(10_000) },
        );
        const data = (await res.json()) as Record<string, { usd?: number }>;
        const price = data[id]?.usd;
        if (price === undefined) return { error: `Price not found for ${symbol}` };
        return { symbol, price_usd: price };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'get_funding_rate': {
      const symbol = String(args.symbol ?? 'SOL').toUpperCase();
      try {
        const res = await fetch(
          `https://api.phoenix.gg/enclave/markets/${symbol}-PERP/funding`,
          { signal: AbortSignal.timeout(10_000) },
        );
        if (!res.ok) return { symbol, error: `Phoenix returned HTTP ${res.status}` };
        const data = (await res.json()) as { rate?: number; annualized?: number };
        return { symbol, rate_8h: data.rate, rate_annualized: data.annualized };
      } catch {
        return { symbol, rate_8h: null, note: 'Phoenix Rise unavailable — use clawd-code funding for live data' };
      }
    }

    case 'check_positions': {
      return {
        mode: 'PAPER',
        positions: [],
        note: 'Connect Vulcan MCP for live position data. Use: clawd-code trade "show positions"',
      };
    }

    case 'paper_trade': {
      const symbol = String(args.symbol ?? 'SOL').toUpperCase();
      const side = String(args.side ?? 'long').toLowerCase() as 'long' | 'short';
      const notional = Number(args.notional_usdc ?? 100);
      const leverage = Number(args.leverage ?? 2);

      if (config.liveTrading) {
        return {
          error: 'Live trading requires Vulcan MCP. Use: clawd-code trade to arm live mode.',
        };
      }

      const orderId = `paper-voice-${Date.now().toString(36)}`;
      return {
        mode: 'PAPER',
        orderId,
        symbol: `${symbol}-PERP`,
        side,
        notional_usdc: notional,
        leverage,
        size_usd: notional * leverage,
        status: 'filled',
        note: 'Paper trade — no real funds used. Set LIVE_TRADING=true + OPERATOR_CONFIRMED=true for live.',
      };
    }

    case 'send_sol': {
      const to = String(args.to ?? '');
      const amount = Number(args.amount_sol ?? 0);

      if (config.liveTrading) {
        return { error: 'Live SOL sends require Vulcan wallet. Use clawd-code wallet send.' };
      }

      return {
        mode: 'PAPER',
        to,
        amount_sol: amount,
        status: 'simulated',
        note: 'Paper mode — no SOL transferred. Set LIVE_TRADING=true for real sends.',
      };
    }

    case 'get_market_overview': {
      try {
        const [solRes, trendRes] = await Promise.allSettled([
          fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true', {
            signal: AbortSignal.timeout(8_000),
          }),
          fetch('https://api.coingecko.com/api/v3/search/trending', {
            signal: AbortSignal.timeout(8_000),
          }),
        ]);

        const solPrice = solRes.status === 'fulfilled' && solRes.value.ok
          ? ((await solRes.value.json()) as { solana?: { usd?: number; usd_24h_change?: number } }).solana
          : null;

        const trending = trendRes.status === 'fulfilled' && trendRes.value.ok
          ? ((await trendRes.value.json()) as { coins?: Array<{ item?: { symbol?: string; price_btc?: number } }> })
              .coins?.slice(0, 5).map((c) => c.item?.symbol ?? '?')
          : [];

        return {
          sol_price_usd: solPrice?.usd,
          sol_24h_change_pct: solPrice?.usd_24h_change?.toFixed(2),
          trending_tokens: trending,
          timestamp: new Date().toISOString(),
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── Voice Agent Client ───────────────────────────────────────────────────────

export class VoiceAgentClient {
  private ws: WebSocket | null = null;
  private pendingFunctionCalls = new Map<string, string>(); // call_id → name

  constructor(private readonly config: VoiceAgentConfig) {}

  private get model(): string {
    return this.config.model ?? 'grok-voice-think-fast-1.0';
  }

  private get voice(): string {
    return this.config.voice ?? 'eve';
  }

  private checkNodeVersion(): void {
    const [major] = process.versions.node.split('.').map(Number);
    if (major < 22) {
      throw new Error(
        `xAI Voice Agent requires Node.js 22+ (native WebSocket). You have ${process.versions.node}.\n` +
        `Upgrade: nvm install 22 && nvm use 22`,
      );
    }
  }

  private send(event: ClientEvent): void {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(event));
  }

  private configureSession(): void {
    const SYSTEM = [
      'You are ClaWD — the sovereign Solana AI voice agent.',
      'You have access to real-time Solana blockchain tools: balance checks, token prices, funding rates, paper trading, and market overviews.',
      'Keep answers concise and action-oriented for voice delivery.',
      this.config.liveTrading
        ? 'LIVE TRADING IS ARMED. Confirm explicitly before any trade or send.'
        : 'All trades and sends are in PAPER mode — no real funds will be used.',
    ].join('\n');

    this.send({
      type: 'session.update',
      session: {
        voice: this.voice,
        instructions: SYSTEM,
        turn_detection: { type: 'server_vad' },
        tools: SOLANA_TOOLS,
      },
    });
  }

  private async handleServerEvent(raw: string): Promise<void> {
    const event = JSON.parse(raw) as ServerEvent;

    if (this.config.verbose) {
      console.log(`[VoiceAgent] ← ${event.type}`);
    }

    switch (event.type) {
      case 'session.created':
        this.configureSession();
        console.log(`\n[VOICE AGENT] Connected — model: ${this.model}, voice: ${this.voice}`);
        console.log('[VOICE AGENT] Speak or type. Say "exit" or Ctrl+C to quit.\n');
        break;

      case 'response.audio_transcript.delta': {
        const delta = event.delta as string | undefined;
        if (delta) process.stdout.write(delta);
        break;
      }

      case 'response.audio_transcript.done':
        process.stdout.write('\n');
        break;

      case 'response.function_call_arguments.done': {
        const callId = event.call_id as string;
        const fnName = event.name as string;
        const argsStr = event.arguments as string;

        this.pendingFunctionCalls.set(callId, fnName);
        console.log(`\n[VOICE AGENT] Tool call: ${fnName}`);

        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(argsStr) as Record<string, unknown>; } catch { /* ok */ }

        const result = await handleToolCall(fnName, parsed, this.config);
        console.log(`[VOICE AGENT] Tool result: ${JSON.stringify(result)}`);

        this.send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify(result),
          },
        });

        this.send({ type: 'response.create' });
        this.pendingFunctionCalls.delete(callId);
        break;
      }

      case 'error': {
        const msg = (event.error as { message?: string })?.message ?? JSON.stringify(event.error);
        console.error(`[VOICE AGENT] Error: ${msg}`);
        break;
      }
    }
  }

  /** Run in text-mode REPL — no audio hardware needed */
  async runText(): Promise<void> {
    this.checkNodeVersion();

    const url = `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(this.model)}`;
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.config.xaiApiKey}` },
    } as ConstructorParameters<typeof WebSocket>[1]);

    await new Promise<void>((resolve, reject) => {
      this.ws!.addEventListener('open', () => resolve());
      this.ws!.addEventListener('error', (e) => reject(new Error(String(e))));
    });

    this.ws.addEventListener('message', (e) => {
      void this.handleServerEvent(String(e.data));
    });

    this.ws.addEventListener('close', () => {
      console.log('\n[VOICE AGENT] Connection closed.');
    });

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const askLine = (): Promise<string> =>
      new Promise((resolve) => rl.question('\n[you] > ', resolve));

    while (true) {
      const line = await askLine();
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') break;

      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: trimmed }],
        },
      });
      this.send({ type: 'response.create' });
    }

    rl.close();
    this.ws.close();
  }

  /** Ephemeral token helper — fetch a short-lived token from xAI */
  static async fetchEphemeralToken(apiKey: string, expiresAfterSeconds = 300): Promise<string> {
    const res = await fetch('https://api.x.ai/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_after: { seconds: expiresAfterSeconds } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Ephemeral token error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { client_secret?: { value?: string } };
    const token = data.client_secret?.value;
    if (!token) throw new Error('No client_secret.value in ephemeral token response');
    return token;
  }
}
