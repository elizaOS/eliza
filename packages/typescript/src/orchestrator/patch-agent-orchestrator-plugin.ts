import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { createCodingAgentRouteHandler as baseCreateCodingAgentRouteHandler } from "./api/routes.ts";
import { taskAgentPluginBase } from "./base-plugin.ts";
import { installClaudeJsonlCompletionWatcher } from "./claude-jsonl-completion-watcher.ts";
import { installTaskProgressStreamer } from "./task-progress-streamer.ts";
import {
  getCoordinator as getCoordinatorFromPty,
  PTYService,
} from "./services/pty-service.ts";
import type { SwarmCoordinator } from "./services/swarm-coordinator.ts";
import { CodingWorkspaceService } from "./services/workspace-service.ts";

type AdapterId = "claude" | "codex" | "gemini" | "aider";
type FrameworkId = AdapterId | "pi";
type SessionStatus =
  | "ready"
  | "busy"
  | "starting"
  | "authenticating"
  | "running"
  | "idle"
  | "blocked"
  | "completed"
  | "error"
  | "stopped"
  | string;

interface AdapterPreflight {
  adapter?: string;
  installed?: boolean;
  installCommand?: string;
  docsUrl?: string;
}

interface SessionSummary {
  id: string;
  name: string;
  agentType: string;
  workdir: string;
  status: SessionStatus;
  createdAt: Date;
  lastActivityAt: Date;
  metadata?: Record<string, unknown>;
}

interface WorkspaceSummary {
  id: string;
  label?: string;
  repo?: string;
  branch?: string;
  path: string;
}

interface PendingConfirmation {
  sessionId: string;
  promptText: string;
  llmDecision: {
    action?: string;
    response?: string;
  };
  taskContext: TaskSummary;
  createdAt: number;
}

interface TaskSummary {
  threadId?: string;
  sessionId: string;
  agentType: string;
  label: string;
  originalTask: string;
  workdir: string;
  repo?: string;
  status: string;
  decisions: Array<{
    decision: string;
    reasoning: string;
    response?: string;
  }>;
  autoResolvedCount: number;
  registeredAt: number;
  lastActivityAt: number;
  completionSummary?: string;
}

interface TaskThreadSummary {
  id: string;
  title: string;
  kind?: string;
  status: string;
  scenarioId?: string;
  batchId?: string;
  originalRequest?: string;
  summary?: string;
  sessionCount?: number;
  activeSessionCount?: number;
  latestSessionId?: string;
  latestSessionLabel?: string;
  latestWorkdir?: string;
  latestRepo?: string;
  latestActivityAt?: number;
  decisionCount?: number;
  createdAt?: number;
  updatedAt?: number;
  closedAt?: number;
  archivedAt?: number;
}

interface TaskArtifactRecord {
  title: string;
  artifactType?: string;
  uri?: string;
  path?: string;
}

interface TaskTranscriptEntry {
  direction: string;
  content: string;
}

interface TaskThreadDetail extends TaskThreadSummary {
  artifacts?: TaskArtifactRecord[];
  transcripts?: TaskTranscriptEntry[];
}

interface CoordinatorLike {
  getAllTaskContexts?: () => TaskSummary[];
  getTaskContext?: (sessionId: string) => TaskSummary | undefined;
  getPendingConfirmations?: () => PendingConfirmation[];
  getSupervisionLevel?: () => string;
  listTaskThreads?: (options?: {
    includeArchived?: boolean;
    limit?: number;
  }) => Promise<TaskThreadSummary[]>;
  getTaskThread?: (threadId: string) => Promise<TaskThreadDetail | null>;
  countTaskThreads?: (options?: {
    includeArchived?: boolean;
    status?: string;
    statuses?: string[];
    kind?: string;
    roomId?: string;
    worldId?: string;
    ownerUserId?: string;
    scenarioId?: string;
    batchId?: string;
    createdAfter?: string;
    createdBefore?: string;
    updatedAfter?: string;
    updatedBefore?: string;
    latestActivityAfter?: number;
    latestActivityBefore?: number;
    hasActiveSession?: boolean;
    search?: string;
  }) => Promise<number>;
  archiveTaskThread?: (threadId: string) => Promise<void>;
  reopenTaskThread?: (threadId: string) => Promise<void>;
  pauseTaskThread?: (
    threadId: string,
    note?: string,
  ) => Promise<Record<string, unknown>>;
  stopTaskThread?: (
    threadId: string,
    note?: string,
  ) => Promise<Record<string, unknown>>;
  resumeTaskThread?: (
    threadId: string,
    instruction?: string,
    agentType?: string,
  ) => Promise<Record<string, unknown>>;
  continueTaskThread?: (
    threadId: string,
    instruction: string,
    agentType?: string,
  ) => Promise<Record<string, unknown>>;
}

interface PTYServiceLike {
  defaultApprovalPreset: string;
  agentSelectionStrategy: string;
  defaultAgentType: string;
  listSessions: () => Promise<SessionSummary[]>;
  checkAvailableAgents: (types?: AdapterId[]) => Promise<AdapterPreflight[]>;
  resolveAgentType?: () => Promise<string>;
  coordinator?: CoordinatorLike;
}

interface WorkspaceServiceLike {
  listWorkspaces: () => WorkspaceSummary[];
}

type RuntimeWithServices = IAgentRuntime & {
  getService: (name: string) => unknown;
};

type PatchedRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method?: string,
) => Promise<boolean>;

interface FrameworkAvailability {
  id: FrameworkId;
  label: string;
  installed: boolean;
  authReady: boolean;
  subscriptionReady: boolean;
  recommended: boolean;
  reason: string;
  installCommand?: string;
  docsUrl?: string;
}

interface PreferredFramework {
  id: FrameworkId;
  reason: string;
}

interface FrameworkState {
  configuredSubscriptionProvider?: string;
  frameworks: FrameworkAvailability[];
  preferred: PreferredFramework;
}

const basePlugin = taskAgentPluginBase;
const baseProviderMap = new Map(
  (basePlugin.providers ?? []).map((provider) => [provider.name, provider]),
);
const baseActionMap = new Map(
  (basePlugin.actions ?? []).map((action) => [action.name, action]),
);

const FRAMEWORK_LABELS: Record<FrameworkId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  aider: "Aider",
  pi: "Pi",
};
const STANDARD_FRAMEWORKS: AdapterId[] = ["claude", "codex", "gemini", "aider"];

const TASK_AGENT_STRONG_HINT_RE =
  /\b(repo|repository|codebase|coding|debug|fix|implement|refactor|workspace|parallel|delegate|subtask|sub-agent|subagent|agent|orchestrate|coordinate|pull request|pr\b|branch|commit|background task)\b/i;
const TASK_AGENT_WEAK_HINT_RE =
  /\b(investigate|research|analyze|analysis|summarize|summary|write|draft|document|plan|workflow|automation|compare|test|tests)\b/i;
const NON_TASK_ASSISTANT_QUERY_RE =
  /\b(calendar|schedule|event|events|meeting|meetings|appointment|appointments|gmail|email|emails|inbox|lifeops|flight|flights|travel|trip|today|tomorrow|tonight|this week|next week|remind|reminder|task|habit)\b/i;

let frameworkStateCache:
  | {
      expiresAt: number;
      value: FrameworkState;
    }
  | undefined;

let patched = false;

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
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
  const explicit = process.env.ELIZA_CONFIG_PATH?.trim();
  if (explicit) return explicit;

  const stateDir =
    process.env.ELIZA_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".eliza");
  const namespace = process.env.ELIZA_NAMESPACE?.trim();
  const filename = namespace ? `${namespace}.json` : "eliza.json";
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

/**
 * Read a key from the env section of the eliza config file. The settings UI writes here,
 * and we want changes to take effect without restart, so we read the file
 * directly instead of relying on the runtime's in-memory character settings.
 */
