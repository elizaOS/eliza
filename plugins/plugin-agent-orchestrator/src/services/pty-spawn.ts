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
import { cleanForChat } from "./ansi-utils.js";
import type {
  PTYServiceConfig,
  SessionInfo,
  SpawnSessionOptions,
} from "./pty-types.js";
import { readTaskAgentModelPrefs } from "./task-agent-frameworks.js";

const CODEX_UPDATE_RULE_PATTERN_SOURCE =
  "update.?available.*->|update.?now|skip.?until.?next.?version";
const CODEX_TRUST_RULE_PATTERN_SOURCE =
  "do.?you.?trust.?the.?contents|trust.?this.?directory|yes,?.?continue|prompt.?injection";
const CODEX_KEEP_CURRENT_MODEL_NEVER_RULE_PATTERN_SOURCE =
  "keep\\s+current\\s+model\\s*\\(never\\s+show\\s+again\\)|hide\\s+future\\s+rate\\s+limit\\s+reminders\\s+about\\s+switching\\s+models";
const CODEX_KEEP_CURRENT_MODEL_RULE_PATTERN_SOURCE =
  "keep\\s+current\\s+model[\\s\\S]*(?:efficient\\s+model|less\\s+capable|faster|rate\\s+limit|switching\\s+models)|(?:efficient\\s+model|less\\s+capable|faster|rate\\s+limit|switching\\s+models)[\\s\\S]*keep\\s+current\\s+model";

const CODEX_ADAPTER_RULE_OVERRIDES: NonNullable<SpawnConfig["ruleOverrides"]> =
  {
    [CODEX_UPDATE_RULE_PATTERN_SOURCE]: {
      response: "",
      responseType: "keys",
      keys: ["2", "enter"],
      description: 'Skip Codex CLI update prompt (option 2: "Skip")',
      once: true,
    },
    [CODEX_KEEP_CURRENT_MODEL_NEVER_RULE_PATTERN_SOURCE]: {
      response: "",
      responseType: "keys",
      keys: ["3", "enter"],
      description:
        "Keep the current Codex model and hide future model-switch reminders",
    },
    [CODEX_KEEP_CURRENT_MODEL_RULE_PATTERN_SOURCE]: {
      response: "",
      responseType: "keys",
      keys: ["2", "enter"],
      description:
        "Keep the current Codex model when a routine model-switch reminder appears",
    },
    [CODEX_TRUST_RULE_PATTERN_SOURCE]: {
      response: "",
      responseType: "keys",
      keys: ["1", "enter"],
      description: 'Trust Codex workspace prompt (option 1: "Yes, continue")',
      once: true,
    },
  };

/**
 * Inspect a chunk of session output for auth-related failure signatures.
 * Returns the kind of failure detected (or null) so the caller can mark
 * the supplied `accountId` via the pool. Pattern matching is best-effort
 * and intentionally narrow: we only flag accounts when we're confident
 * the subprocess saw a real auth error.
 */
export function detectAuthFailureKind(
  data: string,
): "rate-limited" | "invalid" | "needs-reauth" | null {
  if (!data) return null;
  if (/\binvalid_grant\b/i.test(data)) return "needs-reauth";
  if (/\b401\b|\bunauthorized\b/i.test(data)) return "invalid";
  if (/rate[\s_-]*limit/i.test(data) || /\b429\b/.test(data)) {
    return "rate-limited";
  }
  return null;
}

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
  "LD_LIBRARY_PATH",
  "ANDROID_ROOT",
  "ANDROID_DATA",
  "ANDROID_STORAGE",
  "ANDROID_ART_ROOT",
  "ANDROID_I18N_ROOT",
  "ANDROID_TZDATA_ROOT",
  "EXTERNAL_STORAGE",
  "ELIZA_PLATFORM",
  "ELIZA_LOCAL_LLAMA",
  "ELIZA_AOSP_BUILD",
  "ELIZA_RUNTIME_MODE",
  "RUNTIME_MODE",
  "LOCAL_RUNTIME_MODE",
  "ELIZA_STATE_DIR",
  "MILADY_STATE_DIR",
  "SHELL_ALLOWED_DIRECTORY",
  "CODING_TOOLS_SHELL",
  "CODING_TOOLS_WORKSPACE_ROOTS",
  // Forward the user's preferred Claude model so spawned `claude` inherits it
  // (claude-cli reads ANTHROPIC_MODEL on startup). Without this, the subagent
  // falls back to its default sonnet even when the parent runtime is on opus.
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  // Forward the user's GitHub PAT to spawned agents so `git`, `gh`, and
  // `curl` against the GitHub API all work without each adapter having to
  // know about the on-disk credential file. The token is opt-in: it only
  // appears in process.env when the user has saved it through the host's
  // GitHub connection card (or set it explicitly via shell), so passthrough
  // here matches an explicit user grant rather than blanket leakage.
  "GITHUB_TOKEN",
  "GH_TOKEN",
  // Container app builds may need opt-in registry credentials/config before
  // Cloud can pull an image. These are forwarded only when the parent runtime
  // explicitly provides them.
  "GHCR_TOKEN",
  "CR_PAT",
  "ELIZA_APP_IMAGE_REGISTRY",
  "ELIZA_APP_IMAGE_NAMESPACE",
  "ELIZA_APP_IMAGE_REPOSITORY",
  // Cloud app builds need the parent-provided Cloud endpoint and API key to
  // register apps, enable monetization, and prepare domain offers.
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZA_CLOUD_BASE_URL",
  "ELIZA_CLOUD_PUBLIC_URL",
  "ELIZA_CLOUD_URL",
  "ELIZA_AFFILIATE_CODE",
];

