/**
 * Warm Codex SDK inference session — the codex peer of {@link ClaudeSdkSession}.
 *
 * Runs an Eliza chat brain (chat + planner) on a personal ChatGPT/Codex
 * subscription via `@openai/codex-sdk`, which wraps the bundled `codex` binary
 * and reads its own `~/.codex/auth.json` (eliza never sees the token). Unlike
 * `codex exec` (CodexCli), which cold-spawns a fresh process per call, this keeps
 * ONE warm `Thread` alive (`codex.startThread()` once; `thread.run()` per turn),
 * so the startup cost is paid once.
 *
 * TWO MODES:
 *  - TEXT mode (`generate`): pure completion for the reply / large tiers. The
 *    thread runs read-only, no network, no approvals — a warm completion engine.
 *    Returns the turn's `finalResponse`.
 *  - ROUTE mode (`route`): the ACTION_PLANNER decision via codex NATIVE structured
 *    output (`TurnOptions.outputSchema`). The schema constrains the turn to
 *    `{action, params}` with `params` as a JSON STRING (OpenAI strict mode forbids
 *    open-ended objects), which `normalizeRoute` parses back into the bare
 *    `{action, params}` shape the planner loop's text-mode parser accepts. This
 *    is reliable at scale (the model cannot drift off-shape) — unlike free-text
 *    JSON. REQUIRES the system codex binary (`codexBinPath`): the SDK's bundled
 *    binary is too old and rejects structured output ("requires a newer version").
 *
 * codex-sdk has NO thread-level system prompt (ThreadOptions carries none), so
 * the system content is folded into the body per call — which also means ONE warm
 * thread per (model, mode) can serve every system prompt (no per-systemPrompt
 * keying needed, unlike claude). Calls are SERIALIZED; the session self-heals on
 * error and restarts after `restartAfterTurns` to bound the thread's accumulating
 * context.
 *
 * LIVE-VERIFIED on a ChatGPT/Codex subscription: btc/eth/weather route to
 * WEB_FETCH and synthesize the real fetched value; math/chat/identity work. Needs
 * the system codex binary via `codexBinPath` (the SDK's bundled 0.80.0 rejects
 * gpt-5.5). Unit-tested via the injectable `codexModule` seam.
 *
 * @module plugin-cli-inference/codex-sdk-session
 */

import { logger } from "@elizaos/core";
import type { RotationSubprocessEnv } from "./account-rotation";

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_RESTART_AFTER_TURNS = 20;

/** The model's captured routing decision (ROUTE mode). */
export interface CodexRouteDecision {
  action: string;
  params: Record<string, unknown>;
}

/**
 * Output schema constraining ROUTE-mode output to `{action, params}` where
 * `params` is a JSON STRING. OpenAI strict structured-output forbids open-ended
 * objects (every nested object must declare all properties + additionalProperties:
 * false), so an arbitrary params object is impossible — encoding params as a JSON
 * string sidesteps that while still guaranteeing the shape. Requires the system
 * codex binary (the SDK's bundled one rejects it / the model).
 */
const ROUTE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "params"],
  properties: {
    action: { type: "string" },
    params: { type: "string", description: "JSON-encoded params object" },
  },
} as const;

interface CodexTurn {
  items?: Array<{ type?: string; text?: string }>;
  finalResponse?: string;
  usage?: unknown;
}
interface CodexThread {
  run(input: string, turnOptions?: { outputSchema?: unknown }): Promise<CodexTurn>;
}
interface CodexInstance {
  startThread(options?: Record<string, unknown>): CodexThread;
}
/** Minimal shape of the `@openai/codex-sdk` module we load lazily. */
export interface CodexModule {
  Codex: new (options?: Record<string, unknown>) => CodexInstance;
}

export interface CodexSdkSessionConfig {
  model?: string | null;
  /** ROUTE mode (free-text `{action,params}` JSON) vs TEXT mode (plain completion). */
  router?: boolean;
  /** `modelReasoningEffort` for the thread (minimal|low|medium|high|xhigh). */
  reasoningEffort?: string | null;
  /**
   * Path to the codex binary the SDK should drive (`codexPathOverride`). The SDK
   * BUNDLES its own (often older) codex under `vendor/`; that bundled binary
   * rejects newer models with "requires a newer version of Codex". Point this at
   * the installed system codex (e.g. `~/.local/bin/codex`) so current models like
   * gpt-5.5 work.
   */
  codexBinPath?: string | null;
  /** Restart the warm thread after this many turns (bounds context growth). */
  restartAfterTurns?: number;
  /**
   * Optional subprocess-only env for a pooled account. Passed to the Codex SDK
   * constructor; never written to the parent process env.
   */
  subprocessEnv?: RotationSubprocessEnv | null;
  /** Injected for tests; defaults to the real SDK. */
  codexModule?: CodexModule;
}

const SDK_PACKAGE = "@openai/codex-sdk";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCodexModule(value: unknown): value is CodexModule {
  return isRecord(value) && typeof value.Codex === "function";
}

async function loadCodex(): Promise<CodexModule> {
  const codex: unknown = await import(SDK_PACKAGE);
  if (!isCodexModule(codex)) {
    throw new Error("[cli-inference:codex-sdk] Codex SDK module has an unexpected shape");
  }
  return codex;
}

/** Pull the assistant text out of a completed codex turn. */
function turnToText(turn: CodexTurn): string {
  if (typeof turn.finalResponse === "string" && turn.finalResponse.trim()) {
    return turn.finalResponse.trim();
  }
  // Fallback: the last agent_message item's text.
  for (const item of [...(turn.items ?? [])].reverse()) {
    if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
      return item.text.trim();
    }
  }
  return "";
}