function readElizaEnvKey(key: string): string | undefined {
  const config = readJsonFile(resolveElizaConfigPath());
  if (!config || typeof config !== "object" || Array.isArray(config)) return;
  const env = (config as Record<string, unknown>).env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return;
  const value = (env as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Read the cloud.apiKey from the eliza config file. Used to detect when Eliza Cloud is
 * paired so cloud-mode auth can mark Anthropic/OpenAI agents as ready.
 */
function readElizaCloudApiKey(): string | undefined {
  const config = readJsonFile(resolveElizaConfigPath());
  if (!config || typeof config !== "object" || Array.isArray(config)) return;
  const cloud = (config as Record<string, unknown>).cloud;
  if (!cloud || typeof cloud !== "object" || Array.isArray(cloud)) return;
  const apiKey = (cloud as Record<string, unknown>).apiKey;
  return typeof apiKey === "string" && apiKey.trim()
    ? apiKey.trim()
    : undefined;
}

function hasClaudeSubscriptionAuth(): boolean {
  const config = readJsonFile(resolveElizaConfigPath());
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const env = (config as Record<string, unknown>).env;
    if (env && typeof env === "object" && !Array.isArray(env)) {
      const setupToken = (env as Record<string, unknown>)
        .__anthropicSubscriptionToken;
      if (typeof setupToken === "string" && setupToken.trim()) {
        return true;
      }
    }
  }

  const storedPath = path.join(
    process.env.ELIZA_HOME || path.join(os.homedir(), ".eliza"),
    "auth",
    "anthropic-subscription.json",
  );
  const stored = readJsonFile(storedPath);
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const credentials = (stored as Record<string, unknown>).credentials;
    if (
      credentials &&
      typeof credentials === "object" &&
      !Array.isArray(credentials)
    ) {
      const expires = (credentials as Record<string, unknown>).expires;
      if (typeof expires === "number" && expires > Date.now()) {
        return true;
      }
    }
  }

  const credentialsPath = path.join(
    os.homedir(),
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

function hasCodexSubscriptionAuth(): boolean {
  const storedPath = path.join(
    process.env.ELIZA_HOME || path.join(os.homedir(), ".eliza"),
    "auth",
    "openai-codex.json",
  );
  const stored = readJsonFile(storedPath);
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const credentials = (stored as Record<string, unknown>).credentials;
    if (
      credentials &&
      typeof credentials === "object" &&
      !Array.isArray(credentials)
    ) {
      const expires = (credentials as Record<string, unknown>).expires;
      if (typeof expires === "number" && expires > Date.now()) {
        return true;
      }
    }
  }

  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  const auth = readJsonFile(authPath);
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return false;
  const key = (auth as Record<string, unknown>).OPENAI_API_KEY;
  const authMode = (auth as Record<string, unknown>).auth_mode;
  return (
    typeof key === "string" &&
    key.trim().length > 0 &&
    typeof authMode === "string" &&
    authMode.trim().toLowerCase() !== "api-key"
  );
}

function hasAnthropicApiCredential(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

function hasOpenAIApiCredential(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function hasGeminiCredential(): boolean {
  return Boolean(
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
      process.env.GOOGLE_API_KEY?.trim(),
  );
}

function hasPiBinary(): boolean {
  const command = process.platform === "win32" ? "where" : "which";
  const args = process.platform === "win32" ? ["pi.exe"] : ["pi"];
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

function normalizePreflightAdapterId(value: unknown): AdapterId | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "claude":
    case "claude code":
      return "claude";
    case "codex":
    case "openai codex":
      return "codex";
    case "gemini":
    case "google gemini":
      return "gemini";
    case "aider":
      return "aider";
    default:
      return undefined;
  }
}

async function computeFrameworkState(
  runtime: IAgentRuntime,
  ptyService?: PTYServiceLike,
): Promise<FrameworkState> {
  const configuredSubscriptionProvider = readConfiguredSubscriptionProvider();
  const preflightRecords = new Map<AdapterId, AdapterPreflight>();

  if (ptyService) {
    try {
      const results = await ptyService.checkAvailableAgents([
        "claude",
        "codex",
        "gemini",
        "aider",
      ]);
      // checkAvailableAgents returns `result.adapter` as the human-readable
      // display name (e.g. "Claude Code", "OpenAI Codex"), not the lowercase
      // ID. Map back to the canonical framework ID via case-insensitive
      // substring match so the framework state correctly reports installed.
      for (const result of results) {
        const adapter = normalizePreflightAdapterId(result.adapter);
        if (adapter) {
          preflightRecords.set(adapter, result);
        }
      }
    } catch {
      // Keep the provider/status surface alive even if preflight is temporarily unavailable.
    }
  }

  // When the user has selected Eliza Cloud as the LLM provider and has a
  // paired cloud.apiKey, treat Claude as fully auth-ready — it will route
  // through the cloud proxy at spawn time. Eliza Cloud does NOT proxy
  // Gemini, so cloud mode does not affect Gemini's auth state.
  //
  // Codex-through-Eliza-Cloud is intentionally NOT gated on `cloudReady`:
  // the upstream responses-stream reconciliation (elizaOS/cloud#427) has
  // not deployed yet, so marking Codex ready in cloud mode would mislead
  // users into starting a session that hits a runtime failure with no
  // explanation. Restore `cloudReady ||` on the codexReady line once
  // cloud#427 + cloud#428 have shipped.
  const llmProvider =
    readElizaEnvKey("PARALLAX_LLM_PROVIDER") || "subscription";
  const cloudReady =
    llmProvider === "cloud" && Boolean(readElizaCloudApiKey());

  const claudeSubscriptionReady = hasClaudeSubscriptionAuth();
  const codexSubscriptionReady = hasCodexSubscriptionAuth();
  const claudeReady =
    cloudReady || claudeSubscriptionReady || hasAnthropicApiCredential();
  const codexReady = codexSubscriptionReady || hasOpenAIApiCredential();
  const geminiReady = hasGeminiCredential();
  const piReady = hasPiBinary();

  const providerPrefersClaude =
    configuredSubscriptionProvider === "anthropic-subscription";
  const providerPrefersCodex =
    configuredSubscriptionProvider === "openai-codex" ||
    configuredSubscriptionProvider === "openai-subscription";

  const frameworks: FrameworkAvailability[] = STANDARD_FRAMEWORKS.map((id) => {
    const preflight = preflightRecords.get(id);
    const installed = preflight?.installed === true;
    const subscriptionReady =
      id === "claude"
        ? claudeSubscriptionReady
        : id === "codex"
          ? codexSubscriptionReady
          : false;
    const authReady =
      id === "claude"
        ? claudeReady
        : id === "codex"
          ? codexReady
          : id === "gemini"
            ? geminiReady
            : claudeSubscriptionReady ||
              codexSubscriptionReady ||
              hasAnthropicApiCredential() ||
              hasOpenAIApiCredential() ||
              geminiReady;
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
      recommended: false,
      reason,
      installCommand: preflight?.installCommand,
      docsUrl: preflight?.docsUrl,
    };
  });

  frameworks.push({
    id: "pi",
    label: FRAMEWORK_LABELS.pi,
    installed: piReady,
    authReady: piReady,
    subscriptionReady: false,
    recommended: false,
    reason: piReady ? "CLI detected" : "CLI not detected",
  });

  // Read PARALLAX_DEFAULT_AGENT_TYPE from the eliza config file first (the settings UI
  // writes here, takes effect without restart) and fall back to runtime/env.
  const explicitDefault =
    (
      readElizaEnvKey("PARALLAX_DEFAULT_AGENT_TYPE") ??
      (runtime.getSetting("PARALLAX_DEFAULT_AGENT_TYPE") as string | undefined)
    )
      ?.trim()
      .toLowerCase() ?? "";
  let preferred: PreferredFramework | undefined;

  const byId = new Map(
    frameworks.map((framework) => [framework.id, framework]),
  );
  if (
    (explicitDefault === "claude" ||
      explicitDefault === "codex" ||
      explicitDefault === "gemini" ||
      explicitDefault === "aider" ||
      explicitDefault === "pi") &&
    byId.get(explicitDefault as FrameworkId)?.installed
  ) {
    preferred = {
      id: explicitDefault as FrameworkId,
      reason: "explicit PARALLAX_DEFAULT_AGENT_TYPE override",
    };
  } else if (
    providerPrefersClaude &&
    byId.get("claude")?.installed &&
    claudeReady
  ) {
    preferred = {
      id: "claude",
      reason: "configured Claude subscription should drive Claude Code first",
    };
  } else if (
    providerPrefersCodex &&
    byId.get("codex")?.installed &&
    codexReady
  ) {
    preferred = {
      id: "codex",
      reason: "configured OpenAI subscription should drive Codex first",
    };
  } else if (byId.get("claude")?.installed && claudeReady) {
    preferred = {
      id: "claude",
      reason: "Claude Code is installed and a Claude credential is available",
    };
  } else if (byId.get("codex")?.installed && codexReady) {
    preferred = {
      id: "codex",
      reason: "Codex is installed and an OpenAI credential is available",
    };
  } else if (byId.get("gemini")?.installed && geminiReady) {
    preferred = {
      id: "gemini",
      reason: "Gemini CLI is installed and a Google credential is available",
    };
  } else {
    const fallback =
      frameworks.find((framework) => framework.installed) ?? frameworks[0];
    preferred = {
      id: fallback.id,
      reason: fallback.installed
        ? "best available installed framework"
        : "default fallback while no task-agent CLI is installed",
    };
  }

  for (const framework of frameworks) {
    framework.recommended = framework.id === preferred.id;
  }

  return {
    configuredSubscriptionProvider,
    frameworks,
    preferred,
  };
}

async function getFrameworkState(
  runtime: IAgentRuntime,
  ptyService?: PTYServiceLike,
): Promise<FrameworkState> {
  if (frameworkStateCache && frameworkStateCache.expiresAt > Date.now()) {
    return frameworkStateCache.value;
  }
  const value = await computeFrameworkState(runtime, ptyService);
  frameworkStateCache = {
    expiresAt: Date.now() + 15_000,
    value,
  };
  return value;
}

function formatFrameworkLine(framework: FrameworkAvailability): string {
  const parts = [
    framework.installed ? "installed" : "not installed",
    framework.authReady ? "credentials ready" : "credentials missing",
  ];
  if (framework.subscriptionReady) {
    parts.push("uses the user's subscription");
  }
  if (framework.recommended) {
    parts.push("recommended");
  }
  return `- ${framework.label}: ${parts.join(", ")}. ${framework.reason}.`;
}

function looksLikeTaskRequest(text: string): boolean {
  if (NON_TASK_ASSISTANT_QUERY_RE.test(text)) {
    return false;
  }
  return (
    TASK_AGENT_STRONG_HINT_RE.test(text) ||
    (TASK_AGENT_WEAK_HINT_RE.test(text) &&
      /\b(repo|repository|workspace|code|coding|sub-agent|subagent|agent|parallel|delegate|background)\b/i.test(
        text,
      ))
  );
}

function formatStatus(status: string): string {
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

function truncateText(text: string, max = 120): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function resolveCoordinator(
  runtime: IAgentRuntime,
): CoordinatorLike | undefined {
  const fromRuntime = (runtime as RuntimeWithServices).getService(
    "SWARM_COORDINATOR",
  );
  if (fromRuntime) return fromRuntime as CoordinatorLike;

  const ptyService = (runtime as RuntimeWithServices).getService(
    "PTY_SERVICE",
  ) as unknown as PTYServiceLike | undefined;
  if (ptyService?.coordinator) {
    return ptyService.coordinator;
  }

  return getCoordinatorFromPty(runtime) as CoordinatorLike | undefined;
}

function getPtyService(runtime: IAgentRuntime): PTYServiceLike | undefined {
  const service = (runtime as RuntimeWithServices).getService("PTY_SERVICE");
  return service as unknown as PTYServiceLike | undefined;
}

function getWorkspaceService(
  runtime: IAgentRuntime,
): WorkspaceServiceLike | undefined {
  const service = (runtime as RuntimeWithServices).getService(
    "CODING_WORKSPACE_SERVICE",
  );
  return service as unknown as WorkspaceServiceLike | undefined;
}

function createTaskAgentExamplesProvider(): Provider {
  const baseProvider = baseProviderMap.get("CODING_AGENT_EXAMPLES");
  return {
    name: "TASK_AGENT_EXAMPLES",
    description:
      "Structured examples showing how to use open-ended task-agent actions, framework availability, and subscription-aware defaults",
    position: baseProvider?.position ?? -1,
    get: async (
      runtime: IAgentRuntime,
      message: Memory,
      _state: State,
    ): Promise<ProviderResult> => {
      const userText =
        (typeof message.content === "string"
          ? message.content
          : message.content?.text) ?? "";
      const ptyService = getPtyService(runtime);
      const frameworkState = await getFrameworkState(runtime, ptyService);
      const frameworkLines = frameworkState.frameworks.map(formatFrameworkLine);
      const taskLikeRequest = looksLikeTaskRequest(userText);

      const compactText = [
        "# Task Agent Availability",
        "Task agents are for repo, workspace, coding, and other long-running background work.",
        "Do not use CREATE_TASK, SPAWN_AGENT, or SEND_TO_AGENT for normal LifeOps, calendar, Gmail, scheduling, or other questions the main agent can answer directly.",
        "",
        `Recommended default right now: ${FRAMEWORK_LABELS[frameworkState.preferred.id]} (${frameworkState.preferred.reason}).`,
        ...(frameworkState.configuredSubscriptionProvider
          ? [
              `Configured Eliza subscription provider: ${frameworkState.configuredSubscriptionProvider}. Prefer the matching user-backed CLI first so Eliza does not waste cloud chat capacity.`,
            ]
          : []),
        "",
        "Current task-agent frameworks:",
        ...frameworkLines,
        "",
        "Canonical actions:",
        "- CREATE_TASK: launch one or more background task agents against a repo, workspace, or explicit multi-step background task.",
        "- SPAWN_AGENT: start a specific task agent in an existing workspace when you need direct control.",
        "- SEND_TO_AGENT: reply to a running task agent or send keys to unblock it.",
        "- LIST_AGENTS / STOP_AGENT: inspect or stop active task agents.",
      ].join("\n");

      if (!taskLikeRequest) {
        return {
          data: {
            preferredTaskAgent: frameworkState.preferred.id,
            frameworks: frameworkState.frameworks,
          },
          values: { taskAgentExamples: compactText },
          text: compactText,
        };
      }

      const detailedText = [
        compactText,
        "",
        "Examples:",
        'User: "Investigate why the production login flow started returning 401s in https://github.com/acme/app and fix it."',
        "Assistant:",
        "<actions>",
        "  <action>REPLY</action>",
        "  <action>CREATE_TASK</action>",
        "</actions>",
        "<params>",
        "  <CREATE_TASK>",
        "    <repo>https://github.com/acme/app</repo>",
        "    <task>Investigate the production login 401s, implement the fix, run the relevant tests, and summarize the root cause.</task>",
        "  </CREATE_TASK>",
        "</params>",
        "",
        'User: "Spin up a few sub-agents to research the current browser automation options, compare them, and draft a recommendation doc."',
        "Assistant:",
        "<actions>",
        "  <action>REPLY</action>",
        "  <action>CREATE_TASK</action>",
        "</actions>",
        "<params>",
        "  <CREATE_TASK>",
        '    <agents>Research Playwright tradeoffs and browser sandboxing. Your identifier is "research". | Compare Stagehand, Playwright, and browser-use for Eliza. Your identifier is "comparison". | Draft a recommendation memo in TASK_AGENTS.md using the findings. Your identifier is "writer".</agents>',
        "  </CREATE_TASK>",
        "</params>",
        "",
        'User: "Tell the running sub-agent to accept that prompt and continue."',
        "Assistant:",
        "<actions>",
        "  <action>REPLY</action>",
        "  <action>SEND_TO_AGENT</action>",
        "</actions>",
        "<params>",
        "  <SEND_TO_AGENT>",
        "    <input>Yes, accept it and continue.</input>",
        "  </SEND_TO_AGENT>",
        "</params>",
        "",
        "Guidance:",
        "- Do not use task agents when the main agent can answer directly with built-in LifeOps, calendar, Gmail, or other connector actions.",
        "- Prefer CREATE_TASK whenever the work is open-ended, multi-step, or can continue asynchronously.",
        "- If the task references a real repository or prior workspace, include the repo/workspace context instead of dropping the agent into scratch space.",
        "- Use multiple agents only when the subtasks are clearly separable and benefit from parallelism.",
      ].join("\n");

      return {
        data: {
          preferredTaskAgent: frameworkState.preferred.id,
          frameworks: frameworkState.frameworks,
        },
        values: { taskAgentExamples: detailedText },
        text: detailedText,
      };
    },
  };
}

function createActiveWorkspaceContextProvider(): Provider {
  const baseProvider = baseProviderMap.get("ACTIVE_WORKSPACE_CONTEXT");
  return {
    name: "ACTIVE_WORKSPACE_CONTEXT",
    description:
      "Live status of active workspaces, task-agent sessions, and current task progress",
    position: baseProvider?.position ?? 1,
    get: async (
      runtime: IAgentRuntime,
      _message: Memory,
      _state: State,
    ): Promise<ProviderResult> => {
      const ptyService = getPtyService(runtime);
      const workspaceService = getWorkspaceService(runtime);
      const coordinator = resolveCoordinator(runtime);
      const frameworkState = await getFrameworkState(runtime, ptyService);
      const userText =
        (typeof _message.content === "string"
          ? _message.content
          : _message.content?.text) ?? "";
      const taskLikeRequest = looksLikeTaskRequest(userText);

      const sessions = ptyService
        ? await Promise.race([
            ptyService.listSessions(),
            new Promise<SessionSummary[]>((resolve) =>
              setTimeout(() => resolve([]), 2000),
            ),
          ])
        : [];
      const workspaces = workspaceService?.listWorkspaces() ?? [];
      const tasks = uniqueTaskList(coordinator?.getAllTaskContexts?.() ?? []);

      const lines: string[] = ["# Active Workspaces & Task Agents"];
      lines.push(
        `Preferred framework: ${FRAMEWORK_LABELS[frameworkState.preferred.id]} (${frameworkState.preferred.reason}).`,
      );

      if (
        workspaces.length === 0 &&
        sessions.length === 0 &&
        tasks.length === 0
      ) {
        lines.push("No active workspaces or task-agent sessions.");
        if (taskLikeRequest) {
          lines.push(
            "Use CREATE_TASK when the user needs substantial repo or background work.",
          );
        } else {
          lines.push(
            "Ignore this provider for direct calendar, Gmail, LifeOps, or other normal assistant questions.",
          );
        }
      } else {
        if (workspaces.length > 0) {
          lines.push("");
          lines.push(`## Workspaces (${workspaces.length})`);
          for (const workspace of workspaces) {
            const workspaceSessions = sessions.filter(
              (session) => session.workdir === workspace.path,
            );
            const agentSummary =
              workspaceSessions.length > 0
                ? workspaceSessions
                    .map(
                      (session) =>
                        `${session.agentType}:${formatStatus(session.status)}`,
                    )
                    .join(", ")
                : "no task agents";
            lines.push(
              `- "${workspace.label ?? workspace.id.slice(0, 8)}" -> ${workspace.repo ?? "scratch"} (${workspace.branch ?? "no branch"}, ${agentSummary})`,
            );
          }
        }

        const trackedPaths = new Set(
          workspaces.map((workspace) => workspace.path),
        );
        const standaloneSessions = sessions.filter(
          (session) => !trackedPaths.has(session.workdir),
        );

        if (standaloneSessions.length > 0) {
          lines.push("");
          lines.push(`## Standalone Sessions (${standaloneSessions.length})`);
          for (const session of standaloneSessions) {
            const label =
              typeof session.metadata?.label === "string"
                ? session.metadata.label
                : session.name;
            lines.push(
              `- "${label}" (${session.agentType}, ${formatStatus(session.status)}) [session: ${session.id}]`,
            );
          }
        }

        if (tasks.length > 0) {
          lines.push("");
          lines.push(`## Current Task Status (${tasks.length})`);
          for (const task of tasks
            .slice()
            .sort((left, right) => right.registeredAt - left.registeredAt)) {
            const latestDecision = task.decisions.at(-1);
            const detail =
              task.completionSummary ||
              latestDecision?.reasoning ||
              truncateText(task.originalTask, 110);
            lines.push(
              `- [${task.status}] "${task.label}" (${task.agentType}) -> ${detail}`,
            );
          }
        }

        const pending = coordinator?.getPendingConfirmations?.() ?? [];
        if (pending.length > 0) {
          lines.push("");
          lines.push(
            `## Pending Confirmations (${pending.length}) — supervision: ${coordinator?.getSupervisionLevel?.() ?? "unknown"}`,
          );
          for (const confirmation of pending) {
            lines.push(
              `- "${confirmation.taskContext.label}" blocked on "${truncateText(confirmation.promptText, 140)}" -> suggested: ${confirmation.llmDecision.action ?? "review"}`,
            );
          }
        }
      }

      if (sessions.length > 0 || tasks.length > 0) {
        lines.push("");
        lines.push(
          "Use SEND_TO_AGENT to unblock a running agent, LIST_AGENTS to inspect progress, STOP_AGENT to cancel, and FINALIZE_WORKSPACE when the work should be published or wrapped up.",
        );
      }

      const text = lines.join("\n");
      return {
        data: {
          activeWorkspaces: workspaces,
          activeSessions: sessions,
          currentTasks: tasks,
          preferredTaskAgent: frameworkState.preferred,
          frameworks: frameworkState.frameworks,
        },
        values: { activeWorkspaceContext: text },
        text,
      };
    },
  };
}

function uniqueTaskList(tasks: TaskSummary[]): TaskSummary[] {
  const seen = new Set<string>();
  const result: TaskSummary[] = [];
  for (const task of tasks) {
    if (seen.has(task.sessionId)) continue;
    seen.add(task.sessionId);
    result.push(task);
  }
  return result;
}

function patchAction(
  currentName: string,
  nextName: string,
  description: string,
  examples: Action["examples"],
  extraSimiles: string[] = [],
): void {
  const action = baseActionMap.get(currentName);
  if (!action) return;
  action.name = nextName;
  action.description = description;
  action.examples = examples;
  action.similes = uniqueStrings([
    currentName,
    nextName,
    ...(action.similes ?? []),
    ...extraSimiles,
  ]);
  baseActionMap.set(nextName, action);
}

function createActionExamples(
  userText: string,
  assistantText: string,
  actionName: string,
): NonNullable<Action["examples"]> {
  return [
    [
      {
        name: "{{user1}}",
        content: {
          text: userText,
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: assistantText,
          action: actionName,
        },
      },
    ],
  ];
}

function wrapActionHandler(
  action: Action | undefined,
  rewrite: (text: string) => string,
): void {
  if (!action?.handler) return;
  const originalHandler = action.handler.bind(action);
  action.handler = async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ) =>
    originalHandler(
      runtime,
      message,
      state,
      options,
      callback
        ? async (content) => {
            const nextContent =
              content && typeof content === "object" && "text" in content
                ? {
                    ...content,
                    text:
                      typeof content.text === "string"
                        ? rewrite(content.text)
                        : content.text,
                  }
                : content;
            return callback(nextContent);
          }
        : undefined,
    );
}

function renameTaskAgentText(text: string): string {
  return text
    .replace(/\bcoding agents\b/gi, "task agents")
    .replace(/\bcoding agent\b/gi, "task agent")
    .replace(/\bcoding sessions\b/gi, "task-agent sessions")
    .replace(/\bcoding session\b/gi, "task-agent session");
}

function injectPreferredAgentType(action: Action | undefined): void {
  if (!action?.handler) return;
  const originalHandler = action.handler.bind(action);
  action.handler = async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const parameters =
      (options?.parameters as Record<string, unknown> | undefined) ?? {};
    const content =
      message.content && typeof message.content === "object"
        ? (message.content as Record<string, unknown>)
        : {};
    const explicitAgentType =
      typeof parameters.agentType === "string"
        ? parameters.agentType
        : typeof content.agentType === "string"
          ? content.agentType
          : undefined;

    if (explicitAgentType) {
      return originalHandler(runtime, message, state, options, callback);
    }

    const ptyService = getPtyService(runtime);
    const frameworkState = await getFrameworkState(runtime, ptyService);
    const preferredAgentType =
      frameworkState.preferred.id === "pi" ? "pi" : frameworkState.preferred.id;

    const nextMessage = {
      ...message,
      content: {
        ...content,
        agentType: preferredAgentType,
      },
    } as Memory;
    const nextOptions = {
      ...(options ?? {}),
      parameters: {
        ...parameters,
        agentType: preferredAgentType,
      },
    } as HandlerOptions;

    return originalHandler(runtime, nextMessage, state, nextOptions, callback);
  };
}

