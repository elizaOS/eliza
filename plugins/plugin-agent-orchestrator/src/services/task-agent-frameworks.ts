/**
 * Task-agent framework discovery and preference resolution.
 *
 * Detects installed CLIs, available auth, and Eliza subscription preferences so
 * the orchestrator can choose the best framework when the caller does not
 * specify one explicitly.
 *
 * @module services/task-agent-frameworks
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import type { PreflightResult } from "coding-agent-adapters";
import type { AgentMetrics } from "./agent-metrics.js";
import {
  readConfigCloudKey,
  readConfigCodexSubscriptionRestrictedToCodexFramework,
  readConfigEnvKey,
} from "./config-env.js";

export type SupportedTaskAgentAdapter = "claude" | "codex" | "gemini" | "aider";
export type TaskAgentFrameworkId =
  | SupportedTaskAgentAdapter
  | "pi"
  | "opencode";

export interface TaskAgentModelPrefs {
  powerful?: string;
  fast?: string;
}

export interface TaskAgentFrameworkAvailability {
  id: TaskAgentFrameworkId;
  label: string;
  installed: boolean;
  authReady: boolean;
  subscriptionReady: boolean;
  temporarilyDisabled: boolean;
  temporarilyDisabledUntil?: number;
  temporarilyDisabledReason?: string;
  recommended: boolean;
  reason: string;
  installCommand?: string;
  docsUrl?: string;
  selectionScore?: number;
  selectionSignals?: Record<string, number>;
}

export interface PreferredTaskAgent {
  id: TaskAgentFrameworkId;
  reason: string;
}

export interface TaskAgentFrameworkState {
  configuredSubscriptionProvider?: string;
  frameworks: TaskAgentFrameworkAvailability[];
  preferred: PreferredTaskAgent;
}

export interface TaskAgentFrameworkProbe {
  checkAvailableAgents?: (
    types?: SupportedTaskAgentAdapter[],
  ) => Promise<PreflightResult[]>;
  getAgentMetrics?: () => Record<
    string,
    Omit<AgentMetrics, "totalCompletionMs">
  >;
}

export type TaskAgentTaskKind =
  | "coding"
  | "research"
  | "planning"
  | "ops"
  | "mixed";

export interface TaskAgentTaskProfileInput {
  task?: string;
  repo?: string;
  workdir?: string;
  threadKind?: TaskAgentTaskKind;
  subtaskCount?: number;
  acceptanceCriteria?: string[];
}

export interface TaskAgentTaskProfile {
  text: string;
  kind: TaskAgentTaskKind;
  subtaskCount: number;
  repoPresent: boolean;
  signals: {
    implementation: number;
    research: number;
    planning: number;
    ops: number;
    verification: number;
    coordination: number;
    repoWork: number;
    fastIteration: number;
  };
}

interface FrameworkCapabilityProfile {
  implementation: number;
  research: number;
  planning: number;
  ops: number;
  verification: number;
  coordination: number;
  repoWork: number;
  fastIteration: number;
}

const RESEARCH_SIGNAL_RE =
  /\b(research|investigate|analy[sz]e|analysis|compare|evaluate|review|study|summari[sz]e|deep research|look into|explore)\b/i;
const PLANNING_SIGNAL_RE =
  /\b(plan|planning|roadmap|strategy|spec|architecture|design|scope|milestone|sequence|timeline)\b/i;
const OPS_SIGNAL_RE =
  /\b(deploy|release|ship|rollback|monitor|incident|infra|infrastructure|configure|setup|docker|kubernetes|ci|cd|runbook)\b/i;
const IMPLEMENTATION_SIGNAL_RE =
  /\b(code|coding|implement|fix|debug|refactor|write|build|patch|feature|server|api|component|function|typescrip?t|javascript|react)\b/i;
const VERIFICATION_SIGNAL_RE =
  /\b(test|tests|verify|validation|prove|acceptance|check|regression|benchmark|lint|typecheck|qa)\b/i;
const COORDINATION_SIGNAL_RE =
  /\b(parallel|delegate|subagent|sub-agent|swarm|coordinate|coordination|handoff|mailbox|scheduler|orchestrate)\b/i;
const REPO_SIGNAL_RE =
  /\b(repo|repository|branch|commit|pull request|pr|diff|workspace|file|directory|codebase)\b/i;
const FAST_ITERATION_SIGNAL_RE =
  /\b(fix|debug|patch|flaky|quick|fast|iterate|loop|unblock|repair)\b/i;

const FRAMEWORK_CAPABILITY_PROFILES: Record<
  TaskAgentFrameworkId,
  FrameworkCapabilityProfile
> = {
  claude: {
    implementation: 0.95,
    research: 0.95,
    planning: 1,
    ops: 0.8,
    verification: 0.85,
    coordination: 1,
    repoWork: 0.9,
    fastIteration: 0.75,
  },
  codex: {
    implementation: 1,
    research: 0.8,
    planning: 0.75,
    ops: 0.85,
    verification: 1,
    coordination: 0.9,
    repoWork: 1,
    fastIteration: 0.95,
  },
  gemini: {
    implementation: 0.7,
    research: 1,
    planning: 0.95,
    ops: 0.7,
    verification: 0.6,
    coordination: 0.7,
    repoWork: 0.65,
    fastIteration: 0.7,
  },
  aider: {
    implementation: 0.9,
    research: 0.45,
    planning: 0.45,
    ops: 0.75,
    verification: 0.85,
    coordination: 0.35,
    repoWork: 0.95,
    fastIteration: 1,
  },
  pi: {
    implementation: 0.55,
    research: 0.5,
    planning: 0.55,
    ops: 0.5,
    verification: 0.5,
    coordination: 0.35,
    repoWork: 0.5,
    fastIteration: 0.5,
  },
  opencode: {
    implementation: 0.85,
    research: 0.75,
    planning: 0.75,
    ops: 0.7,
    verification: 0.8,
    coordination: 0.7,
    repoWork: 0.85,
    fastIteration: 0.85,
  },
};

const FRAMEWORK_LABELS: Record<TaskAgentFrameworkId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  aider: "Aider",
  pi: "Pi",
  opencode: "OpenCode",
};

const STANDARD_FRAMEWORKS: SupportedTaskAgentAdapter[] = [
  "claude",
  "codex",
  "gemini",
  "aider",
];

const DEFAULT_FRAMEWORK_PREFLIGHT_TIMEOUT_MS = 5_000;

function resolveFrameworkPreflightTimeoutMs(): number {
  const raw = process.env.PARALLAX_FRAMEWORK_PREFLIGHT_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_FRAMEWORK_PREFLIGHT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 250
    ? parsed
    : DEFAULT_FRAMEWORK_PREFLIGHT_TIMEOUT_MS;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const TASK_AGENT_MODEL_PREF_SETTING_KEYS: Record<
  SupportedTaskAgentAdapter | "opencode",
  { powerful: string; fast: string }
> = {
  claude: {
    powerful: "PARALLAX_CLAUDE_MODEL_POWERFUL",
    fast: "PARALLAX_CLAUDE_MODEL_FAST",
  },
  codex: {
    powerful: "PARALLAX_CODEX_MODEL_POWERFUL",
    fast: "PARALLAX_CODEX_MODEL_FAST",
  },
  gemini: {
    powerful: "PARALLAX_GEMINI_MODEL_POWERFUL",
    fast: "PARALLAX_GEMINI_MODEL_FAST",
  },
  aider: {
    powerful: "PARALLAX_AIDER_MODEL_POWERFUL",
    fast: "PARALLAX_AIDER_MODEL_FAST",
  },
  opencode: {
    powerful: "PARALLAX_OPENCODE_MODEL_POWERFUL",
    fast: "PARALLAX_OPENCODE_MODEL_FAST",
  },
};

export const TASK_AGENT_DEFAULT_MODEL_PREFS: Record<
  SupportedTaskAgentAdapter | "opencode",
  TaskAgentModelPrefs
> = {
  claude: { powerful: "claude-opus-4-7" },
  codex: { powerful: "gpt-5.5", fast: "gpt-5.4-mini" },
  gemini: {},
  aider: {},
  opencode: {},
};

const TASK_AGENT_COMPLEXITY_RE =
  /\b(repo|repository|code|coding|debug|fix|implement|investigate|research|analyze|analysis|summarize|summary|write|draft|document|plan|workflow|automation|parallel|delegate|subtask|agent|orchestrate|coordinate|compare|test|tests|pull request|pr\b|branch|commit)\b/i;

let frameworkStateCache:
  | {
      expiresAt: number;
      value: {
        configuredSubscriptionProvider?: string;
        frameworks: TaskAgentFrameworkAvailability[];
      };
    }
  | undefined;
const frameworkCooldowns = new Map<
  SupportedTaskAgentAdapter,
  { until: number; reason: string }
>();
const TASK_AGENT_USAGE_EXHAUSTED_RE =
  /\b(insufficient(?:[_\s]+(?:credits?|quota))|insufficient_quota|out of credits|credit balance|usage (?:has )?(?:reached|exceeded)|(?:you(?:'ve| have)? hit your usage limits?)|usage[-\s]?limits?|quota exceeded|payment required|status(?:code)?[:\s]*402)\b/i;

function normalizePreflightAdapterId(
  value: string | undefined,
): SupportedTaskAgentAdapter | null {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "claude":
    case "claude code":
      return "claude";
    case "codex":
    case "openai codex":
      return "codex";
    case "gemini":
    case "gemini cli":
      return "gemini";
    case "aider":
      return "aider";
    default:
      return null;
  }
}

function safeGetSetting(
  runtime: IAgentRuntime | undefined,
  key: string,
): string | undefined {
  // Check the config file first (UI writes here, takes effect without restart),
  // then fall back to runtime/character settings.
  try {
    const fromConfig = readConfigEnvKey(key);
    if (fromConfig?.trim()) return fromConfig.trim();
  } catch {
    // ignore — fall through to runtime
  }
  if (!runtime) return undefined;
  try {
    const value = runtime.getSetting(key);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function trimModelPref(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readTaskAgentModelPrefs(
  value: unknown,
): TaskAgentModelPrefs | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return compactTaskAgentModelPrefs({
    powerful: trimModelPref(record.powerful),
    fast: trimModelPref(record.fast),
  });
}

function compactTaskAgentModelPrefs(
  prefs: TaskAgentModelPrefs | undefined,
): TaskAgentModelPrefs | undefined {
  const powerful = trimModelPref(prefs?.powerful);
  const fast = trimModelPref(prefs?.fast);
  if (!powerful && !fast) return undefined;
  return {
    ...(powerful ? { powerful } : {}),
    ...(fast ? { fast } : {}),
  };
}

export function mergeTaskAgentModelPrefs(
  ...prefs: Array<TaskAgentModelPrefs | undefined>
): TaskAgentModelPrefs | undefined {
  let merged: TaskAgentModelPrefs | undefined;
  for (const pref of prefs) {
    const compact = compactTaskAgentModelPrefs(pref);
    if (!compact) continue;
    merged = { ...merged, ...compact };
  }
  return compactTaskAgentModelPrefs(merged);
}

function normalizeTaskAgentAdapterForModelPrefs(
  agentType: string | undefined,
): SupportedTaskAgentAdapter | "opencode" | undefined {
  const normalized = agentType?.trim().toLowerCase();
  switch (normalized) {
    case "claude":
    case "claude-code":
    case "claude code":
      return "claude";
    case "codex":
    case "openai":
    case "openai-codex":
    case "openai codex":
      return "codex";
    case "opencode":
    case "open-code":
    case "open code":
      return "opencode";
    case "gemini":
    case "google":
    case "gemini-cli":
    case "gemini cli":
      return "gemini";
    case "aider":
      return "aider";
    default:
      return undefined;
  }
}

export function getTaskAgentModelPrefs(
  runtime: IAgentRuntime | undefined,
  agentType: string | undefined,
  spawnPrefs?: TaskAgentModelPrefs,
): TaskAgentModelPrefs | undefined {
  const adapter = normalizeTaskAgentAdapterForModelPrefs(agentType);
  if (!adapter) return undefined;

  const keys = TASK_AGENT_MODEL_PREF_SETTING_KEYS[adapter];
  const runtimePrefs = compactTaskAgentModelPrefs({
    powerful: safeGetSetting(runtime, keys.powerful),
    fast: safeGetSetting(runtime, keys.fast),
  });

  return mergeTaskAgentModelPrefs(
    TASK_AGENT_DEFAULT_MODEL_PREFS[adapter],
    spawnPrefs,
    runtimePrefs,
  );
}

function getPreflightAuthStatus(
  result: PreflightResult | undefined,
): "authenticated" | "unauthenticated" | "unknown" {
  const auth =
    result && typeof result === "object"
      ? ((result as unknown as Record<string, unknown>).auth as
          | Record<string, unknown>
          | undefined)
      : undefined;
  const status = typeof auth?.status === "string" ? auth.status : "";
  if (status === "authenticated" || status === "unauthenticated") {
    return status;
  }
  return "unknown";
}

function getUserHomeDir(): string {
  return (
    process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir()
  );
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function extractOauthAccessToken(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const direct = record.accessToken ?? record.access_token;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  for (const nested of Object.values(record)) {
    const token = extractOauthAccessToken(nested);
    if (token) return token;
  }
  return;
}

function resolveElizaConfigPath(): string {
  const explicit =
    process.env.ELIZA_CONFIG_PATH?.trim() ||
    process.env.ELIZA_CONFIG_PATH?.trim();
  if (explicit) return explicit;

  const stateDir =
    process.env.ELIZA_STATE_DIR?.trim() ||
    path.join(getUserHomeDir(), ".eliza");
  const namespace = process.env.ELIZA_NAMESPACE?.trim();
  const filename =
    !namespace || namespace === "eliza" ? "eliza.json" : `${namespace}.json`;
  return path.join(stateDir, filename);
}

function readConfiguredSubscriptionProvider(): string | undefined {
  const config = readJsonFile(resolveElizaConfigPath());
  if (!config || typeof config !== "object" || Array.isArray(config)) return;
  const agents = (config as Record<string, unknown>).agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return;
  const defaults = (agents as Record<string, unknown>).defaults;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults))
    return;
  const provider = (defaults as Record<string, unknown>).subscriptionProvider;
  return typeof provider === "string" && provider.trim()
    ? provider.trim()
    : undefined;
}

function hasClaudeSubscriptionAuth(): boolean {
  const credentialsPath = path.join(
    getUserHomeDir(),
    ".claude",
    ".credentials.json",
  );
  const fileToken = extractOauthAccessToken(readJsonFile(credentialsPath));
  if (fileToken) return true;

  if (process.platform !== "darwin") return false;
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!raw) return false;
    return Boolean(extractOauthAccessToken(JSON.parse(raw)));
  } catch {
    return false;
  }
}

function hasClaudeApiKey(runtime?: IAgentRuntime): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY?.trim() ||
      safeGetSetting(runtime, "ANTHROPIC_API_KEY"),
  );
}

function hasCodexSubscriptionAuth(): boolean {
  const authPath = path.join(getUserHomeDir(), ".codex", "auth.json");
  const auth = readJsonFile(authPath);
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return false;
  const key = (auth as Record<string, unknown>).OPENAI_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

function hasCodexApiKey(runtime?: IAgentRuntime): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY?.trim() ||
      safeGetSetting(runtime, "OPENAI_API_KEY"),
  );
}

function hasGeminiCredential(runtime?: IAgentRuntime): boolean {
  return Boolean(
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
      process.env.GOOGLE_API_KEY?.trim() ||
      safeGetSetting(runtime, "GOOGLE_GENERATIVE_AI_API_KEY") ||
      safeGetSetting(runtime, "GOOGLE_API_KEY"),
  );
}

/**
 * Check whether eliza has a paired Eliza Cloud API key. Used to mark
 * Anthropic/OpenAI-backed task agents as auth-ready when LLM provider is
 * "cloud" — they'll route through the cloud proxy at spawn time.
 */
