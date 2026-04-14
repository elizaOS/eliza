/**
 * PTY session spawning logic — extracted from PTYService for maintainability.
 *
 * Contains the deferred task delivery, retry logic, per-agent settle delays,
 * and session buffer setup that runs during spawnSession().
 *
 * @module services/pty-spawn
 */

import type { AdapterType, BaseCodingAdapter } from "coding-agent-adapters";
import type {
  BunCompatiblePTYManager,
  PTYManager,
  SessionHandle,
  SpawnConfig,
  WorkerSessionHandle,
} from "pty-manager";
import type {
  PTYServiceConfig,
  SessionInfo,
  SpawnSessionOptions,
} from "./pty-types.ts";
import { cleanForChat } from "./ansi-utils.ts";

/**
 * System environment variables safe to pass to spawned agents.
 * Everything else (API keys, tokens, cloud credentials) is stripped.
 */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "TZ",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "NODE_OPTIONS",
  "BUN_INSTALL",
  // Forward the user's preferred Claude model so spawned `claude` inherits it
  // (claude-cli reads ANTHROPIC_MODEL on startup). Without this, the subagent
  // falls back to its default sonnet even when the parent runtime is on opus.
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
];

/**
 * Build a sanitized base environment from process.env, keeping only
 * safe system variables. Agent-specific credentials are injected
 * separately by the adapter's getEnv().
 */
export function buildSanitizedBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const val = process.env[key];
    if (val) env[key] = val;
  }
  if (!env.TERM || env.TERM.toLowerCase() === "dumb") {
    env.TERM = "xterm-256color";
  }
  if (!env.COLORTERM) {
    env.COLORTERM = "truecolor";
  }
  return env;
}

export interface SpawnContext {
  manager: PTYManager | BunCompatiblePTYManager;
  usingBunWorker: boolean;
  serviceConfig: PTYServiceConfig;
  sessionMetadata: Map<string, Record<string, unknown>>;
  sessionWorkdirs: Map<string, string>;
  sessionOutputBuffers: Map<string, string[]>;
  outputUnsubscribers: Map<string, () => void>;
  taskResponseMarkers: Map<string, number>;
  getAdapter: (agentType: AdapterType) => BaseCodingAdapter;
  sendToSession: (sessionId: string, input: string) => Promise<unknown>;
  sendKeysToSession: (
    sessionId: string,
    keys: string | string[],
  ) => Promise<void>;
  writeRawToSession: (sessionId: string, data: string) => Promise<void>;
  pushDefaultRules: (sessionId: string, agentType: string) => Promise<void>;
  toSessionInfo: (
    session: SessionHandle | WorkerSessionHandle,
    workdir?: string,
  ) => SessionInfo;
  log: (msg: string) => void;
  /** Mark a session's task as delivered in the coordinator. */
  markTaskDelivered: (sessionId: string) => void;
}

const CURSOR_POSITION_QUERY = "\x1b[6n";
const CURSOR_POSITION_RESPONSE = "\x1b[1;1R";

async function maybeRespondToTerminalQueries(
  ctx: SpawnContext,
  sessionId: string,
  data: string,
): Promise<void> {
  if (!data.includes(CURSOR_POSITION_QUERY)) {
    return;
  }
  try {
    await ctx.writeRawToSession(sessionId, CURSOR_POSITION_RESPONSE);
    ctx.log(`Session ${sessionId} — answered terminal cursor-position query`);
  } catch (error) {
    ctx.log(
      `Session ${sessionId} — failed to answer terminal cursor-position query: ${error}`,
    );
  }
}

/**
 * Set up session output buffering for Bun worker path.
 */
export function setupOutputBuffer(ctx: SpawnContext, sessionId: string): void {
  const buffer: string[] = [];
  ctx.sessionOutputBuffers.set(sessionId, buffer);
  const unsubscribe = (ctx.manager as BunCompatiblePTYManager).onSessionData(
    sessionId,
    (data: string) => {
      void maybeRespondToTerminalQueries(ctx, sessionId, data);
      const lines = data.split("\n");
      buffer.push(...lines);
      while (buffer.length > (ctx.serviceConfig.maxLogLines ?? 1000)) {
        buffer.shift();
      }
    },
  );
  ctx.outputUnsubscribers.set(sessionId, unsubscribe);
}