/**
 * Deployment-specific task-agent memory, loaded from an external file.
 *
 * The compat layer itself is generic — it ships with no hardcoded deployment
 * content. Operators point `TASK_AGENT_MEMORY_FILE` (env var or eliza config
 * env section) at a markdown file containing the instructions spawned task
 * agents should read on startup (project paths, deployment conventions, hard
 * rules, etc).
 *
 * If the env var is unset or the file can't be read, no memory content is
 * injected — task agents run with stock orchestrator defaults. That keeps
 * this source file reusable across deployments that have nothing in common
 * beyond the eliza runtime.
 *
 * Lazy + cached: the file is read once on the first action invocation per
 * process lifetime and the content is reused for every subsequent spawn.
 */
let cachedTaskAgentMemory: string | null = null;
let taskAgentMemoryLoaded = false;

function loadTaskAgentMemory(): string {
  if (taskAgentMemoryLoaded) return cachedTaskAgentMemory ?? "";
  taskAgentMemoryLoaded = true;
  const filePath = process.env.TASK_AGENT_MEMORY_FILE;
  if (!filePath) return "";
  try {
    const resolved = filePath.startsWith("~")
      ? path.join(os.homedir(), filePath.slice(1))
      : filePath;
    cachedTaskAgentMemory = fs.readFileSync(resolved, "utf-8");
    return cachedTaskAgentMemory;
  } catch {
    return "";
  }
}

