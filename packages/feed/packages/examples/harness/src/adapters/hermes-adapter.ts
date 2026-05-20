/**
 * Hermes Agent Adapter
 *
 * Bridges the Hermes agent framework (NousResearch) into the harness
 * `TrainableAgent` interface. Hermes runs as a Python subprocess communicating
 * over a JSONL protocol via stdin/stdout.
 *
 * Requires:
 *   1. Python venv set up at `external-sources/hermes-agent/.venv` (run
 *      `bun run agent-frameworks:bootstrap` to do this automatically).
 *   2. Hermes bridge script at `scripts/scambench/hermes_benchmark_bridge.py`
 *      OR at `external-sources/hermes-agent/scripts/benchmark_bridge.py`.
 *   3. An LLM provider API key (GROQ_API_KEY, OPENAI_API_KEY, etc.) readable
 *      from the current environment.
 *
 * @example
 * ```typescript
 * import { HermesAdapter, createHermesAdapter } from '@feed/agent-harness';
 *
 * const hermes = createHermesAdapter({
 *   model: 'llama-3.3-70b-versatile',
 *   baseUrl: 'https://api.groq.com/openai/v1',
 * });
 *
 * const result = await runHarness({
 *   a2aUrl: 'http://localhost:3001',
 *   agents: [hermes],
 *   archetypes: [getArchetype('trader')],
 *   ...
 * });
 * ```
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ActionType,
  AgentConfig,
  AgentContext,
  AgentDecision,
  ArchetypeConfig,
  TrainableAgent,
} from "../types";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface HermesAdapterConfig {
  /** LLM model ID to pass to Hermes (e.g. 'llama-3.3-70b-versatile') */
  model: string;
  /**
   * OpenAI-compatible base URL for the model endpoint.
   * Defaults to Groq if GROQ_API_KEY present, else OpenAI.
   */
  baseUrl?: string;
  /** API key for the model endpoint. Reads env if omitted. */
  apiKey?: string;
  /** Maximum Hermes internal reasoning iterations per decision. Default: 4. */
  maxIterations?: number;
  /** Workspace root override (parent of the feed repo). Auto-detected if omitted. */
  workspaceRoot?: string;
  /** Timeout for a single Hermes call in ms. Default: 60000. */
  timeoutMs?: number;
  /** Keep the Python subprocess alive between ticks (faster, uses more RAM). Default: true. */
  persistent?: boolean;
}

// ─── Path resolution ──────────────────────────────────────────────────────────

function detectWorkspaceRoot(): string {
  // Walk up from this file until we find the feed directory with packages/
  const __dir = new URL(import.meta.url).pathname.replace(/\/[^/]+$/, "");
  let current = resolve(__dir);
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(current, "feed", "package.json"))) return current;
    if (existsSync(join(current, "packages", "engine")))
      return join(current, "..");
    current = join(current, "..");
  }
  return join(__dir, "../../../../../../..");
}

function findBridgeScript(workspaceRoot: string): string {
  const candidates = [
    join(
      workspaceRoot,
      "feed",
      "scripts",
      "scambench",
      "hermes_benchmark_bridge.py",
    ),
    join(
      workspaceRoot,
      "external-sources",
      "hermes-agent",
      "scripts",
      "benchmark_bridge.py",
    ),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `Hermes bridge script not found. Run 'bun run agent-frameworks:bootstrap' first.\n` +
        `Searched:\n${candidates.map((p) => `  ${p}`).join("\n")}`,
    );
  }
  return found;
}

function findHermesPython(workspaceRoot: string): string {
  const hermesRoot = join(workspaceRoot, "external-sources", "hermes-agent");
  const candidates = [
    join(hermesRoot, ".venv", "bin", "python"),
    join(hermesRoot, "venv", "bin", "python"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `Hermes Python venv not found at ${hermesRoot}. ` +
        `Run 'bun run agent-frameworks:bootstrap' first.`,
    );
  }
  return found;
}

function resolveApiKey(baseUrl: string): string {
  if (baseUrl.includes("groq.com") && process.env.GROQ_API_KEY)
    return process.env.GROQ_API_KEY;
  if (baseUrl.includes("anthropic.com") && process.env.ANTHROPIC_API_KEY)
    return process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  return "benchmark-local";
}

// ─── Decision prompt ──────────────────────────────────────────────────────────

