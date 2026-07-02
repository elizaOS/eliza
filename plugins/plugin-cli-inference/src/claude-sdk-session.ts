/**
 * Warm Claude Agent SDK inference session — the FAST, TOS-clean way to run an
 * Eliza brain on a Claude Max subscription.
 *
 * Unlike `claude --print` (ClaudeCli), which cold-spawns a fresh process on
 * EVERY model call (~5-15s startup each; the planner's ~4-8 calls/turn = 25-68s),
 * this keeps ONE long-lived Claude Code process warm via the Agent SDK's
 * streaming-input mode. The startup cost is paid once; subsequent turns are just
 * inference (~1-2s, proven). Auth is the subscription's own OAuth — the SDK reads
 * `~/.claude` or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`); eliza
 * never sees the token. Effective 2026-06-15 this is OFFICIALLY sanctioned use
 * of a Claude subscription (the monthly Agent SDK credit), so it is strictly
 * cleaner than the in-process stealth token-replay.
 *
 * TWO MODES (the SDK fixes `systemPrompt` + `mcpServers` at query() start — see
 * the live-proven research wf_3199bde6: there is NO mid-session setSystemPrompt
 * or history-reset, so a session is created per frozen system prompt):
 *
 *  - TEXT mode (`generate`): pure text generation for the reply / large tiers.
 *    `allowedTools: []` strips Claude Code's own tools so the SDK is a warm
 *    chat-completion engine. `maxTurns` defaults to 1 (a one-shot answer leaves
 *    no room for the agentic "I'll fetch it…" preamble-then-act pattern that
 *    leaks when >1), and the `result` envelope is inspected so an
 *    `error_max_turns`/empty turn falls back to `result.result` instead of
 *    throwing a spurious "empty completion".
 *
 *  - ROUTE mode (`route`): the ACTION_PLANNER decision via NATIVE tool-calling.
 *    A single in-process MCP tool (`route_action`) is the ONLY allowed tool; the
 *    model emits a real `tool_use`, the SDK routes it to our handler in-process,
 *    and the handler captures `{action, params}` — Eliza executes the action,
 *    Claude Code never does. This matches the stealth/native path's full
 *    functionality (WEB_FETCH, sub-agents) with no free-text JSON parsing and no
 *    required-tool retry loop. The turn ends `subtype=error_max_turns` (normal
 *    for a tool-calling turn under `maxTurns: 1`); the captured decision — not
 *    the assistant text — is the result.
 *
 * One instance == one (model, systemPrompt, mode). Calls are SERIALIZED (one in
 * flight per warm session); spin up multiple instances for concurrency. The
 * session is RESTARTED after `restartAfterTurns` turns to bound the accumulating
 * context window.
 *
 * @module plugin-cli-inference/claude-sdk-session
 */

import { logger } from "@elizaos/core";
import type { RotationSubprocessEnv } from "./account-rotation";
import { ProviderApiError, parseProviderApiErrorText } from "./provider-errors";

const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_RESTART_AFTER_TURNS = 20;
const DEFAULT_TURN_TIMEOUT_MS = 90_000;
/** Fully-qualified name the SDK assigns our in-process MCP tool. */
const ROUTE_TOOL = "mcp__eliza__route_action";

/**
 * When the monthly Agent SDK credit runs dry (documented caveat: the subscription
 * limit can be hit mid-month), the SDK ends the turn CLEANLY but streams the
 * subscription limit UI string as the assistant text — e.g. "You've hit your
 * session limit · resets 9:30pm (UTC)". Without this guard that meta-string is
 * returned as the turn's completion and relayed verbatim to the user as the reply.
 * Match the SDK's own limit envelope (a fixed provider string, NOT user content)
 * so the caller can THROW to failover / a graceful rate-limit reply instead of
 * leaking it. Kept narrow to the subscription-limit signature to avoid catching a
 * genuine model answer that happens to discuss limits.
 */
export function isClaudeSubscriptionLimitMessage(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length > 160) return false; // the real limit string is short; a long answer isn't it
  // A genuine short ANSWER about limits ("No, you haven't hit your rate limit
  // yet.") shares vocabulary with the envelope; the envelope itself never
  // contains negation.
  if (/\b(no|not|haven't|havent|hasn't|hasnt|didn't|didnt|isn't|isnt|wasn't|wasnt)\b/.test(t)) {
    return false;
  }
  return (
    // The UI envelope's interpunct separator ("· resets 9:30pm (UTC)",
    // "∙ resets 3am") — model prose doesn't join clauses with an interpunct.
    /[·∙•]\s*resets\b/.test(t) ||
    // The envelope IS the whole message and opens second-person: "You've hit
    // your session limit …". Anchored at the start so a genuine answer that
    // merely contains the phrase mid-sentence ("Yes — you've hit your daily
    // limit on that key") does not match.
    /^you'?ve (hit|reached|exceeded) your\b[^.]*\blimit\b/.test(t) ||
    // The classic Claude CLI form: "Claude AI usage limit reached|<unix-epoch>".
    /\bclaude( ai)? usage limit reached\s*\|/.test(t)
  );
}