/**
 * Wraps an orchestrator action so every invocation carries Eliza's default
 * task-agent memory content. Existing caller-supplied memoryContent is
 * preserved and appended after the defaults.
 */
function injectDefaultMemoryContent(action: Action | undefined): void {
  if (!action?.handler) return;
  const originalHandler = action.handler.bind(action);
  action.handler = async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    // Lazy install: the streamer + jsonl watcher both need a live runtime
    // and ptyService to wire up callbacks, neither of which exist at
    // module load time. First task spawn is the earliest both are
    // guaranteed. Both installers are idempotent per runtime.
    const pty = getPtyService(runtime);
    installTaskProgressStreamer(runtime, pty);
    installClaudeJsonlCompletionWatcher(runtime, pty);

    const parameters =
      (options?.parameters as Record<string, unknown> | undefined) ?? {};
    const existing =
      typeof parameters.memoryContent === "string"
        ? parameters.memoryContent
        : undefined;
    const deploymentMemory = loadTaskAgentMemory();
    let memoryContent: string | undefined;
    if (deploymentMemory && existing) {
      memoryContent = `${deploymentMemory}\n---\n\n${existing}`;
    } else if (deploymentMemory) {
      memoryContent = deploymentMemory;
    } else if (existing) {
      memoryContent = existing;
    }
    // Force autonomous approval for every eliza task agent. The LLM that
    // builds CREATE_TASK action params will sometimes pick "standard" or
    // "readonly" for tasks that it classifies as "research" or "non-coding",
    // which strips Write/Edit/Bash/WebSearch from the subagent's allow-list
    // and leaves it unable to actually do anything. On this deployment the
    // bot runs on a single-tenant VPS, hooked into agent-home, and is
    // intended to be fully autonomous — there is no scenario where a
    // restricted preset is the right call. Overriding here (rather than
    // server-wide via PTY_SERVICE_CONFIG.defaultApprovalPreset) keeps the
    // orchestrator plugin's default intact for other deployments.
    const nextOptions = {
      ...(options ?? {}),
      parameters: {
        ...parameters,
        ...(memoryContent !== undefined ? { memoryContent } : {}),
        approvalPreset: "autonomous",
      },
    } as HandlerOptions;
    return originalHandler(runtime, message, state, nextOptions, callback);
  };
}