function hasElizaCloudApiKey(): boolean {
  return Boolean(readConfigCloudKey("apiKey"));
}

function hasPiBinary(): boolean {
  return hasBinaryOnPath("pi");
}

function hasOpencodeBinary(): boolean {
  return hasBinaryOnPath("opencode");
}

function isOpencodeLocalMode(): boolean {
  const flag = readConfigEnvKey("PARALLAX_OPENCODE_LOCAL");
  return flag === "1" || flag?.toLowerCase() === "true";
}

function hasBinaryOnPath(binaryName: string): boolean {
  const command = process.platform === "win32" ? "where" : "which";
  const args = [binaryName];
  try {
    execFileSync(command, args, {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function hasFrameworkBinary(id: SupportedTaskAgentAdapter): boolean {
  switch (id) {
    case "claude":
      return hasBinaryOnPath("claude");
    case "codex":
      return hasBinaryOnPath("codex");
    case "gemini":
      return hasBinaryOnPath("gemini");
    case "aider":
      return hasBinaryOnPath("aider");
  }
}

function getFrameworkCooldown(
  id: SupportedTaskAgentAdapter,
): { until: number; reason: string } | undefined {
  const cooldown = frameworkCooldowns.get(id);
  if (!cooldown) return undefined;
  if (cooldown.until <= Date.now()) {
    frameworkCooldowns.delete(id);
    return undefined;
  }
  return cooldown;
}

async function computeTaskAgentFrameworkState(
  runtime: IAgentRuntime,
  probe?: TaskAgentFrameworkProbe,
  profileInput?: TaskAgentTaskProfileInput,
): Promise<TaskAgentFrameworkState> {
  const configuredSubscriptionProvider = readConfiguredSubscriptionProvider();
  const preflightByAdapter = new Map<
    SupportedTaskAgentAdapter,
    PreflightResult
  >();

  if (probe?.checkAvailableAgents) {
    try {
      const results = await withTimeout(
        probe.checkAvailableAgents(STANDARD_FRAMEWORKS),
        resolveFrameworkPreflightTimeoutMs(),
        "task-agent framework preflight",
      );
      // checkAdapters returns `adapter` as the human-readable display name
      // (e.g. "Claude Code", "OpenAI Codex"), not the lowercase ID. Map back
      // to the canonical framework ID via case-insensitive substring match.
      for (const result of results) {
        const adapterId = normalizePreflightAdapterId(result.adapter);
        if (adapterId) {
          preflightByAdapter.set(adapterId, result);
        }
      }
    } catch {
      // Keep status surfaces alive even if preflight fails transiently.
    }
  }

  // When the user has selected Eliza Cloud as the LLM provider and has a
  // paired cloud.apiKey, treat Claude/Codex/Aider as fully auth-ready —
  // they'll route through the cloud proxy at spawn time.
  const llmProvider =
    readConfigEnvKey("PARALLAX_LLM_PROVIDER") || "subscription";
  const cloudReady = llmProvider === "cloud" && hasElizaCloudApiKey();

  const claudePreflightAuth = getPreflightAuthStatus(
    preflightByAdapter.get("claude"),
  );
  const codexPreflightAuth = getPreflightAuthStatus(
    preflightByAdapter.get("codex"),
  );
  const geminiPreflightAuth = getPreflightAuthStatus(
    preflightByAdapter.get("gemini"),
  );
  const aiderPreflightAuth = getPreflightAuthStatus(
    preflightByAdapter.get("aider"),
  );

  // When the user opts in to restricting the Codex subscription to the codex
  // framework only, non-codex frameworks must not treat Codex sub availability
  // as contributing to `subscriptionReady` or `authReady` (so scoring and
  // fallback logic skip the Codex-sub path). Claude subscription tokens are
  // already restricted upstream to the claude CLI, so no gate is needed there.
  const codexSubRestrictedToCodexFramework =
    readConfigCodexSubscriptionRestrictedToCodexFramework();

  const claudeSubscriptionReady =
    claudePreflightAuth === "authenticated" || hasClaudeSubscriptionAuth();
  const claudeAuthReady =
    cloudReady || claudeSubscriptionReady || hasClaudeApiKey(runtime);
  const codexSubscriptionReady =
    codexPreflightAuth === "authenticated" || hasCodexSubscriptionAuth();
  const codexAuthReady =
    cloudReady || codexSubscriptionReady || hasCodexApiKey(runtime);
  // When the flag is set, drop Codex sub from aider's fallback chain — aider
  // must use its own API key (claude/gemini subs are already restricted or
  // non-existent for aider's path, and the Codex API key path still works).
  const codexAuthReadyForNonCodex = codexSubRestrictedToCodexFramework
    ? cloudReady || hasCodexApiKey(runtime)
    : codexAuthReady;
  // Eliza Cloud doesn't proxy Gemini, so cloud mode does NOT make Gemini auth-ready
  const geminiAuthReady =
    geminiPreflightAuth === "authenticated" || hasGeminiCredential(runtime);
  const aiderAuthReady =
    cloudReady ||
    aiderPreflightAuth === "authenticated" ||
    claudeAuthReady ||
    codexAuthReadyForNonCodex ||
    geminiAuthReady;
  const piReady = hasPiBinary();

  const providerPrefersClaude =
    configuredSubscriptionProvider === "anthropic-subscription";
  const providerPrefersCodex =
    configuredSubscriptionProvider === "openai-codex" ||
    configuredSubscriptionProvider === "openai-subscription";

  const inventory: TaskAgentFrameworkAvailability[] = STANDARD_FRAMEWORKS.map(
    (id) => {
      const preflight = preflightByAdapter.get(id);
      const cooldown = getFrameworkCooldown(id);
      const installed = preflight?.installed === true || hasFrameworkBinary(id);
      const subscriptionReady =
        id === "claude"
          ? claudeSubscriptionReady
          : id === "codex"
            ? codexSubscriptionReady
            : false;
      const authReady =
        id === "claude"
          ? claudeAuthReady
          : id === "codex"
            ? codexAuthReady
            : id === "gemini"
              ? geminiAuthReady
              : aiderAuthReady;
      const reason =
        id === "claude" && subscriptionReady
          ? "ready to use the user's Claude subscription"
          : id === "codex" && subscriptionReady
            ? "ready to use the user's OpenAI subscription"
            : installed
              ? authReady
                ? "installed with credentials available"
                : "installed but credentials were not detected"
              : "CLI not detected";
      return {
        id,
        label: FRAMEWORK_LABELS[id],
        installed,
        authReady,
        subscriptionReady,
        temporarilyDisabled: Boolean(cooldown),
        temporarilyDisabledUntil: cooldown?.until,
        temporarilyDisabledReason: cooldown?.reason,
        recommended: false,
        reason: cooldown
          ? `${reason}; temporarily disabled after a provider failure: ${cooldown.reason}`
          : reason,
        installCommand: preflight?.installCommand,
        docsUrl: preflight?.docsUrl,
      };
    },
  );

  inventory.push({
    id: "pi",
    label: FRAMEWORK_LABELS.pi,
    installed: piReady,
    authReady: piReady,
    subscriptionReady: false,
    temporarilyDisabled: false,
    recommended: false,
    reason: piReady ? "CLI detected" : "CLI not detected",
  });

  const opencodeReady = hasOpencodeBinary();
  const opencodeLocalMode = isOpencodeLocalMode();
  const opencodeAuthReady =
    opencodeReady &&
    (cloudReady ||
      opencodeLocalMode ||
      Boolean(readConfigEnvKey("PARALLAX_OPENCODE_BASE_URL")));
  const opencodeReason = !opencodeReady
    ? "CLI not detected"
    : opencodeAuthReady
      ? cloudReady
        ? "ready to use Eliza Cloud as the model provider"
        : opencodeLocalMode
          ? "ready to use a local model provider (PARALLAX_OPENCODE_LOCAL)"
          : "ready to use the configured OpenCode provider"
      : "installed but no model provider is configured (set PARALLAX_OPENCODE_LOCAL=1 for local Ollama, pair Eliza Cloud, or set PARALLAX_OPENCODE_BASE_URL)";
  inventory.push({
    id: "opencode",
    label: FRAMEWORK_LABELS.opencode,
    installed: opencodeReady,
    authReady: opencodeAuthReady,
    subscriptionReady: false,
    temporarilyDisabled: false,
    recommended: false,
    reason: opencodeReason,
    installCommand: "curl -fsSL https://opencode.ai/install | bash",
    docsUrl: "https://opencode.ai/docs/",
  });

  const frameworks = inventory.map((framework) => ({
    ...framework,
    recommended: false,
  }));
  const metrics = probe?.getAgentMetrics?.() ?? {};
  const profile = buildTaskAgentTaskProfile(profileInput);
  const explicitDefault = safeGetSetting(runtime, "PARALLAX_DEFAULT_AGENT_TYPE")
    ?.toLowerCase()
    .trim();
  const selectable = frameworks.filter(
    (framework) => framework.installed && !framework.temporarilyDisabled,
  );
  const candidates =
    selectable.length > 0
      ? selectable
      : frameworks.filter((framework) => framework.installed);

  const scoredCandidates = candidates.map((framework) => {
    const explicitOverride =
      explicitDefault === framework.id
        ? framework.installed && !framework.temporarilyDisabled
          ? 40
          : 0
        : 0;
    const providerPreference =
      providerPrefersClaude && framework.id === "claude"
        ? framework.subscriptionReady
          ? 18
          : 6
        : providerPrefersCodex && framework.id === "codex"
          ? framework.subscriptionReady
            ? 18
            : 6
          : 0;
    const availabilityScore =
      (framework.installed ? 40 : -100) +
      (framework.authReady ? 18 : -25) +
      (framework.subscriptionReady ? 8 : 0) +
      (framework.temporarilyDisabled ? -80 : 0);
    const profileScore = computeProfileFitScore(framework.id, profile);
    const metricsScore = computeMetricsScore(
      metrics[framework.id],
      profile.signals.fastIteration,
    );
    const selectionSignals = {
      availability: availabilityScore,
      profile: profileScore,
      provider: providerPreference,
      metrics: metricsScore,
      explicitOverride,
    };
    return {
      framework,
      score: Object.values(selectionSignals).reduce(
        (sum, value) => sum + value,
        0,
      ),
      selectionSignals,
    };
  });

  const fallback =
    candidates[0] ??
    frameworks.find((framework) => framework.installed) ??
    frameworks[0];
  const preferredCandidate =
    scoredCandidates.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.framework.id.localeCompare(right.framework.id);
    })[0]?.framework ?? fallback;
  const preferredSignals =
    scoredCandidates.find(
      (entry) => entry.framework.id === preferredCandidate.id,
    )?.selectionSignals ?? {};
  const preferred: PreferredTaskAgent = {
    id: preferredCandidate.id,
    reason: buildPreferredReason(
      preferredCandidate,
      profile,
      preferredSignals,
      explicitDefault,
      configuredSubscriptionProvider,
    ),
  };

  for (const framework of frameworks) {
    framework.recommended = framework.id === preferred.id;
    const scored = scoredCandidates.find(
      (entry) => entry.framework.id === framework.id,
    );
    if (scored) {
      framework.selectionScore = scored.score;
      framework.selectionSignals = scored.selectionSignals;
    }
  }

  return {
    configuredSubscriptionProvider,
    frameworks,
    preferred,
  };
}

export async function getTaskAgentFrameworkState(
  runtime: IAgentRuntime,
  probe?: TaskAgentFrameworkProbe,
  profileInput?: TaskAgentTaskProfileInput,
): Promise<TaskAgentFrameworkState> {
  if (frameworkStateCache && frameworkStateCache.expiresAt > Date.now()) {
    return computeTaskAgentFrameworkStateFromInventory(
      runtime,
      frameworkStateCache.value,
      probe,
      profileInput,
    );
  }
  const value = await computeTaskAgentFrameworkState(
    runtime,
    probe,
    profileInput,
  );
  if (!profileInput) {
    frameworkStateCache = {
      expiresAt: Date.now() + 15_000,
      value: {
        configuredSubscriptionProvider: value.configuredSubscriptionProvider,
        frameworks: value.frameworks.map((framework) => ({
          ...framework,
          recommended: false,
          selectionScore: undefined,
          selectionSignals: undefined,
        })),
      },
    };
  }
  return value;
}

function computeTaskAgentFrameworkStateFromInventory(
  runtime: IAgentRuntime,
  inventory: {
    configuredSubscriptionProvider?: string;
    frameworks: TaskAgentFrameworkAvailability[];
  },
  probe?: TaskAgentFrameworkProbe,
  profileInput?: TaskAgentTaskProfileInput,
): TaskAgentFrameworkState {
  const clonedProbe = {
    ...probe,
    checkAvailableAgents: undefined,
  };
  frameworkStateCache = {
    expiresAt: Date.now() + 15_000,
    value: inventory,
  };
  return {
    ...computeTaskAgentFrameworkStateFromCachedInventory(
      runtime,
      inventory,
      clonedProbe,
      profileInput,
    ),
  };
}

function computeTaskAgentFrameworkStateFromCachedInventory(
  runtime: IAgentRuntime,
  inventory: {
    configuredSubscriptionProvider?: string;
    frameworks: TaskAgentFrameworkAvailability[];
  },
  probe?: TaskAgentFrameworkProbe,
  profileInput?: TaskAgentTaskProfileInput,
): TaskAgentFrameworkState {
  const metrics = probe?.getAgentMetrics?.() ?? {};
  const frameworks = inventory.frameworks.map((framework) => ({
    ...framework,
    recommended: false,
  }));
  const profile = buildTaskAgentTaskProfile(profileInput);
  const configuredSubscriptionProvider =
    inventory.configuredSubscriptionProvider;
  const providerPrefersClaude =
    configuredSubscriptionProvider === "anthropic-subscription";
  const providerPrefersCodex =
    configuredSubscriptionProvider === "openai-codex" ||
    configuredSubscriptionProvider === "openai-subscription";
  const explicitDefault = safeGetSetting(runtime, "PARALLAX_DEFAULT_AGENT_TYPE")
    ?.toLowerCase()
    .trim();
  const candidates =
    frameworks.filter(
      (framework) => framework.installed && !framework.temporarilyDisabled,
    ).length > 0
      ? frameworks.filter(
          (framework) => framework.installed && !framework.temporarilyDisabled,
        )
      : frameworks.filter((framework) => framework.installed);
  const scoredCandidates = candidates.map((framework) => {
    const explicitOverride =
      explicitDefault === framework.id
        ? framework.installed && !framework.temporarilyDisabled
          ? 40
          : 0
        : 0;
    const providerPreference =
      providerPrefersClaude && framework.id === "claude"
        ? framework.subscriptionReady
          ? 18
          : 6
        : providerPrefersCodex && framework.id === "codex"
          ? framework.subscriptionReady
            ? 18
            : 6
          : 0;
    const availabilityScore =
      (framework.installed ? 40 : -100) +
      (framework.authReady ? 18 : -25) +
      (framework.subscriptionReady ? 8 : 0) +
      (framework.temporarilyDisabled ? -80 : 0);
    const profileScore = computeProfileFitScore(framework.id, profile);
    const metricsScore = computeMetricsScore(
      metrics[framework.id],
      profile.signals.fastIteration,
    );
    const selectionSignals = {
      availability: availabilityScore,
      profile: profileScore,
      provider: providerPreference,
      metrics: metricsScore,
      explicitOverride,
    };
    return {
      framework,
      score: Object.values(selectionSignals).reduce(
        (sum, value) => sum + value,
        0,
      ),
      selectionSignals,
    };
  });
  const fallback =
    candidates[0] ??
    frameworks.find((framework) => framework.installed) ??
    frameworks[0];
  const preferredCandidate =
    scoredCandidates.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.framework.id.localeCompare(right.framework.id);
    })[0]?.framework ?? fallback;
  const preferredSignals =
    scoredCandidates.find(
      (entry) => entry.framework.id === preferredCandidate.id,
    )?.selectionSignals ?? {};
  const preferred = {
    id: preferredCandidate.id,
    reason: buildPreferredReason(
      preferredCandidate,
      profile,
      preferredSignals,
      explicitDefault,
      configuredSubscriptionProvider,
    ),
  };
  for (const framework of frameworks) {
    framework.recommended = framework.id === preferred.id;
    const scored = scoredCandidates.find(
      (entry) => entry.framework.id === framework.id,
    );
    if (scored) {
      framework.selectionScore = scored.score;
      framework.selectionSignals = scored.selectionSignals;
    }
  }
  frameworkStateCache = {
    expiresAt: Date.now() + 15_000,
    value: inventory,
  };
  return {
    configuredSubscriptionProvider,
    frameworks,
    preferred,
  };
}