/**
 * The Claude Code / Agent SDK surfaces API failures by STREAMING its error
 * string as assistant text and terminating the turn cleanly — e.g.
 * "API Error: 400 messages: text content blocks must be non-empty" (observed
 * live 18x when empty relay lines produced an empty text content block).
 * That format is the SDK's own error envelope, never a genuine completion:
 * real answers don't open with "API Error: <status>". Detect it so callers
 * throw to failover instead of relaying the raw error to the user.
 */
export function isClaudeSdkApiErrorMessage(text: string): boolean {
  return parseProviderApiErrorText(text) !== null;
}

/** The model's captured routing decision (ROUTE mode). */
export interface RouteDecision {
  action: string;
  params: Record<string, unknown>;
}

type SdkUserMessage = {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id?: null;
};
type SdkContentBlock = { type: string; text?: string };
type SdkMessage = {
  type: string;
  subtype?: string;
  result?: string;
  message?: { content?: SdkContentBlock[]; stop_reason?: string };
};
type SdkQuery = AsyncIterable<SdkMessage> & {
  interrupt?: () => Promise<void>;
};
type SdkQueryFn = (options: {
  prompt: AsyncIterable<SdkUserMessage>;
  options: Record<string, unknown>;
}) => SdkQuery;
type SdkToolFn = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: {
    action?: unknown;
    params?: unknown;
  }) => Promise<{ content: Array<{ type: string; text: string }> }>
) => unknown;
type SdkMcpServerFn = (options: { name: string; version?: string; tools: unknown[] }) => unknown;

/** Minimal shape of the SDK module we load lazily. */
export interface SdkModule {
  query: SdkQueryFn;
  tool: SdkToolFn;
  createSdkMcpServer: SdkMcpServerFn;
}
interface ZodModule {
  z: {
    string: () => unknown;
    any: () => unknown;
    record: (value: unknown) => unknown;
  };
}

export interface ClaudeSdkSessionConfig {
  model?: string | null;
  /**
   * Frozen system prompt for this session. The SDK resolves `systemPrompt` once
   * at query() start, so the caller MUST key its session cache by this value
   * (one warm process per distinct system prompt).
   */
  systemPrompt?: string | null;
  /** ROUTE mode (native `route_action` MCP tool) vs TEXT mode (plain generation). */
  router?: boolean;
  /** TEXT mode only: `maxTurns` for the SDK query (default 1 — one-shot answer,
   * no agentic preamble-then-act). Ignored in ROUTE mode (always 1). */
  textMaxTurns?: number;
  /** Path to the Claude Code executable the SDK drives. */
  claudeExecutablePath?: string | null;
  /** Restart the warm session after this many turns (bounds context growth). */
  restartAfterTurns?: number;
  /** Hard wall-clock budget for one SDK turn. Defaults below common 120s connector timeouts. */
  turnTimeoutMs?: number;
  /**
   * Optional subprocess-only env for a pooled account. Passed to the Claude SDK
   * query options; never written to the parent process env.
   */
  subprocessEnv?: RotationSubprocessEnv | null;
  /** Injected for tests; defaults to the real SDK + zod. */
  sdkModule?: SdkModule;
  zodModule?: ZodModule;
}

// Resolved at runtime from the hoisted workspace node_modules (the Agent SDK
// ships with @agentclientprotocol/claude-agent-acp). Imported via a variable so
// the build does not require it as a static dependency — the plugin stays inert
// (and never imports the SDK) unless ELIZA_CHAT_VIA_CLI=claude-sdk is set.
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSdkModule(value: unknown): value is SdkModule {
  return (
    isRecord(value) &&
    typeof value.query === "function" &&
    typeof value.tool === "function" &&
    typeof value.createSdkMcpServer === "function"
  );
}

function isZodModule(value: unknown): value is ZodModule {
  if (!isRecord(value) || !isRecord(value.z)) {
    return false;
  }
  const z = value.z;
  return (
    typeof z.string === "function" && typeof z.any === "function" && typeof z.record === "function"
  );
}

