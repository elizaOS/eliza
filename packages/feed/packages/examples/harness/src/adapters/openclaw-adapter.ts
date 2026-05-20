/**
 * OpenClaw Agent Adapter
 *
 * Bridges the OpenClaw personal AI assistant (https://openclaw.ai) into the
 * harness `TrainableAgent` interface. OpenClaw exposes an HTTP gateway API;
 * this adapter either connects to a running gateway or spawns one.
 *
 * Status: provisional — the OpenClaw integration path for ScamBench is
 * still in planning. This adapter covers the basic `openclaw agent --message`
 * CLI path (no daemon required) and the gateway REST path.
 *
 * Requires:
 *   - OpenClaw installed globally or available at `external-sources/openclaw`
 *     (run `bun run agent-frameworks:bootstrap` to set up the local copy).
 *   - LLM provider API key configured in OpenClaw's config or via env.
 *
 * @example
 * ```typescript
 * import { createOpenClawAdapter } from '@babylon/agent-harness';
 *
 * // CLI mode — spawn `openclaw agent` per decision (no gateway)
 * const ocCli = createOpenClawAdapter({ mode: 'cli', model: 'gpt-4o' });
 *
 * // Gateway mode — connect to a running OpenClaw gateway
 * const ocGateway = createOpenClawAdapter({
 *   mode: 'gateway',
 *   gatewayUrl: 'http://localhost:18789',
 * });
 *
 * const result = await runHarness({
 *   a2aUrl: 'http://localhost:3001',
 *   agents: [ocCli],
 *   archetypes: [getArchetype('trader')],
 *   ...
 * });
 * ```
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  ActionType,
  AgentConfig,
  AgentContext,
  AgentDecision,
  ArchetypeConfig,
  TrainableAgent,
} from '../types';

// ─── Config ──────────────────────────────────────────────────────────────────

export type OpenClawMode = 'cli' | 'gateway';

export interface OpenClawAdapterConfig {
  /**
   * How to invoke OpenClaw:
   * - `cli`: run `openclaw agent --message ...` as a subprocess (no gateway required)
   * - `gateway`: POST to a running OpenClaw HTTP gateway
   */
  mode?: OpenClawMode;
  /** Model to use (CLI mode only). Default: 'gpt-4o' */
  model?: string;
  /** Gateway URL (gateway mode only). Default: 'http://localhost:18789' */
  gatewayUrl?: string;
  /** Path to OpenClaw CLI binary. Auto-detected if omitted. */
  openClawBin?: string;
  /** Workspace root override. Auto-detected if omitted. */
  workspaceRoot?: string;
  /** Timeout per decision in ms. Default: 30000. */
  timeoutMs?: number;
}

// ─── Path resolution ──────────────────────────────────────────────────────────

function detectWorkspaceRoot(): string {
  const __dir = new URL(import.meta.url).pathname.replace(/\/[^/]+$/, '');
  let current = resolve(__dir);
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(current, 'babylon', 'package.json'))) return current;
    current = join(current, '..');
  }
  return join(__dir, '../../../../../../..');
}

function findOpenClawBin(workspaceRoot: string): string {
  const candidates = [
    // Local build from bootstrap
    join(workspaceRoot, 'external-sources', 'openclaw', 'openclaw.mjs'),
    join(workspaceRoot, 'external-sources', 'openclaw', 'dist', 'index.js'),
    // Global install
    'openclaw',
  ];

  // Check file-based paths first
  for (const p of candidates.slice(0, 2)) {
    if (existsSync(p)) return p;
  }

  // Check if globally installed
  try {
    execFileSync('openclaw', ['--version'], { timeout: 5000, stdio: 'ignore' });
    return 'openclaw';
  } catch {
    // not in PATH
  }

  throw new Error(
    `OpenClaw binary not found. Install globally with 'npm install -g openclaw@latest' ` +
      `or run 'bun run agent-frameworks:bootstrap'.\n` +
      `Searched: ${candidates.join(', ')}`
  );
}