function installListAgentsHandler(action: Action | undefined): void {
  if (!action) return;
  action.handler = async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    // Only respond to explicit slash commands. The runtime can pick this
    // action via fuzzy matching during action loops or coordinator events
    // even when the user never asked for status. Without this guard, the
    // bot spams the channel with "Active task agents" updates.
    const userText = (_message?.content?.text ?? "").trim();
    if (
      !userText.startsWith("/subagents") &&
      !userText.startsWith("/sub") &&
      !userText.startsWith("/agents") &&
      !userText.startsWith("/sessions")
    ) {
      return { success: false, text: "" };
    }

    const ptyService = getPtyService(runtime);
    if (!ptyService) {
      if (callback) {
        await callback({ text: "PTY Service is not available." });
      }
      return { success: false, error: "SERVICE_UNAVAILABLE" };
    }

    const sessions = await ptyService.listSessions();
    const coordinator = resolveCoordinator(runtime);
    const tasks = uniqueTaskList(coordinator?.getAllTaskContexts?.() ?? []);
    const frameworkState = await getFrameworkState(runtime, ptyService);

    if (sessions.length === 0 && tasks.length === 0) {
      const text = "No active task agents.";
      if (callback) {
        await callback({ text });
      }
      return {
        success: true,
        text,
        data: {
          sessions: [],
          tasks: [],
          preferredTaskAgent: frameworkState.preferred,
        },
      };
    }

    const lines: string[] = [];
    if (sessions.length > 0) {
      lines.push(`Active task agents (${sessions.length}):`);
      for (const session of sessions) {
        const label =
          typeof session.metadata?.label === "string"
            ? session.metadata.label
            : session.name;
        lines.push(
          `- "${label}" (${session.agentType}, ${formatStatus(session.status)}) [session: ${session.id}]`,
        );
      }
    }

    if (tasks.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(`Current task status (${tasks.length}):`);
      for (const task of tasks
        .slice()
        .sort((left, right) => right.registeredAt - left.registeredAt)) {
        const detail =
          task.completionSummary ||
          task.decisions.at(-1)?.reasoning ||
          truncateText(task.originalTask, 110);
        lines.push(
          `- [${task.status}] "${task.label}" (${task.agentType}) -> ${detail}`,
        );
      }
    }

    const pending = coordinator?.getPendingConfirmations?.() ?? [];
    if (pending.length > 0) {
      lines.push("");
      lines.push(
        `Pending confirmations: ${pending.length} (${coordinator?.getSupervisionLevel?.() ?? "unknown"} supervision).`,
      );
    }

    const text = lines.join("\n");
    if (callback) {
      await callback({ text });
    }
    return {
      success: true,
      text,
      data: {
        sessions: sessions.map((session) => ({
          id: session.id,
          agentType: session.agentType,
          status: session.status,
          workdir: session.workdir,
          createdAt: session.createdAt.toISOString(),
          lastActivity: session.lastActivityAt.toISOString(),
          label:
            typeof session.metadata?.label === "string"
              ? session.metadata.label
              : session.name,
        })),
        tasks: tasks.map((task) => ({
          sessionId: task.sessionId,
          agentType: task.agentType,
          label: task.label,
          status: task.status,
          originalTask: task.originalTask,
          completionSummary: task.completionSummary,
        })),
        pendingConfirmations: pending.length,
        preferredTaskAgent: frameworkState.preferred,
      },
    };
  };
}