function clampSignal(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function kindBoost(kind: TaskAgentTaskKind, target: TaskAgentTaskKind): number {
  if (kind === "mixed") return 0.25;
  return kind === target ? 0.4 : 0;
}

export function buildTaskAgentTaskProfile(
  input?: TaskAgentTaskProfileInput,
): TaskAgentTaskProfile {
  const text = [
    input?.task?.trim(),
    input?.repo?.trim(),
    ...(input?.acceptanceCriteria ?? []).map((value) => value.trim()),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const inferredKind: TaskAgentTaskKind =
    input?.threadKind ??
    (OPS_SIGNAL_RE.test(text)
      ? "ops"
      : PLANNING_SIGNAL_RE.test(text)
        ? "planning"
        : RESEARCH_SIGNAL_RE.test(text) && !IMPLEMENTATION_SIGNAL_RE.test(text)
          ? "research"
          : IMPLEMENTATION_SIGNAL_RE.test(text)
            ? "coding"
            : RESEARCH_SIGNAL_RE.test(text)
              ? "mixed"
              : "coding");
  const repoPresent = Boolean(input?.repo?.trim() || input?.workdir?.trim());
  const subtaskCount = Math.max(1, input?.subtaskCount ?? 1);
  const signals = {
    implementation: clampSignal(
      (IMPLEMENTATION_SIGNAL_RE.test(text) ? 0.7 : 0.2) +
        (repoPresent ? 0.15 : 0) +
        kindBoost(inferredKind, "coding"),
    ),
    research: clampSignal(
      (RESEARCH_SIGNAL_RE.test(text) ? 0.7 : 0.1) +
        kindBoost(inferredKind, "research"),
    ),
    planning: clampSignal(
      (PLANNING_SIGNAL_RE.test(text) ? 0.75 : 0.1) +
        kindBoost(inferredKind, "planning"),
    ),
    ops: clampSignal(
      (OPS_SIGNAL_RE.test(text) ? 0.75 : 0.05) + kindBoost(inferredKind, "ops"),
    ),
    verification: clampSignal(
      (VERIFICATION_SIGNAL_RE.test(text) ? 0.8 : 0.15) +
        ((input?.acceptanceCriteria?.length ?? 0) > 0 ? 0.15 : 0),
    ),
    coordination: clampSignal(
      (COORDINATION_SIGNAL_RE.test(text) ? 0.7 : 0.05) +
        (subtaskCount > 1 ? 0.25 : 0),
    ),
    repoWork: clampSignal(
      (REPO_SIGNAL_RE.test(text) ? 0.7 : 0.1) + (repoPresent ? 0.25 : 0),
    ),
    fastIteration: clampSignal(
      (FAST_ITERATION_SIGNAL_RE.test(text) ? 0.75 : 0.15) +
        (inferredKind === "coding" ? 0.1 : 0),
    ),
  };
  return {
    text,
    kind: inferredKind,
    subtaskCount,
    repoPresent,
    signals,
  };
}

function computeProfileFitScore(
  frameworkId: TaskAgentFrameworkId,
  profile: TaskAgentTaskProfile,
): number {
  const capability = FRAMEWORK_CAPABILITY_PROFILES[frameworkId];
  const weightedSum =
    profile.signals.implementation * capability.implementation * 18 +
    profile.signals.research * capability.research * 16 +
    profile.signals.planning * capability.planning * 14 +
    profile.signals.ops * capability.ops * 12 +
    profile.signals.verification * capability.verification * 14 +
    profile.signals.coordination * capability.coordination * 14 +
    profile.signals.repoWork * capability.repoWork * 10 +
    profile.signals.fastIteration * capability.fastIteration * 10;
  return Math.round(weightedSum);
}

function computeMetricsScore(
  metrics: Omit<AgentMetrics, "totalCompletionMs"> | undefined,
  fastIterationSignal: number,
): number {
  if (!metrics || metrics.spawned === 0) {
    return 0;
  }
  const successRate =
    metrics.spawned > 0 ? metrics.completed / metrics.spawned : 0;
  const stallRate =
    metrics.spawned > 0 ? metrics.stallCount / metrics.spawned : 0;
  const durationBonus =
    metrics.completed > 0
      ? Math.max(
          -8,
          Math.min(
            8,
            ((120_000 - metrics.avgCompletionMs) / 120_000) *
              (4 + fastIterationSignal * 4),
          ),
        )
      : 0;
  return Math.round(successRate * 14 - stallRate * 12 + durationBonus);
}

function buildPreferredReason(
  framework: TaskAgentFrameworkAvailability,
  profile: TaskAgentTaskProfile,
  selectionSignals: Record<string, number>,
  explicitDefault: string | undefined,
  configuredSubscriptionProvider: string | undefined,
): string {
  const dominantSignals = Object.entries(profile.signals)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([key]) => key);
  if (
    explicitDefault === framework.id &&
    selectionSignals.explicitOverride > 0
  ) {
    return `explicit PARALLAX_DEFAULT_AGENT_TYPE override, with ${FRAMEWORK_LABELS[framework.id]} still scoring well for ${dominantSignals.join(" + ")} work`;
  }
  if (
    configuredSubscriptionProvider === "anthropic-subscription" &&
    framework.id === "claude" &&
    framework.subscriptionReady
  ) {
    return `best fit for ${dominantSignals.join(" + ")} work while honoring the configured Claude subscription`;
  }
  if (
    (configuredSubscriptionProvider === "openai-codex" ||
      configuredSubscriptionProvider === "openai-subscription") &&
    framework.id === "codex" &&
    framework.subscriptionReady
  ) {
    return `best fit for ${dominantSignals.join(" + ")} work while honoring the configured OpenAI subscription`;
  }
  if (framework.subscriptionReady) {
    return `best overall score for ${dominantSignals.join(" + ")} work with subscription-backed auth already available`;
  }
  if (framework.authReady) {
    return `best overall score for ${dominantSignals.join(" + ")} work with credentials already available`;
  }
  return `selected as the highest-scoring installed framework for ${dominantSignals.join(" + ")} work`;
}

export function clearTaskAgentFrameworkStateCache(): void {
  frameworkStateCache = undefined;
}

export function isUsageExhaustedTaskAgentError(text: string): boolean {
  return TASK_AGENT_USAGE_EXHAUSTED_RE.test(text);
}

export function markTaskAgentFrameworkUnavailable(
  id: SupportedTaskAgentAdapter,
  reason: string,
  cooldownMs = 30 * 60 * 1000,
): void {
  frameworkCooldowns.set(id, {
    until: Date.now() + cooldownMs,
    reason,
  });
  clearTaskAgentFrameworkStateCache();
}

export function markTaskAgentFrameworkHealthy(
  id: SupportedTaskAgentAdapter,
): void {
  if (frameworkCooldowns.delete(id)) {
    clearTaskAgentFrameworkStateCache();
  }
}

export function formatTaskAgentFrameworkLine(
  framework: TaskAgentFrameworkAvailability,
): string {
  const parts = [
    framework.installed ? "installed" : "not installed",
    framework.authReady ? "credentials ready" : "credentials missing",
  ];
  if (framework.subscriptionReady) {
    parts.push("uses the user's subscription");
  }
  if (framework.temporarilyDisabled) {
    parts.push("temporarily disabled");
  }
  if (framework.recommended) {
    parts.push("recommended");
  }
  return `- ${framework.label}: ${parts.join(", ")}. ${framework.reason}.`;
}

export function looksLikeTaskAgentRequest(text: string): boolean {
  return TASK_AGENT_COMPLEXITY_RE.test(text);
}

export function formatTaskAgentStatus(status: string): string {
  switch (status) {
    case "ready":
      return "idle";
    case "busy":
      return "working";
    case "starting":
      return "starting";
    case "authenticating":
      return "authenticating";
    default:
      return status;
  }
}

export function truncateTaskAgentText(text: string, max = 120): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
}

export function rewriteTaskAgentText(text: string): string {
  return text
    .replace(/\bcoding agents\b/gi, "task agents")
    .replace(/\bcoding agent\b/gi, "task agent")
    .replace(/\bcoding sessions\b/gi, "task-agent sessions")
    .replace(/\bcoding session\b/gi, "task-agent session");
}

export { FRAMEWORK_LABELS as TASK_AGENT_FRAMEWORK_LABELS };