// ─── Prompt construction ──────────────────────────────────────────────────────

const OPENCLAW_SYSTEM = `You are an autonomous trading agent in Babylon, a satirical prediction market game.

Decide your next action based on the game state. Respond with ONLY valid JSON:
{"action":"BUY_YES","marketId":"id","outcome":"YES","amount":50,"content":null,"reasoning":"reason"}

Actions: BUY_YES, BUY_NO, SELL_SHARES, CREATE_POST, LIKE_POST, COMMENT_POST, VIEW_FEED, VIEW_MARKET_DATA, HOLD`;

function buildOpenClawPrompt(context: AgentContext): string {
  const { balance, positions, markets, posts, tick, archetype } = context;
  const arch = archetype ? `Archetype: ${archetype.name}. ` : '';
  const mkts = markets
    .slice(0, 5)
    .map(
      (m) => `[${m.id.slice(-8)}] ${m.question} YES=$${m.yesPrice.toFixed(3)}`
    )
    .join('; ');
  const feed = posts
    .slice(0, 3)
    .map((p) => `${p.authorName}: "${p.content.slice(0, 80)}"`)
    .join(' | ');

  return (
    `${arch}Tick ${tick}. Balance: $${balance.toFixed(2)}. ` +
    `Positions: ${positions.length === 0 ? 'none' : positions.map((p) => `${p.outcome}@${p.marketId.slice(-8)}`).join(', ')}. ` +
    `Markets: ${mkts || 'none'}. ` +
    `Feed: ${feed || 'empty'}. ` +
    `${OPENCLAW_SYSTEM}`
  );
}

// ─── Response parsing ─────────────────────────────────────────────────────────

const VALID_ACTIONS: Set<ActionType> = new Set([
  'BUY_YES',
  'BUY_NO',
  'SELL_SHARES',
  'CREATE_POST',
  'LIKE_POST',
  'COMMENT_POST',
  'VIEW_FEED',
  'VIEW_MARKET_DATA',
  'DISCOVER_AGENTS',
  'SEARCH_USERS',
  'CHECK_LEADERBOARD',
  'CHECK_NOTIFICATIONS',
  'HOLD',
]);

function parseOpenClawResponse(raw: string): AgentDecision {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    // Keyword fallback
    if (/\bbuy.*yes\b/i.test(raw))
      return { action: 'BUY_YES', params: {}, reasoning: raw.slice(0, 100) };
    if (/\bbuy.*no\b/i.test(raw))
      return { action: 'BUY_NO', params: {}, reasoning: raw.slice(0, 100) };
    if (/\bsell\b/i.test(raw))
      return {
        action: 'SELL_SHARES',
        params: {},
        reasoning: raw.slice(0, 100),
      };
    if (/\bpost\b/i.test(raw))
      return {
        action: 'CREATE_POST',
        params: { content: raw.slice(0, 200) },
        reasoning: 'auto',
      };
    return {
      action: 'HOLD',
      params: {},
      reasoning: `No JSON found: ${raw.slice(0, 80)}`,
    };
  }

  const json = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const action = String(json.action ?? 'HOLD') as ActionType;
  const params: Record<string, unknown> = {};
  if (json.marketId) params.marketId = json.marketId;
  if (json.outcome) params.outcome = json.outcome;
  if (json.amount) params.amount = json.amount;
  if (json.content) params.content = json.content;

  return {
    action: VALID_ACTIONS.has(action) ? action : 'HOLD',
    params,
    reasoning: String(json.reasoning ?? 'OpenClaw decision'),
  };
}

// ─── OpenClawAdapter ──────────────────────────────────────────────────────────

export class OpenClawAdapter implements TrainableAgent {
  readonly id = 'openclaw-adapter';
  readonly name = 'OpenClaw Agent';
  readonly language = 'typescript' as const;