/**
 * Set up deferred task delivery with retry logic.
 * IMPORTANT: Must be called BEFORE pushDefaultRules (which has a 1500ms sleep),
 * otherwise session_ready fires during pushDefaultRules and the listener misses it.
 */
export function setupDeferredTaskDelivery(
  ctx: SpawnContext,
  session: SessionHandle | WorkerSessionHandle,
  task: string,
  agentType: string,
): void {
  const sid = session.id;
  // Per-agent post-ready delay. Claude Code has a heavy TUI that
  // renders update notices, shortcuts, and /ide hints in bursts after
  // the initial ready pattern — 300ms isn't enough to clear them all.
  const POST_READY_DELAY: Record<string, number> = {
    claude: 800,
    gemini: 300,
    codex: 300,
    aider: 200,
  };
  const settleMs = POST_READY_DELAY[agentType] ?? 300;
  const MIN_NEW_LINES_BY_AGENT: Record<string, number> = {
    claude: 1,
    gemini: 10,
    codex: 15,
    aider: 8,
  };

  const VERIFY_DELAY_MS = 5000; // how long to wait before checking acceptance
  const MAX_RETRIES = 2;
  const minNewLines = MIN_NEW_LINES_BY_AGENT[agentType] ?? 15;
  const READY_PROBE_INTERVAL_MS = 500;
  const isAdapterBackedAgent =
    agentType === "claude" ||
    agentType === "gemini" ||
    agentType === "codex" ||
    agentType === "aider";
  const adapter = isAdapterBackedAgent
    ? ctx.getAdapter(agentType as AdapterType)
    : null;

  const sendTaskWithRetry = (attempt: number) => {
    const buffer = ctx.sessionOutputBuffers.get(sid);
    const baselineLength = buffer?.length ?? 0;

    ctx.log(
      `Session ${sid} — sending task (attempt ${attempt + 1}, ${settleMs}ms settle, baseline ${baselineLength} lines)`,
    );

    ctx
      .sendToSession(sid, task)
      .catch((err) =>
        ctx.log(`Failed to send deferred task to ${sid}: ${err}`),
      );

    // After a delay, verify the agent actually started working.
    // If the buffer barely grew, the TUI likely swallowed the input.
    if (attempt < MAX_RETRIES) {
      setTimeout(() => {
        const currentLength = buffer?.length ?? 0;
        const newLines = currentLength - baselineLength;
        const newOutput = buffer?.slice(baselineLength).join("\n") ?? "";
        const accepted =
          newLines > 0 ||
          newLines >= minNewLines ||
          (adapter?.detectLoading?.(newOutput) ?? false) ||
          cleanForChat(newOutput).length >= 32;
        if (!accepted) {
          ctx.log(
            `Session ${sid} — task may not have been accepted (only ${newLines} new lines after ${VERIFY_DELAY_MS}ms). Retrying (attempt ${attempt + 2}/${MAX_RETRIES + 1})`,
          );
          sendTaskWithRetry(attempt + 1);
        } else {
          ctx.log(
            `Session ${sid} — task accepted (${newLines} new lines after ${VERIFY_DELAY_MS}ms)`,
          );
        }
      }, VERIFY_DELAY_MS);
    }
  };

  const READY_TIMEOUT_MS = 30_000;
  let taskSent = false;
  let taskDeliveredMarked = false;
  let readyTimeout: ReturnType<typeof setTimeout> | undefined;
  let readyProbe: ReturnType<typeof setInterval> | undefined;
  const clearPendingReadyWait = () => {
    if (readyTimeout) {
      clearTimeout(readyTimeout);
      readyTimeout = undefined;
    }
    if (readyProbe) {
      clearInterval(readyProbe);
      readyProbe = undefined;
    }
  };
  const sendTask = () => {
    if (taskSent) return;
    taskSent = true;
    clearPendingReadyWait();
    // Delay to let TUI finish rendering after ready detection.
    // Without this, Claude Code's TUI can swallow the Enter key
    // if it arrives during a render cycle.
    setTimeout(() => {
      if (!taskDeliveredMarked) {
        ctx.markTaskDelivered(sid);
        taskDeliveredMarked = true;
      }
      sendTaskWithRetry(0);
    }, settleMs);
    if (ctx.usingBunWorker) {
      (ctx.manager as BunCompatiblePTYManager).removeListener(
        "session_ready",
        onReady,
      );
    } else {
      (ctx.manager as PTYManager).removeListener("session_ready", onReady);
    }
  };
  const onReady = (readySession: WorkerSessionHandle | SessionHandle) => {
    if (readySession.id !== sid) return;
    sendTask();
  };

  if (session.status === "ready") {
    sendTask();
  } else {
    if (ctx.usingBunWorker) {
      (ctx.manager as BunCompatiblePTYManager).on("session_ready", onReady);
    } else {
      (ctx.manager as PTYManager).on("session_ready", onReady);
    }
    readyTimeout = setTimeout(() => {
      if (!taskSent) {
        ctx.log(
          `Session ${sid} — ready event not received within ${READY_TIMEOUT_MS}ms, forcing task delivery`,
        );
        sendTask();
      }
    }, READY_TIMEOUT_MS);

    if (ctx.usingBunWorker && isAdapterBackedAgent && adapter) {
      readyProbe = setInterval(() => {
        if (taskSent) return;
        const buffer = ctx.sessionOutputBuffers.get(sid);
        if (!buffer || buffer.length === 0) return;
        const output = buffer.join("\n");
        const cleanedOutput = cleanForChat(output);
        if (adapter.detectLoading?.(output)) return;
        if (adapter.detectLogin(output).required) return;
        if (adapter.detectBlockingPrompt(output).detected) return;
        const promptVisible =
          adapter.detectReady(output) ||
          (agentType === "codex" &&
            /›\s+(?:Ask Codex to do anything|\S.*)/.test(cleanedOutput));
        if (!promptVisible) return;
        ctx.log(
          `Session ${sid} — detected ready prompt from buffered output, delivering task before timeout`,
        );
        sendTask();
      }, READY_PROBE_INTERVAL_MS);
    }
  }
}