/**
 * Build a sanitized base environment from process.env, keeping only
 * safe system variables. Agent-specific credentials are injected
 * separately by the adapter's getEnv().
 *
 * On Windows, the sanitized env may have lost the per-package-manager bin
 * directories that hold `claude.cmd` / `codex.cmd` (npm global, Codex
 * managed install, scoop shims, chocolatey bin). Route through
 * `appendWindowsPathFallbacks` to add those back after the allowlist copy.
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
  const mergedPath = appendWindowsPathFallbacks(env.PATH);
  if (mergedPath) {
    env.PATH = mergedPath;
  }
  return env;
}

/**
 * Directories that Windows package managers drop `claude.cmd` / `codex.cmd`
 * / `codex.exe` into. We append these to the sanitized PATH so `cmd.exe`
 * (via the `shell: true` flag on execFile/spawn for win32) can resolve the
 * CLI binaries even when the user's PATH has been stripped down by the
 * ENV_ALLOWLIST-then-systemd-unit chain or otherwise missing the install
 * location. Each entry is a no-op on non-Windows and a no-op when the
 * parent env var the path depends on is unset.
 *
 * Coverage, in order of popularity for claude/codex installs:
 *   - npm global (%APPDATA%\npm) — the official CLAUDE_CODE install path
 *   - Codex managed install (%LOCALAPPDATA%\OpenAI\Codex\bin)
 *   - Scoop (%USERPROFILE%\scoop\shims)
 *   - Chocolatey (%ProgramData%\chocolatey\bin)
 *   - Bun global (%USERPROFILE%\.bun\bin)
 */
export function getWindowsPathFallbacks(): string[] {
  if (process.platform !== "win32") return [];
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  const programData = process.env.ProgramData ?? process.env.PROGRAMDATA;
  const candidates: (string | undefined)[] = [
    appData ? `${appData}\\npm` : undefined,
    localAppData ? `${localAppData}\\OpenAI\\Codex\\bin` : undefined,
    userProfile ? `${userProfile}\\scoop\\shims` : undefined,
    programData ? `${programData}\\chocolatey\\bin` : undefined,
    userProfile ? `${userProfile}\\.bun\\bin` : undefined,
  ];
  return candidates.filter((v): v is string => !!v && v.trim().length > 0);
}

/**
 * Append each fallback path to `currentPath` if it isn't already present.
 * Windows PATH matching is case-insensitive, so dedupe on the lowercased
 * form but preserve the original casing in the output. Returns `undefined`
 * when the resulting PATH would be empty (neither argument had content), so
 * callers can skip assigning an empty string.
 */
export function appendWindowsPathFallbacks(
  currentPath: string | undefined,
): string | undefined {
  return mergePathEntries(currentPath, getWindowsPathFallbacks(), {
    delimiter: process.platform === "win32" ? ";" : ":",
    caseInsensitive: process.platform === "win32",
  });
}

/**
 * Pure PATH-merge helper: dedupe existing + extras, preserve insertion
 * order and casing. Exported for unit tests so we can exercise the merge
 * logic without stubbing `process.platform`.
 */
export function mergePathEntries(
  currentPath: string | undefined,
  extras: readonly string[],
  opts: { delimiter: string; caseInsensitive: boolean },
): string | undefined {
  const normalize = (v: string) => (opts.caseInsensitive ? v.toLowerCase() : v);
  const existing = (currentPath ?? "")
    .split(opts.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const seen = new Set(existing.map(normalize));
  const merged: string[] = [...existing];
  for (const extra of extras) {
    const key = normalize(extra);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(extra);
  }
  return merged.length > 0 ? merged.join(opts.delimiter) : undefined;
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

export function shouldUseCodexExecMode(options: {
  agentType: string;
  initialTask?: string;
}): boolean {
  return options.agentType === "codex" && Boolean(options.initialTask?.trim());
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
    codex: 2000,
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
  const MAX_RETRIES = agentType === "codex" ? 0 : 2;
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
  const codexExecMode = shouldUseCodexExecMode(options);
  const codexExecOutputFile =
    typeof options.metadata?.codexExecOutputFile === "string" &&
    options.metadata.codexExecOutputFile.trim()
      ? options.metadata.codexExecOutputFile.trim()
      : undefined;

  // Map model preferences to adapter-specific env vars
  const modelPrefs = readTaskAgentModelPrefs(options.metadata?.modelPrefs);
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
    ...(options.agentType === "codex"
      ? { ruleOverrides: CODEX_ADAPTER_RULE_OVERRIDES }
      : {}),
    adapterConfig: {
      ...(options.credentials as Record<string, unknown> | undefined),
      ...(options.customCredentials
        ? { custom: options.customCredentials }
        : {}),
      interactive: !codexExecMode,
      ...(codexExecMode
        ? {
            initialPrompt: options.initialTask?.trim(),
            skipGitRepoCheck: true,
            ...(codexExecOutputFile
              ? { outputLastMessage: codexExecOutputFile }
              : {}),
          }
        : {}),
      approvalPreset:
        options.agentType === "codex" && !codexExecMode
          ? undefined
          : options.approvalPreset,
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