  private cfg: Required<OpenClawAdapterConfig>;
  private binPath = '';
  private archetype: ArchetypeConfig | undefined;
  private failCount = 0;
  private readonly maxFail = 3;

  constructor(config: OpenClawAdapterConfig = {}) {
    this.cfg = {
      mode: 'cli',
      model: 'gpt-4o',
      gatewayUrl: 'http://localhost:18789',
      openClawBin: '',
      workspaceRoot: '',
      timeoutMs: 30_000,
      ...config,
    };
  }

  async initialize(config: AgentConfig): Promise<void> {
    this.archetype = config.archetype;

    const workspaceRoot = this.cfg.workspaceRoot || detectWorkspaceRoot();
    this.binPath = this.cfg.openClawBin || findOpenClawBin(workspaceRoot);

    console.log(
      `  [OpenClawAdapter] Initialized: mode=${this.cfg.mode}, ` +
        (this.cfg.mode === 'cli'
          ? `bin=${this.binPath}`
          : `gateway=${this.cfg.gatewayUrl}`)
    );
  }

  async decide(context: AgentContext): Promise<AgentDecision> {
    if (this.failCount >= this.maxFail) {
      return { action: 'HOLD', params: {}, reasoning: 'OpenClaw unavailable' };
    }

    const ctx = this.archetype
      ? { ...context, archetype: this.archetype }
      : context;
    const prompt = buildOpenClawPrompt(ctx);

    try {
      const raw =
        this.cfg.mode === 'cli'
          ? await this.callCLI(prompt)
          : await this.callGateway(prompt);

      this.failCount = 0;
      return parseOpenClawResponse(raw);
    } catch (err) {
      this.failCount++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `  [OpenClawAdapter] decide failed (${this.failCount}/${this.maxFail}): ${msg}`
      );
      return {
        action: 'HOLD',
        params: {},
        reasoning: `OpenClaw error: ${msg}`,
      };
    }
  }

  async cleanup(): Promise<void> {
    // No persistent process in CLI mode; gateway mode has no cleanup needed
  }

  // ─── CLI invocation ─────────────────────────────────────────────────────────

  private async callCLI(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`OpenClaw CLI timed out`)),
        this.cfg.timeoutMs
      );

      let stdout = '';
      let stderr = '';

      // Determine how to invoke the binary
      const isScript =
        this.binPath.endsWith('.mjs') || this.binPath.endsWith('.js');
      const [cmd, ...cmdArgs] = isScript
        ? ['node', this.binPath]
        : [this.binPath];

      // OpenClaw CLI: `openclaw agent --message <prompt> [--model <model>]`
      // We do not pass --json-output or --no-stream; these flags don't exist
      // in the public CLI. The response parser handles natural language output.
      const args = [
        ...cmdArgs,
        'agent',
        '--message',
        prompt,
        '--model',
        this.cfg.model,
      ];

      const proc = spawn(cmd, args, {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      proc.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      proc.on('close', (code: number) => {
        clearTimeout(timer);
        if (code !== 0 && !stdout.trim()) {
          reject(
            new Error(`OpenClaw CLI exited ${code}: ${stderr.slice(0, 200)}`)
          );
          return;
        }
        resolve(stdout.trim() || stderr.trim());
      });

      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // ─── Gateway HTTP invocation ─────────────────────────────────────────────────

  private async callGateway(prompt: string): Promise<string> {
    const resp = await fetch(`${this.cfg.gatewayUrl}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(
        `OpenClaw gateway error ${resp.status}: ${body.slice(0, 200)}`
      );
    }

    const data = (await resp.json()) as {
      response?: string;
      text?: string;
      content?: string;
    };
    return data.response ?? data.text ?? data.content ?? JSON.stringify(data);
  }
}

/** Create an OpenClawAdapter with sensible defaults. */
export function createOpenClawAdapter(
  config: OpenClawAdapterConfig = {}
): OpenClawAdapter {
  return new OpenClawAdapter(config);
}