/**
 * Build the SpawnConfig and env vars from SpawnSessionOptions.
 */
export function buildSpawnConfig(
  sessionId: string,
  options: SpawnSessionOptions,
  workdir: string,
): SpawnConfig & { id: string } {
  // Map model preferences to adapter-specific env vars
  const modelPrefs = options.metadata?.modelPrefs as
    | { powerful?: string; fast?: string }
    | undefined;
  let modelEnv: Record<string, string> | undefined;
  if (modelPrefs?.powerful) {
    const envKeyMap: Record<string, string> = {
      claude: "ANTHROPIC_MODEL",
      gemini: "GEMINI_MODEL",
      codex: "OPENAI_MODEL",
      aider: "AIDER_MODEL",
    };
    const key = envKeyMap[options.agentType];
    if (key) modelEnv = { [key]: modelPrefs.powerful };
  }

  return {
    id: sessionId,
    name: options.name,
    type: options.agentType,
    workdir,
    inheritProcessEnv: false,
    env: {
      ...buildSanitizedBaseEnv(),
      ...options.env,
      ...modelEnv,
      PARALLAX_SESSION_ID: sessionId,
    },
    ...(options.skipAdapterAutoResponse
      ? { skipAdapterAutoResponse: true }
      : {}),
    adapterConfig: {
      ...(options.credentials as Record<string, unknown> | undefined),
      ...(options.customCredentials
        ? { custom: options.customCredentials }
        : {}),
      interactive: true,
      approvalPreset: options.approvalPreset,
      // Forward adapter-relevant metadata (e.g. provider preference for Aider)
      ...(options.metadata?.provider
        ? { provider: options.metadata.provider }
        : {}),
      ...(options.metadata?.modelTier
        ? { modelTier: options.metadata.modelTier }
        : {}),
    },
  };
}