const HERMES_SYSTEM = `You are an autonomous trading agent in Feed, a satirical prediction market game.

Given the current game state (portfolio, markets, feed), you must decide your next action.

Available actions:
- BUY_YES / BUY_NO — buy prediction market shares (include marketId and amount)
- SELL_SHARES — close a position
- CREATE_POST — post to the social feed (include content)
- LIKE_POST — like a post
- COMMENT_POST — comment on a post (include content)
- VIEW_FEED / VIEW_MARKET_DATA — passive observation
- HOLD — do nothing

Respond with ONLY valid JSON, no markdown, no explanation:
{"action":"BUY_YES","marketId":"abc123","outcome":"YES","amount":50,"content":null,"reasoning":"brief reason"}`;

function buildHermesUserPrompt(context: AgentContext): string {
  const { balance, positions, markets, posts, tick, archetype } = context;

  const arch = archetype
    ? `Archetype: ${archetype.name} (${archetype.description})\n\n`
    : "";

  const portfolio = [
    `Tick: ${tick}`,
    `Balance: $${balance.toFixed(2)}`,
    `Positions: ${
      positions.length === 0
        ? "none"
        : positions
            .map(
              (p) =>
                `${p.outcome}@${p.marketId.slice(-8)} (${p.shares.toFixed(1)} shares)`,
            )
            .join(", ")
    }`,
  ].join("\n");

  const mkts =
    markets.length === 0
      ? "None"
      : markets
          .slice(0, 6)
          .map(
            (m) =>
              `[${m.id.slice(-8)}] ${m.question} YES=$${m.yesPrice.toFixed(3)} NO=$${m.noPrice.toFixed(3)}`,
          )
          .join("\n");

  const feed =
    posts.length === 0
      ? "Empty"
      : posts
          .slice(0, 4)
          .map((p) => `@${p.authorName}: "${p.content.slice(0, 100)}"`)
          .join("\n");

  return `${arch}${portfolio}\n\nMarkets:\n${mkts}\n\nFeed:\n${feed}\n\nDecide now. JSON only.`;
}

// ─── Response parsing ─────────────────────────────────────────────────────────

const VALID_ACTIONS: Set<ActionType> = new Set([
  "BUY_YES",
  "BUY_NO",
  "SELL_SHARES",
  "CREATE_POST",
  "LIKE_POST",
  "COMMENT_POST",
  "VIEW_FEED",
  "VIEW_MARKET_DATA",
  "DISCOVER_AGENTS",
  "SEARCH_USERS",
  "CHECK_LEADERBOARD",
  "CHECK_NOTIFICATIONS",
  "HOLD",
]);

function parseDecision(raw: string): AgentDecision {
  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1) {
    // Natural language fallback — map common keywords to actions
    if (/buy.*yes/i.test(raw))
      return { action: "BUY_YES", params: {}, reasoning: raw.slice(0, 100) };
    if (/buy.*no/i.test(raw))
      return { action: "BUY_NO", params: {}, reasoning: raw.slice(0, 100) };
    if (/sell/i.test(raw))
      return {
        action: "SELL_SHARES",
        params: {},
        reasoning: raw.slice(0, 100),
      };
    if (/post|tweet/i.test(raw))
      return {
        action: "CREATE_POST",
        params: { content: raw.slice(0, 200) },
        reasoning: "auto",
      };
    return {
      action: "HOLD",
      params: {},
      reasoning: `Unparseable response: ${raw.slice(0, 80)}`,
    };
  }

  const json = JSON.parse(cleaned.slice(start, end + 1)) as Record<
    string,
    unknown
  >;
  const action = String(json.action ?? "HOLD") as ActionType;
  const safeAction = VALID_ACTIONS.has(action) ? action : "HOLD";

  const params: Record<string, unknown> = {};
  if (json.marketId) params.marketId = json.marketId;
  if (json.outcome) params.outcome = json.outcome;
  if (json.amount) params.amount = json.amount;
  if (json.content) params.content = json.content;

  return {
    action: safeAction,
    params,
    reasoning: String(json.reasoning ?? "Hermes decision"),
  };
}

// ─── Subprocess protocol ──────────────────────────────────────────────────────

interface BridgePayload {
  type: "complete" | "close";
  systemMessage?: string;
  userMessage?: string;
  conversationHistory?: Array<{ role: string; content: string }>;
}

interface BridgeResponse {
  ok: boolean;
  finalResponse?: string;
  error?: string;
}