/**
 * A single warm Codex SDK thread for one (model, mode). Lazily starts on first
 * call, serializes calls, and self-heals (restarts) on error or after
 * `restartAfterTurns`.
 */
export class CodexSdkSession {
  private readonly model: string;
  private readonly router: boolean;
  private readonly reasoningEffort: string | null;
  private readonly codexBinPath: string | null;
  private readonly restartAfterTurns: number;
  private readonly subprocessEnv: RotationSubprocessEnv | null;
  private readonly codexOverride?: CodexModule;

  private thread: CodexThread | null = null;
  private turns = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(config: CodexSdkSessionConfig) {
    this.model = config.model?.trim() || DEFAULT_MODEL;
    this.router = config.router === true;
    this.reasoningEffort = config.reasoningEffort?.trim() || null;
    this.codexBinPath = config.codexBinPath?.trim() || null;
    this.restartAfterTurns =
      config.restartAfterTurns && config.restartAfterTurns > 0
        ? config.restartAfterTurns
        : DEFAULT_RESTART_AFTER_TURNS;
    this.subprocessEnv = config.subprocessEnv ?? null;
    this.codexOverride = config.codexModule;
  }

  /** TEXT mode: generate one completion's text. Serialized. */
  generate(body: string): Promise<string> {
    return this.enqueue(() => this.sendOnce(body, "text"));
  }

  /**
   * ROUTE mode: return `JSON.stringify({action, params})` — the action the model
   * picked via codex's native structured output. Consumed directly by the planner
   * loop's text-mode parser, so no core change is needed.
   */
  route(body: string): Promise<string> {
    return this.enqueue(() => this.sendOnce(body, "route"));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async sendOnce(body: string, mode: "text" | "route"): Promise<string> {
    if (!body.trim()) {
      throw new Error("[cli-inference:codex-sdk] empty prompt body");
    }
    if (this.thread && this.turns >= this.restartAfterTurns) {
      this.dispose();
    }
    if (!this.thread) {
      await this.start();
    }
    this.turns += 1;
    try {
      const thread = this.thread;
      if (!thread) throw new Error("[cli-inference:codex-sdk] thread not started");
      // ROUTE: constrain output to {action, params:json-string} via the codex
      // native output schema (reliable shape; needs the system codex binary).
      const turn = await thread.run(
        body,
        mode === "route" ? { outputSchema: ROUTE_OUTPUT_SCHEMA } : undefined
      );
      const text = turnToText(turn);
      if (mode === "route") {
        return this.normalizeRoute(text);
      }
      if (!text) {
        throw new Error("[cli-inference:codex-sdk] empty completion");
      }
      return text;
    } catch (err) {
      // Self-heal: a dead/erroring thread must not poison the next turn.
      this.dispose();
      throw err instanceof Error ? err : new Error(`[cli-inference:codex-sdk] ${String(err)}`);
    }
  }

  /** Coerce the structured-output JSON into a bare {action, params} string. */
  private normalizeRoute(text: string): string {
    if (!text) {
      throw new Error("[cli-inference:codex-sdk] route: empty structured output");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Structured output should be valid JSON; if the model wrapped it, salvage
      // the first {...} block rather than failing the turn.
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) {
        throw new Error("[cli-inference:codex-sdk] route: non-JSON output");
      }
      parsed = JSON.parse(match[0]);
    }
    const obj = parsed as { action?: unknown; params?: unknown };
    if (typeof obj.action !== "string" || !obj.action.trim()) {
      throw new Error("[cli-inference:codex-sdk] route: missing action");
    }
    // `params` arrives as a JSON STRING (ROUTE_OUTPUT_SCHEMA encodes it that way
    // for strict-mode), or already as an object on the free-text fallback path.
    let params: Record<string, unknown> = {};
    if (typeof obj.params === "string" && obj.params.trim()) {
      try {
        const p = JSON.parse(obj.params);
        if (p && typeof p === "object") params = p as Record<string, unknown>;
      } catch {
        // malformed params string — keep {} rather than failing the turn
      }
    } else if (obj.params && typeof obj.params === "object") {
      params = obj.params as Record<string, unknown>;
    }
    return JSON.stringify({
      action: obj.action.trim(),
      params,
    });
  }

  private async start(): Promise<void> {
    const { Codex } = this.codexOverride ?? (await loadCodex());
    // Drive the system codex binary (not the SDK's bundled-and-often-stale one)
    // when a path is configured, so current models work.
    const codexOptions: Record<string, unknown> = {};
    if (this.codexBinPath) codexOptions.codexPathOverride = this.codexBinPath;
    if (this.subprocessEnv) codexOptions.env = this.subprocessEnv;
    const codex = new Codex(codexOptions);
    // Pure inference: read-only, no network, no approvals, no git-repo coupling —
    // a warm completion engine, not a coding agent.
    const options: Record<string, unknown> = {
      model: this.model,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchEnabled: false,
      skipGitRepoCheck: true,
    };
    if (this.reasoningEffort) options.modelReasoningEffort = this.reasoningEffort;
    this.thread = codex.startThread(options);
    this.turns = 0;
    logger.debug(
      { src: "cli-inference:codex-sdk", model: this.model, mode: this.router ? "route" : "text" },
      "warm Codex SDK thread started"
    );
  }

  /** Tear down the warm thread (on restart, error, or dispose). */
  dispose(): void {
    this.thread = null;
    this.turns = 0;
  }
}