async function loadSdk(): Promise<SdkModule> {
  const sdk: unknown = await import(SDK_PACKAGE);
  if (!isSdkModule(sdk)) {
    throw new Error("[cli-inference:sdk] Claude Agent SDK module has an unexpected shape");
  }
  return sdk;
}
async function loadZod(): Promise<ZodModule> {
  const zod: unknown = await import("zod");
  if (!isZodModule(zod)) {
    throw new Error("[cli-inference:sdk] zod module has an unexpected shape");
  }
  return zod;
}

/**
 * A single warm Agent SDK session for one (model, systemPrompt, mode). Lazily
 * starts on first call, serializes calls, and self-heals (restarts) on error or
 * after `restartAfterTurns`.
 */
export class ClaudeSdkSession {
  private readonly model: string;
  private readonly systemPrompt: string | null;
  private readonly router: boolean;
  private readonly textMaxTurns: number;
  private readonly claudeExecutablePath: string | null;
  private readonly restartAfterTurns: number;
  private readonly turnTimeoutMs: number;
  private readonly subprocessEnv: RotationSubprocessEnv | null;
  private readonly sdkOverride?: SdkModule;
  private readonly zodOverride?: ZodModule;

  private query: SdkQuery | null = null;
  private feed: ((msg: SdkUserMessage) => void) | null = null;
  private iterator: AsyncIterator<SdkMessage> | null = null;
  private turns = 0;
  private chain: Promise<unknown> = Promise.resolve();
  // ROUTE mode: the MCP tool handler writes the current turn's decision here.
  // Safe to share across turns because calls are serialized on `chain` and it is
  // reset at the start of every `sendAndRead`.
  private pendingDecision: RouteDecision | null = null;

  constructor(config: ClaudeSdkSessionConfig) {
    this.model = config.model?.trim() || DEFAULT_MODEL;
    this.systemPrompt = config.systemPrompt?.trim() || null;
    this.router = config.router === true;
    this.textMaxTurns = config.textMaxTurns && config.textMaxTurns > 0 ? config.textMaxTurns : 1;
    this.claudeExecutablePath = config.claudeExecutablePath?.trim() || null;
    this.restartAfterTurns =
      config.restartAfterTurns && config.restartAfterTurns > 0
        ? config.restartAfterTurns
        : DEFAULT_RESTART_AFTER_TURNS;
    this.turnTimeoutMs =
      config.turnTimeoutMs && config.turnTimeoutMs > 0
        ? config.turnTimeoutMs
        : DEFAULT_TURN_TIMEOUT_MS;
    this.subprocessEnv = config.subprocessEnv ?? null;
    this.sdkOverride = config.sdkModule;
    this.zodOverride = config.zodModule;
  }

  /** TEXT mode: generate one completion's text. Serialized. */
  generate(body: string): Promise<string> {
    return this.enqueue(() => this.sendOnce(body, "text"));
  }