async function callBridge(
  proc: ChildProcess,
  payload: BridgePayload,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!proc.stdin || !proc.stdout) {
      reject(new Error("Hermes subprocess streams unavailable"));
      return;
    }

    let done = false;
    let buf = "";

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      proc.stdout?.off("data", onData);
      reject(new Error(`Hermes bridge timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Buffer incoming data and look for a complete newline-terminated JSON line.
    // A single `data` event may carry only a partial chunk of the response.
    const onData = (chunk: Buffer | string) => {
      if (done) return;
      buf += String(chunk);

      const newline = buf.indexOf("\n");
      if (newline === -1) return; // incomplete line, keep buffering

      done = true;
      clearTimeout(timer);
      proc.stdout?.off("data", onData);

      const line = buf.slice(0, newline).trim();
      try {
        const resp = JSON.parse(line) as BridgeResponse;
        if (!resp.ok) {
          reject(new Error(resp.error ?? "Hermes bridge error"));
          return;
        }
        resolve(resp.finalResponse ?? "");
      } catch {
        reject(
          new Error(`Invalid JSON from Hermes bridge: ${line.slice(0, 100)}`),
        );
      }
    };

    proc.stdout.on("data", onData);
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}

// ─── HermesAdapter ────────────────────────────────────────────────────────────

export class HermesAdapter implements TrainableAgent {
  readonly id = "hermes-adapter";
  readonly name = "Hermes Agent";
  readonly language = "typescript" as const;

  private cfg: HermesAdapterConfig;
  private pythonExe = "";
  private bridgeScript = "";
  private resolvedBaseUrl = "";
  private resolvedApiKey = "";
  private proc: ChildProcess | null = null;
  private archetype: ArchetypeConfig | undefined;
  private failCount = 0;
  private readonly maxFail = 3;

  constructor(config: HermesAdapterConfig) {
    this.cfg = {
      maxIterations: 4,
      timeoutMs: 60_000,
      persistent: true,
      ...config,
    };
  }

  async initialize(config: AgentConfig): Promise<void> {
    this.archetype = config.archetype;

    const workspaceRoot = this.cfg.workspaceRoot ?? detectWorkspaceRoot();
    this.pythonExe = findHermesPython(workspaceRoot);
    this.bridgeScript = findBridgeScript(workspaceRoot);

    this.resolvedBaseUrl =
      this.cfg.baseUrl ??
      (process.env.GROQ_API_KEY
        ? "https://api.groq.com/openai/v1"
        : "https://api.openai.com/v1");

    this.resolvedApiKey =
      this.cfg.apiKey ?? resolveApiKey(this.resolvedBaseUrl);

    if (this.cfg.persistent) {
      this.proc = this.spawnBridge();
      console.log(
        `  [HermesAdapter] Started persistent bridge: ${this.cfg.model}`,
      );
    }
  }

  async decide(context: AgentContext): Promise<AgentDecision> {
    if (this.failCount >= this.maxFail) {
      return { action: "HOLD", params: {}, reasoning: "Hermes unavailable" };
    }

    const archToUse = this.archetype ?? context.archetype;
    const contextWithArch = archToUse
      ? { ...context, archetype: archToUse }
      : context;

    try {
      const proc = this.cfg.persistent
        ? (this.proc ?? this.spawnBridge())
        : this.spawnBridge();
      if (this.cfg.persistent) this.proc = proc;

      const response = await callBridge(
        proc,
        {
          type: "complete",
          systemMessage: HERMES_SYSTEM,
          userMessage: buildHermesUserPrompt(contextWithArch),
        },
        this.cfg.timeoutMs!,
      );

      if (!this.cfg.persistent) {
        proc.kill();
      }

      this.failCount = 0;
      return parseDecision(response);
    } catch (err) {
      this.failCount++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `  [HermesAdapter] decide failed (${this.failCount}/${this.maxFail}): ${msg}`,
      );
      if (this.cfg.persistent) {
        this.proc?.kill();
        this.proc = null;
      }
      return { action: "HOLD", params: {}, reasoning: `Hermes error: ${msg}` };
    }
  }

  async cleanup(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) {
      try {
        await callBridge(this.proc, { type: "close" }, 5_000);
      } catch {
        // best-effort close
      }
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }

  private spawnBridge(): ChildProcess {
    const args = [
      this.bridgeScript,
      "--model",
      this.cfg.model,
      "--base-url",
      this.resolvedBaseUrl,
      "--api-key",
      this.resolvedApiKey,
      "--max-iterations",
      String(this.cfg.maxIterations ?? 4),
      "--skip-memory",
      "--no-tools",
    ];

    return spawn(this.pythonExe, args, {
      cwd: resolve(this.pythonExe, "../.."),
      stdio: ["pipe", "pipe", "inherit"],
    });
  }
}

/** Create a HermesAdapter with sensible defaults. */
export function createHermesAdapter(
  config: HermesAdapterConfig,
): HermesAdapter {
  return new HermesAdapter(config);
}