function patchPluginSurface(): void {
  if (patched) return;
  patched = true;

  basePlugin.description =
    "Orchestrate open-ended task agents (Claude Code, Codex, Gemini CLI, Aider, Pi, etc.) via PTY sessions, " +
    "manage workspaces, track current task status, and keep background work moving while the main agent stays in conversation.";

  patchAction(
    "START_CODING_TASK",
    "CREATE_TASK",
    "Create one or more asynchronous task agents for any open-ended multi-step job. " +
      "Use this whenever the user needs work that should continue in the background: coding, debugging, research, writing, analysis, planning, documentation, or automation. " +
      "If a repo URL is provided it provisions the workspace automatically; otherwise the agent can run in scratch space.",
    [
      ...createActionExamples(
        "Take a complicated pass on https://github.com/acme/app: debug the failing login flow, fix it, run the tests, and summarize what changed.",
        "I'll create a background task agent for that repo, keep track of its status, and report back as it progresses.",
        "CREATE_TASK",
      ),
      ...createActionExamples(
        "Spin up a couple of sub-agents to research browser automation frameworks, compare them, and draft a recommendation.",
        "I'll coordinate a few task agents in parallel and keep the summary grounded in their findings.",
        "CREATE_TASK",
      ),
    ],
    ["START_AGENT_TASK", "LAUNCH_TASK", "CREATE_SUBTASK"],
  );

  patchAction(
    "SPAWN_CODING_AGENT",
    "SPAWN_AGENT",
    "Spawn a specific task agent inside an existing workspace when you need direct control. " +
      "These agents are intentionally open-ended and can handle far more than code: investigation, writing, planning, testing, synthesis, and repo work.",
    [
      ...createActionExamples(
        "Start a Codex task agent in that workspace and have it continue the investigation.",
        "I'll spawn a task agent in the current workspace and hand it the next chunk of work.",
        "SPAWN_AGENT",
      ),
    ],
    ["SPAWN_SUB_AGENT", "START_TASK_AGENT", "CREATE_AGENT"],
  );

  patchAction(
    "SEND_TO_CODING_AGENT",
    "SEND_TO_AGENT",
    "Send text or key presses to a running task agent. Use this when a sub-agent asks a question, needs approval, or should keep going with new instructions.",
    [
      ...createActionExamples(
        "Tell the running sub-agent to accept the change and keep going.",
        "I'll send that instruction to the running task agent.",
        "SEND_TO_AGENT",
      ),
    ],
    ["MESSAGE_AGENT", "RESPOND_TO_AGENT", "TELL_TASK_AGENT"],
  );

  patchAction(
    "STOP_CODING_AGENT",
    "STOP_AGENT",
    "Stop a running task agent or cancel all currently active task-agent sessions.",
    [
      ...createActionExamples(
        "Stop that task agent before it does more work.",
        "I'll stop the running task agent.",
        "STOP_AGENT",
      ),
    ],
    ["CANCEL_TASK_AGENT", "TERMINATE_AGENT", "STOP_SUB_AGENT"],
  );

  patchAction(
    "LIST_CODING_AGENTS",
    "LIST_AGENTS",
    "List active task agents together with current task progress so the main agent can keep the user updated while work continues asynchronously.",
    [
      ...createActionExamples(
        "What task agents are running right now and what are they doing?",
        "I'll pull the current task-agent status.",
        "LIST_AGENTS",
      ),
    ],
    ["SHOW_TASK_AGENTS", "LIST_SUB_AGENTS", "SHOW_TASK_STATUS"],
  );

  const provisionWorkspaceAction = baseActionMap.get("PROVISION_WORKSPACE");
  if (provisionWorkspaceAction) {
    provisionWorkspaceAction.description = renameTaskAgentText(
      provisionWorkspaceAction.description ?? "",
    );
  }

  const finalizeWorkspaceAction = baseActionMap.get("FINALIZE_WORKSPACE");
  if (finalizeWorkspaceAction) {
    finalizeWorkspaceAction.description = renameTaskAgentText(
      finalizeWorkspaceAction.description ?? "",
    );
  }

  for (const actionName of [
    "CREATE_TASK",
    "SPAWN_AGENT",
    "SEND_TO_AGENT",
    "STOP_AGENT",
  ]) {
    wrapActionHandler(baseActionMap.get(actionName), renameTaskAgentText);
  }

  injectPreferredAgentType(baseActionMap.get("SPAWN_AGENT"));
  injectDefaultMemoryContent(baseActionMap.get("CREATE_TASK"));
  injectDefaultMemoryContent(baseActionMap.get("SPAWN_AGENT"));
  installListAgentsHandler(baseActionMap.get("LIST_AGENTS"));

  basePlugin.providers = [
    createActiveWorkspaceContextProvider(),
    createTaskAgentExamplesProvider(),
  ];
}