  /**
   * ROUTE mode: return `JSON.stringify({action, params})` — the action the model
   * picked via the native `route_action` tool. The planner loop's text-mode
   * parser (`parseJsonPlannerOutput` → `normalizeBarePlannerAction`) consumes
   * this bare shape directly, so no core change is needed.
   */
  route(body: string): Promise<string> {
    return this.enqueue(() => this.sendOnce(body, "route"));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // Serialize so only one turn is in flight per warm session (the streaming
    // generator is a single conversation, and pendingDecision is shared).
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async sendOnce(body: string, mode: "text" | "route"): Promise<string> {
    if (!body.trim()) {
      throw new Error("[cli-inference:sdk] empty prompt body");
    }
    // Restart the warm session periodically to bound the accumulating window.
    if (this.query && this.turns >= this.restartAfterTurns) {
      await this.dispose();
    }
    if (!this.query) {
      await this.start();
    }
    this.turns += 1;
    try {
      return await this.sendAndRead(body, mode);
    } catch (err) {
      // Self-heal: a dead/erroring session must not poison the next turn.
      await this.dispose();
      throw err instanceof Error ? err : new Error(`[cli-inference:sdk] ${String(err)}`);
    }
  }

  private async start(): Promise<void> {
    const sdk = this.sdkOverride ?? (await loadSdk());
    // A pull-based async generator the SDK drains; we push the next user message
    // into it via `this.feed`.
    const queue: SdkUserMessage[] = [];
    let resolveWaiter: ((m: SdkUserMessage) => void) | null = null;
    this.feed = (msg) => {
      if (resolveWaiter) {
        const r = resolveWaiter;
        resolveWaiter = null;
        r(msg);
      } else {
        queue.push(msg);
      }
    };
    async function* promptStream(): AsyncIterable<SdkUserMessage> {
      while (true) {
        const next: SdkUserMessage = queue.length
          ? (queue.shift() as SdkUserMessage)
          : await new Promise<SdkUserMessage>((res) => {
              resolveWaiter = res;
            });
        yield next;
      }
    }
    const options: Record<string, unknown> = {
      model: this.model,
      settingSources: [],
      permissionMode: "bypassPermissions",
      // `bypassPermissions` is the SDK's documented companion to skipping the
      // permission prompt; pass the explicit flag so the contract is stable
      // across SDK versions rather than relying on the mode alone.
      allowDangerouslySkipPermissions: true,
      // ROUTE: one tool call ends the turn (subtype=error_max_turns is normal).
      // TEXT: default 1 — a one-shot answer leaves no room for the agentic
      // "I'll fetch it…" preamble-then-act pattern that leaks when maxTurns>1.
      maxTurns: this.router ? 1 : this.textMaxTurns,
    };
    if (this.subprocessEnv) {
      options.env = this.subprocessEnv;
    }
    if (this.systemPrompt) options.systemPrompt = this.systemPrompt;
    if (this.claudeExecutablePath) {
      options.pathToClaudeCodeExecutable = this.claudeExecutablePath;
    }
    if (this.router) {
      const { z } = this.zodOverride ?? (await loadZod());
      const routeTool = sdk.tool(
        "route_action",
        "Pick exactly ONE Eliza action for this turn plus its params, chosen from " +
          "the action menu in the user message. Call this EXACTLY ONCE, then stop — " +
          "produce no other output.",
        { action: z.string(), params: z.record(z.any()) },
        async (args) => {
          if (
            !this.pendingDecision &&
            args &&
            typeof args.action === "string" &&
            args.action.trim()
          ) {
            this.pendingDecision = {
              action: args.action.trim(),
              params:
                args.params && typeof args.params === "object"
                  ? (args.params as Record<string, unknown>)
                  : {},
            };
          }
          return {
            content: [{ type: "text", text: "ACK. Routing recorded. Stop now." }],
          };
        }
      );
      const mcp = sdk.createSdkMcpServer({
        name: "eliza",
        version: "1.0.0",
        tools: [routeTool],
      });
      options.mcpServers = { eliza: mcp };
      options.allowedTools = [ROUTE_TOOL];
      options.tools = [ROUTE_TOOL];
    } else {
      // Pure text generation: NO tools at all. `tools: []` disables the SDK's
      // built-in tool set (matching ROUTE mode, which sets it to the one MCP
      // tool) — `allowedTools: []` alone only filters an otherwise-enabled set,
      // so under `bypassPermissions` the agent could still reach the filesystem
      // / shell. RESPONSE_HANDLER processes untrusted inbound text, so the SDK
      // must be a pure completion engine with no tool surface.
      options.tools = [];
      options.allowedTools = [];
      options.disallowedTools = [];
    }
    this.query = sdk.query({ prompt: promptStream(), options });
    this.iterator = this.query[Symbol.asyncIterator]();
    this.turns = 0;
    logger.debug(
      {
        src: "cli-inference:sdk",
        model: this.model,
        mode: this.router ? "route" : "text",
      },
      "warm Claude Agent SDK session started"
    );
  }

  private async nextWithTurnTimeout(): Promise<IteratorResult<SdkMessage>> {
    const iterator = this.iterator;
    if (!iterator) {
      throw new Error("[cli-inference:sdk] session not started");
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<SdkMessage>>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new ProviderApiError(
                `[cli-inference:sdk] turn timed out after ${this.turnTimeoutMs}ms`,
                { retryable: true }
              )
            );
          }, this.turnTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      if (error instanceof ProviderApiError) {
        await this.dispose();
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Push one user message and read the turn's assistant text + result envelope. */
  private async sendAndRead(body: string, mode: "text" | "route"): Promise<string> {
    if (!this.feed || !this.iterator) {
      throw new Error("[cli-inference:sdk] session not started");
    }
    this.pendingDecision = null;
    this.feed({
      type: "user",
      message: { role: "user", content: body },
      parent_tool_use_id: null,
    });
    let text = "";
    let resultText: string | undefined;
    let resultSubtype: string | undefined;
    let sawResult = false;
    while (true) {
      const { value, done } = await this.nextWithTurnTimeout();
      if (done) {
        // Generator ended WITHOUT a terminating `result` message — the session
        // died mid-turn. Force a restart next turn; `sawResult` stays false so
        // the handlers below fail over instead of trusting partial output.
        this.query = null;
        break;
      }
      const msg = value as SdkMessage;
      if (msg.type === "assistant") {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text" && block.text) text += block.text;
        }
      }
      // `result` marks the clean end of one turn and carries the terminal
      // `subtype` (+ a `result` text the SDK echoes on success).
      if (msg.type === "result") {
        sawResult = true;
        resultSubtype = msg.subtype;
        if (typeof msg.result === "string") resultText = msg.result;
        break;
      }
    }

    if (mode === "route" && this.pendingDecision) {
      // The decision is captured in the MCP handler the moment the model calls
      // route_action — that IS the success signal (the turn then ends
      // subtype=error_max_turns, which is normal). Return it regardless of how
      // the turn terminated, and BEFORE the limit guard below: a validly
      // captured decision must never be discarded because residual preamble
      // text happened to mention limits.
      return JSON.stringify(this.pendingDecision);
    }

    // A dried-up subscription credit ends the turn cleanly but surfaces the
    // limit string as the "answer" — as streamed assistant text and/or as the
    // result-envelope echo. Detect BOTH before either mode returns so it fails
    // over / becomes a graceful rate-limit reply instead of leaking "You've hit
    // your session limit ..." to the user (route mode would otherwise relay it
    // as a REPLY, text mode as the completion). "rate limit" in the thrown
    // message routes it through isRateLimitError.
    const limitEnvelope = [text, resultText ?? ""].find((candidate) =>
      isClaudeSubscriptionLimitMessage(candidate)
    );
    if (sawResult && limitEnvelope !== undefined) {
      throw new Error(
        `[cli-inference:sdk] subscription rate limit reached: ${limitEnvelope.trim().slice(0, 120)}`
      );
    }

    // Same leak shape, different envelope: an upstream API failure ("API
    // Error: 400 messages: text content blocks must be non-empty", 429s, 5xx)
    // is streamed as assistant text and the turn terminates cleanly — without
    // this guard it is returned as the completion and relayed verbatim to the
    // user (observed live 18x). Throw per the failover contract; the message
    // keeps the SDK's status text so isRateLimitError/isAuthError classify
    // 429/401 correctly downstream.
    const apiErrorEnvelope = [text, resultText ?? ""].find((candidate) =>
      isClaudeSdkApiErrorMessage(candidate)
    );
    if (apiErrorEnvelope !== undefined) {
      const parsed = parseProviderApiErrorText(apiErrorEnvelope);
      throw new ProviderApiError(
        `[cli-inference:sdk] upstream ${apiErrorEnvelope.trim().slice(0, 160)}`,
        { statusCode: parsed?.statusCode }
      );
    }

    if (mode === "route") {
      // No decision: the model went off-contract (it was told to call the tool
      // and "produce no plain-text answer"), so any residual text is a planning
      // preamble, not a finished reply — never surface it as a user REPLY. Only
      // accept a genuine terminal answer (a clean `result` with subtype=success)
      // as a REPLY; otherwise throw so the planner loop retries / fails over.
      if (sawResult && resultSubtype === "success") {
        const answer = text.trim() || resultText?.trim();
        if (answer) {
          return JSON.stringify({ action: "REPLY", params: { text: answer } });
        }
      }
      throw new Error(
        `[cli-inference:sdk] route: model emitted no decision (subtype=${resultSubtype ?? "?"})`
      );
    }

    // TEXT mode: trust the streamed assistant text only when the turn TERMINATED
    // CLEANLY (a `result` message arrived). A generator that ended without one
    // means the session died mid-stream, so partial text is a truncated reply —
    // throw instead of surfacing it. The streamed text is the model's real
    // output regardless of subtype; the `result` echo is only trustworthy on
    // success (on error_max_turns it may be an SDK meta-string like "Reached
    // maximum turns", not the completion).
    if (sawResult && text.trim()) return text.trim();
    if (sawResult && resultSubtype === "success" && resultText?.trim()) {
      return resultText.trim();
    }
    // No trustworthy text: THROW so useModel / AccountPool fails over, per the
    // plugin's throw-to-failover contract — never return partial/meta output.
    throw new Error(
      `[cli-inference:sdk] empty completion (subtype=${resultSubtype ?? (sawResult ? "?" : "session-ended")})`
    );
  }

  /** Tear down the warm session (on restart, error, or dispose). */
  async dispose(): Promise<void> {
    const q = this.query;
    this.query = null;
    this.iterator = null;
    this.feed = null;
    this.turns = 0;
    this.pendingDecision = null;
    if (q?.interrupt) {
      try {
        await q.interrupt();
      } catch {
        // best-effort
      }
    }
  }
}