function sendJson(res: http.ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function sendError(
  res: http.ServerResponse,
  message: string,
  status = 400,
): void {
  sendJson(res, { error: message }, status);
}

async function parseJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function parseThreadListOptions(rawUrl: string | undefined): {
  includeArchived?: boolean;
  status?: string;
  statuses?: string[];
  kind?: string;
  roomId?: string;
  worldId?: string;
  ownerUserId?: string;
  scenarioId?: string;
  batchId?: string;
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  latestActivityAfter?: number;
  latestActivityBefore?: number;
  hasActiveSession?: boolean;
  search?: string;
  limit?: number;
} {
  const url = new URL(
    rawUrl ?? "http://localhost/api/coding-agents/coordinator/threads",
    "http://localhost",
  );
  const status = url.searchParams.get("status") ?? undefined;
  const statusesRaw = url.searchParams.get("statuses");
  const statuses = statusesRaw
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const latestActivityAfterRaw = url.searchParams.get("latestActivityAfter");
  const latestActivityBeforeRaw = url.searchParams.get("latestActivityBefore");
  const hasActiveSessionRaw = url.searchParams.get("hasActiveSession");
  const limitRaw = url.searchParams.get("limit");

  return {
    includeArchived: url.searchParams.get("includeArchived") === "true",
    status: status ?? undefined,
    statuses,
    kind: url.searchParams.get("kind") ?? undefined,
    roomId: url.searchParams.get("roomId") ?? undefined,
    worldId: url.searchParams.get("worldId") ?? undefined,
    ownerUserId: url.searchParams.get("ownerUserId") ?? undefined,
    scenarioId: url.searchParams.get("scenarioId") ?? undefined,
    batchId: url.searchParams.get("batchId") ?? undefined,
    createdAfter: url.searchParams.get("createdAfter") ?? undefined,
    createdBefore: url.searchParams.get("createdBefore") ?? undefined,
    updatedAfter: url.searchParams.get("updatedAfter") ?? undefined,
    updatedBefore: url.searchParams.get("updatedBefore") ?? undefined,
    latestActivityAfter:
      latestActivityAfterRaw && Number.isFinite(Number(latestActivityAfterRaw))
        ? Number(latestActivityAfterRaw)
        : undefined,
    latestActivityBefore:
      latestActivityBeforeRaw &&
      Number.isFinite(Number(latestActivityBeforeRaw))
        ? Number(latestActivityBeforeRaw)
        : undefined,
    hasActiveSession:
      hasActiveSessionRaw === null ? undefined : hasActiveSessionRaw === "true",
    search: url.searchParams.get("search") ?? undefined,
    limit:
      limitRaw && Number.isFinite(Number(limitRaw))
        ? Number(limitRaw)
        : undefined,
  };
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

function detectShareCapabilities(): string[] {
  const config = readJsonFile(resolveElizaConfigPath());
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return [];
  }
  const gateway =
    typeof (config as Record<string, unknown>).gateway === "object" &&
    (config as Record<string, unknown>).gateway
      ? ((config as Record<string, unknown>).gateway as Record<string, unknown>)
      : null;
  const gatewayTailscale =
    gateway && typeof gateway.tailscale === "object" && gateway.tailscale
      ? (gateway.tailscale as Record<string, unknown>)
      : null;
  const gatewayRemote =
    gateway && typeof gateway.remote === "object" && gateway.remote
      ? (gateway.remote as Record<string, unknown>)
      : null;

  const capabilities: string[] = [];
  const tailscaleMode =
    typeof gatewayTailscale?.mode === "string" ? gatewayTailscale.mode : null;
  if (tailscaleMode && tailscaleMode !== "off") {
    capabilities.push(`tailscale:${tailscaleMode}`);
  }
  if (typeof gatewayRemote?.url === "string" && gatewayRemote.url.trim()) {
    capabilities.push("gateway-remote-url");
  }
  if (
    typeof gatewayRemote?.sshTarget === "string" &&
    gatewayRemote.sshTarget.trim()
  ) {
    capabilities.push("gateway-remote-ssh");
  }
  return capabilities;
}

function isRemoteAccessibleUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.trim().toLowerCase();
    return !["localhost", "127.0.0.1", "0.0.0.0"].includes(host);
  } catch {
    return false;
  }
}

function discoverTaskShareOptions(thread: TaskThreadDetail): {
  threadId: string;
  title: string;
  shareCapabilities: string[];
  preferredTarget: Record<string, unknown> | null;
  targets: Array<Record<string, unknown>>;
} {
  const targets: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  const pushTarget = (target: Record<string, unknown>) => {
    const type = typeof target.type === "string" ? target.type : "unknown";
    const value =
      typeof target.value === "string"
        ? target.value
        : JSON.stringify(target.value);
    const key = `${type}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };

  for (const artifact of thread.artifacts ?? []) {
    if (artifact.uri?.trim()) {
      pushTarget({
        type: "artifact_uri",
        label: artifact.title,
        value: artifact.uri,
        source: `artifact:${artifact.artifactType ?? "unknown"}`,
        remoteAccessible: isRemoteAccessibleUrl(artifact.uri),
      });
    }
    if (artifact.path?.trim()) {
      pushTarget({
        type: "artifact_path",
        label: artifact.title,
        value: artifact.path,
        source: `artifact:${artifact.artifactType ?? "unknown"}`,
        remoteAccessible: false,
      });
    }
  }

  const recentTranscript = (thread.transcripts ?? [])
    .slice(-100)
    .map((entry) => entry.content)
    .join("\n");
  const transcriptUrls = recentTranscript.match(URL_RE) ?? [];
  for (const value of transcriptUrls) {
    pushTarget({
      type: "preview_url",
      label: "Discovered URL",
      value,
      source: "transcript:url",
      remoteAccessible: isRemoteAccessibleUrl(value),
    });
  }

  if (thread.latestWorkdir?.trim()) {
    pushTarget({
      type: "workspace",
      label: "Workspace",
      value: thread.latestWorkdir,
      source: "thread:latest-workdir",
      remoteAccessible: false,
    });
  }

  const preferredTarget =
    targets.find((target) => target.remoteAccessible === true) ??
    targets.find((target) => target.type === "preview_url") ??
    targets[0] ??
    null;

  return {
    threadId: thread.id,
    title: thread.title,
    shareCapabilities: detectShareCapabilities(),
    preferredTarget,
    targets,
  };
}

async function handleSettingsRoute(
  runtime: IAgentRuntime,
  res: http.ServerResponse,
): Promise<boolean> {
  const ptyService = getPtyService(runtime);
  const frameworkState = await getFrameworkState(runtime, ptyService);
  sendJson(res, {
    defaultApprovalPreset: ptyService?.defaultApprovalPreset ?? "permissive",
    agentSelectionStrategy: ptyService?.agentSelectionStrategy ?? "fixed",
    defaultAgentType: frameworkState.preferred.id,
    preferredAgentType: frameworkState.preferred.id,
    preferredAgentReason: frameworkState.preferred.reason,
    configuredSubscriptionProvider:
      frameworkState.configuredSubscriptionProvider,
    frameworks: frameworkState.frameworks,
  });
  return true;
}

async function handleCoordinatorStatusRoute(
  runtime: IAgentRuntime,
  res: http.ServerResponse,
): Promise<boolean> {
  const coordinator = resolveCoordinator(runtime);
  if (!coordinator) return false;

  const ptyService = getPtyService(runtime);
  const frameworkState = await getFrameworkState(runtime, ptyService);
  const allTasks = uniqueTaskList(coordinator.getAllTaskContexts?.() ?? []);
  const persistedThreads = coordinator.listTaskThreads
    ? await coordinator.listTaskThreads({
        includeArchived: false,
        limit: 50,
      })
    : [];
  const activeTasks = allTasks.filter(
    (task) =>
      task.status !== "completed" &&
      task.status !== "stopped" &&
      task.status !== "error",
  );
  const recentTasks = allTasks
    .slice()
    .sort((left, right) => right.registeredAt - left.registeredAt)
    .slice(0, 10);

  sendJson(res, {
    supervisionLevel: coordinator.getSupervisionLevel?.() ?? "autonomous",
    taskCount: activeTasks.length,
    tasks: activeTasks.map((task) => ({
      threadId: task.threadId,
      sessionId: task.sessionId,
      agentType: task.agentType,
      label: task.label,
      originalTask: task.originalTask,
      workdir: task.workdir,
      status: task.status,
      decisionCount: task.decisions.length,
      autoResolvedCount: task.autoResolvedCount,
      completionSummary: task.completionSummary,
      lastActivityAt: task.lastActivityAt,
    })),
    recentTasks: recentTasks.map((task) => ({
      threadId: task.threadId,
      sessionId: task.sessionId,
      agentType: task.agentType,
      label: task.label,
      status: task.status,
      originalTask: task.originalTask,
      completionSummary: task.completionSummary,
      registeredAt: task.registeredAt,
      lastActivityAt: task.lastActivityAt,
    })),
    taskThreadCount: persistedThreads.length,
    taskThreads: persistedThreads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      kind: thread.kind,
      status: thread.status,
      scenarioId: thread.scenarioId,
      batchId: thread.batchId,
      originalRequest: thread.originalRequest,
      summary: thread.summary,
      sessionCount: thread.sessionCount,
      activeSessionCount: thread.activeSessionCount,
      latestSessionId: thread.latestSessionId,
      latestSessionLabel: thread.latestSessionLabel,
      latestWorkdir: thread.latestWorkdir,
      latestRepo: thread.latestRepo,
      latestActivityAt: thread.latestActivityAt,
      decisionCount: thread.decisionCount,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      closedAt: thread.closedAt,
      archivedAt: thread.archivedAt,
    })),
    pendingConfirmations: coordinator.getPendingConfirmations?.().length ?? 0,
    preferredAgentType: frameworkState.preferred.id,
    preferredAgentReason: frameworkState.preferred.reason,
    frameworks: frameworkState.frameworks,
  });
  return true;
}

function patchPtyServiceClass(): void {
  const ptyServiceClass = PTYService;
  if (!ptyServiceClass || typeof ptyServiceClass !== "function") return;

  const prototype = ptyServiceClass.prototype as unknown as Record<string, unknown>;
  const originalResolveAgentType = prototype.resolveAgentType as
    | ((this: PTYServiceLike) => Promise<string>)
    | undefined;

  if (typeof originalResolveAgentType === "function") {
    prototype.resolveAgentType = async function (this: PTYServiceLike) {
      const runtime = (this as unknown as { runtime?: IAgentRuntime }).runtime;
      if (!runtime) {
        return originalResolveAgentType.call(this);
      }
      const frameworkState = await getFrameworkState(runtime, this);
      return frameworkState.preferred.id;
    };
  }

  const originalStart = (ptyServiceClass as { start?: unknown }).start as
    | ((runtime: IAgentRuntime) => Promise<unknown>)
    | undefined;
  if (typeof originalStart === "function") {
    (
      ptyServiceClass as unknown as {
        start: (runtime: IAgentRuntime) => Promise<unknown>;
      }
    ).start = async (runtime: IAgentRuntime) => {
      const service = await originalStart(runtime);
      if (service && typeof service === "object") {
        (
          service as {
            capabilityDescription?: string;
          }
        ).capabilityDescription =
          "Manages asynchronous PTY task-agent sessions for open-ended background work";
      }
      return service;
    };
  }
}

patchPluginSurface();
patchPtyServiceClass();

/** @public Shipped plugin instance (includes action aliases, route extensions, and PTY patches). */
export function createAgentOrchestratorPlugin(): Plugin {
  return basePlugin;
}

export function createCodingAgentRouteHandler(
  runtime: IAgentRuntime,
  coordinator?: unknown,
): PatchedRouteHandler {
  const baseHandler = baseCreateCodingAgentRouteHandler(
    runtime,
    coordinator as SwarmCoordinator | undefined,
  );

  return async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    method = req.method ?? "GET",
  ): Promise<boolean> => {
    if (method === "GET" && pathname === "/api/coding-agents/settings") {
      return handleSettingsRoute(runtime, res);
    }
    if (
      method === "GET" &&
      pathname === "/api/coding-agents/coordinator/status"
    ) {
      return handleCoordinatorStatusRoute(runtime, res);
    }
    if (
      method === "GET" &&
      pathname === "/api/coding-agents/coordinator/threads"
    ) {
      const resolvedCoordinator = resolveCoordinator(runtime);
      if (!resolvedCoordinator?.listTaskThreads) return false;
      sendJson(
        res,
        await resolvedCoordinator.listTaskThreads(
          parseThreadListOptions(req.url),
        ),
      );
      return true;
    }
    if (
      method === "GET" &&
      pathname === "/api/coding-agents/coordinator/threads/count"
    ) {
      const resolvedCoordinator = resolveCoordinator(runtime);
      if (!resolvedCoordinator?.countTaskThreads) return false;
      const options = parseThreadListOptions(req.url);
      const { limit: _limit, ...countOptions } = options;
      sendJson(res, {
        total: await resolvedCoordinator.countTaskThreads(countOptions),
      });
      return true;
    }
    const threadMatch = pathname.match(
      /^\/api\/coding-agents\/coordinator\/threads\/([^/]+)$/,
    );
    if (method === "GET" && threadMatch) {
      const resolvedCoordinator = resolveCoordinator(runtime);
      if (!resolvedCoordinator?.getTaskThread) return false;
      const thread = await resolvedCoordinator.getTaskThread(threadMatch[1]);
      if (!thread) {
        sendError(res, "Task thread not found", 404);
        return true;
      }
      sendJson(res, thread);
      return true;
    }
    const shareMatch = pathname.match(
      /^\/api\/coding-agents\/coordinator\/threads\/([^/]+)\/share$/,
    );
    if (method === "GET" && shareMatch) {
      const resolvedCoordinator = resolveCoordinator(runtime);
      if (!resolvedCoordinator?.getTaskThread) return false;
      const thread = await resolvedCoordinator.getTaskThread(shareMatch[1]);
      if (!thread) {
        sendError(res, "Task thread not found", 404);
        return true;
      }
      sendJson(res, discoverTaskShareOptions(thread));
      return true;
    }
    const archiveMatch = pathname.match(
      /^\/api\/coding-agents\/coordinator\/threads\/([^/]+)\/archive$/,
    );
    if (method === "POST" && archiveMatch) {
      const resolvedCoordinator = resolveCoordinator(runtime);
      if (!resolvedCoordinator?.archiveTaskThread) return false;
      await resolvedCoordinator.archiveTaskThread(archiveMatch[1]);
      sendJson(res, {
        success: true,
        threadId: archiveMatch[1],
        status: "archived",
      });
      return true;
    }
    const reopenMatch = pathname.match(
      /^\/api\/coding-agents\/coordinator\/threads\/([^/]+)\/reopen$/,
    );
    if (method === "POST" && reopenMatch) {
      const resolvedCoordinator = resolveCoordinator(runtime);
      if (!resolvedCoordinator?.reopenTaskThread) return false;
      await resolvedCoordinator.reopenTaskThread(reopenMatch[1]);
      sendJson(res, {
        success: true,
        threadId: reopenMatch[1],
        status: "open",
      });
      return true;
    }
    const controlMatch = pathname.match(
      /^\/api\/coding-agents\/coordinator\/threads\/([^/]+)\/control$/,
    );
    if (method === "POST" && controlMatch) {
      const resolvedCoordinator = resolveCoordinator(runtime);
      if (!resolvedCoordinator) return false;
      const body = await parseJsonBody(req);
      const action = typeof body.action === "string" ? body.action.trim() : "";
      const note = typeof body.note === "string" ? body.note : undefined;
      const instruction =
        typeof body.instruction === "string" ? body.instruction : undefined;
      const agentType =
        typeof body.agentType === "string" ? body.agentType : undefined;

      if (action === "pause" && resolvedCoordinator.pauseTaskThread) {
        sendJson(res, {
          success: true,
          action,
          ...(await resolvedCoordinator.pauseTaskThread(controlMatch[1], note)),
        });
        return true;
      }
      if (action === "stop" && resolvedCoordinator.stopTaskThread) {
        sendJson(res, {
          success: true,
          action,
          ...(await resolvedCoordinator.stopTaskThread(controlMatch[1], note)),
        });
        return true;
      }
      if (action === "resume" && resolvedCoordinator.resumeTaskThread) {
        sendJson(res, {
          success: true,
          action,
          ...(await resolvedCoordinator.resumeTaskThread(
            controlMatch[1],
            instruction,
            agentType,
          )),
        });
        return true;
      }
      if (action === "continue" && resolvedCoordinator.continueTaskThread) {
        sendJson(res, {
          success: true,
          action,
          ...(await resolvedCoordinator.continueTaskThread(
            controlMatch[1],
            instruction ?? `Continue task thread ${controlMatch[1]}.`,
            agentType,
          )),
        });
        return true;
      }

      sendError(
        res,
        'Invalid control action. Must be "pause", "stop", "resume", or "continue".',
        400,
      );
      return true;
    }
    return baseHandler ? baseHandler(req, res, pathname) : false;
  };
}

export { CodingWorkspaceService, PTYService };
export const getCoordinator = (runtime: IAgentRuntime): unknown =>
  resolveCoordinator(runtime);
export const taskAgentPlugin = basePlugin;
export const codingAgentPlugin = basePlugin;

export default basePlugin;
