import {
  type ChildProcessByStdio,
  execFile as execFileCallback,
  spawn as spawnChildProcess,
} from "node:child_process";
import type { Readable } from "node:stream";
import type { IAgentRuntime } from "@elizaos/core";
import type { PreflightResult } from "coding-agent-adapters";
import { readConfigCloudKey, readConfigEnvKey } from "./config-env.js";
import type { SupportedTaskAgentAdapter } from "./task-agent-frameworks.js";

export type TaskAgentAuthStatusValue =
  | "authenticated"
  | "auth_error"
  | "unauthenticated"
  | "unknown";

export interface TaskAgentAuthStatus {
  status: TaskAgentAuthStatusValue;
  method?: string;
  detail?: string;
  loginHint?: string;
}

export interface TaskAgentAuthLaunchResult {
  launched: boolean;
  url?: string;
  deviceCode?: string;
  instructions?: string;
  browserOpened?: boolean;
  browserClicked?: boolean;
  browserDetail?: string;
  recoveryTarget?: "same_session" | "replacement_session";
  replacementSessionId?: string;
  replacementFramework?: string;
}

export interface TaskAgentAuthFlowHandle {
  agentType: SupportedTaskAgentAdapter;
  startedAt: number;
  completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  snapshot: () => TaskAgentAuthLaunchResult;
  stop: () => void;
}

function toPreflightAuthStatus(
  auth: TaskAgentAuthStatus,
): PreflightResult["auth"] {
  return {
    status: auth.status === "auth_error" ? "unauthenticated" : auth.status,
    method: auth.method,
    detail: auth.detail,
    loginHint: auth.loginHint,
  };
}

type ExecFileFn = (
  file: string,
  args: string[],
  options?: {
    encoding?: BufferEncoding;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

type SpawnFn = typeof spawnChildProcess;

type FetchFn = typeof fetch;

interface TaskAgentAuthDeps {
  execFile: ExecFileFn;
  fetch: FetchFn;
  spawn: SpawnFn;
}

interface TaskAgentAuthOptions {
  deps?: Partial<TaskAgentAuthDeps>;
  env?: NodeJS.ProcessEnv;
  runtime?: IAgentRuntime;
}

const DEFAULT_TRUSTED_AUTH_HOSTS = new Set([
  "claude.ai",
  "claude.com",
  "auth.openai.com",
  "chatgpt.com",
  "openai.com",
  "127.0.0.1",
  "localhost",
]);

const DEFAULT_INITIAL_AUTH_WAIT_MS = 2_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_BROWSER_ASSIST_TIMEOUT_MS = 750;
const CLAUDE_NON_INTERACTIVE_AUTH_FAILURE_RE =
  /\b401\b|\binvalid authentication credentials\b|\bauthentication_error\b|\bfailed to authenticate\b/i;

const DEFAULT_BROWSER_CLICK_SELECTORS: Record<
  SupportedTaskAgentAdapter,
  string[]
> = {
  claude: [
    'role=button[name="Continue"]',
    'role=button[name="Sign in"]',
    'role=button[name="Log in"]',
    'role=button[name="Authorize"]',
    'role=button[name="Allow"]',
    'button[type="submit"]',
  ],
  codex: [
    'role=button[name="Continue"]',
    'role=button[name="Sign in"]',
    'role=button[name="Log in"]',
    'role=button[name="Authorize"]',
    'role=button[name="Allow"]',
    'button[type="submit"]',
  ],
  gemini: ['role=button[name="Continue"]', 'button[type="submit"]'],
  aider: ['role=button[name="Continue"]', 'button[type="submit"]'],
};

function parseTaskAgentAuthStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value !== "string") {
    return [];
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean);
    }
  } catch {
    // Fall back to comma/newline-delimited values.
  }
  return trimmed
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function defaultExecFile(
  file: string,
  args: string[],
  options?: {
    encoding?: BufferEncoding;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCallback(
      file,
      args,
      {
        encoding: options?.encoding ?? "utf8",
        env: options?.env,
        timeout: options?.timeout,
        // On Windows, execFile uses libuv uv_spawn which does not apply PATHEXT
        // extension resolution — so bare names like "claude" fail to find "claude.cmd".
        // shell:true routes through cmd.exe which handles PATHEXT correctly.
        shell: process.platform === "win32",
      },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = new Error(
            stderr?.trim() || stdout?.trim() || error.message,
          ) as Error & { stdout?: string; stderr?: string; cause?: unknown };
          wrapped.stdout = stdout;
          wrapped.stderr = stderr;
          wrapped.cause = error;
          reject(wrapped);
          return;
        }
        resolve({
          stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
          stderr: typeof stderr === "string" ? stderr : String(stderr ?? ""),
        });
      },
    );
  });
}

function getDeps(overrides?: Partial<TaskAgentAuthDeps>): TaskAgentAuthDeps {
  return {
    execFile: overrides?.execFile ?? defaultExecFile,
    fetch: overrides?.fetch ?? fetch,
    spawn: overrides?.spawn ?? spawnChildProcess,
  };
}

function safeRuntimeSetting(
  runtime: IAgentRuntime | undefined,
  key: string,
): string | undefined {
  const value = runtime?.getSetting(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function runtimeSettingValue(
  runtime: IAgentRuntime | undefined,
  key: string,
): unknown {
  return runtime?.getSetting(key);
}

function readTaskAgentAuthSetting(
  runtime: IAgentRuntime | undefined,
  env: NodeJS.ProcessEnv,
  keys: string[],
): unknown {
  for (const key of keys) {
    const runtimeValue = runtimeSettingValue(runtime, key);
    if (
      runtimeValue !== undefined &&
      runtimeValue !== null &&
      (!Array.isArray(runtimeValue) ||
        runtimeValue.some(
          (entry) => !(typeof entry === "string" && !entry.trim()),
        ))
    ) {
      return runtimeValue;
    }
    const envValue = env[key];
    if (typeof envValue === "string" && envValue.trim()) {
      return envValue.trim();
    }
  }
  return undefined;
}

function parseHttpBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (!/^https?:$/i.test(parsed.protocol)) {
      return null;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function getConfiguredTaskAgentAuthHosts(
  runtime: IAgentRuntime | undefined,
  env: NodeJS.ProcessEnv,
): Set<string> {
  const configured = parseTaskAgentAuthStringList(
    readTaskAgentAuthSetting(runtime, env, [
      "TASK_AGENT_AUTH_TRUSTED_HOSTS",
      "ELIZA_TASK_AGENT_AUTH_TRUSTED_HOSTS",
    ]),
  );
  return new Set([
    ...DEFAULT_TRUSTED_AUTH_HOSTS,
    ...configured.map((host) => host.toLowerCase()),
  ]);
}

function getTaskAgentBrowserClickSelectors(
  agentType: SupportedTaskAgentAdapter,
  runtime: IAgentRuntime | undefined,
  env: NodeJS.ProcessEnv,
): string[] {
  const suffix = agentType.toUpperCase();
  const configured = parseTaskAgentAuthStringList(
    readTaskAgentAuthSetting(runtime, env, [
      `TASK_AGENT_AUTH_SELECTORS_${suffix}`,
      `ELIZA_TASK_AGENT_AUTH_SELECTORS_${suffix}`,
    ]),
  );
  return Array.from(
    new Set([...configured, ...DEFAULT_BROWSER_CLICK_SELECTORS[agentType]]),
  );
}

function normalizeTaskAgentAuthText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeTaskAgentAdapterId(
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

export function getTaskAgentLoginHint(
  agentType: SupportedTaskAgentAdapter,
): string | undefined {
  switch (agentType) {
    case "claude":
      return "Run `claude setup-token` to refresh Claude Code non-interactive subscription auth, or `claude auth login --claudeai` if the CLI is logged out.";
    case "codex":
      return "codex login";
    case "gemini":
      return "Run /auth inside the Gemini CLI session or configure a Google AI API key.";
    case "aider":
      return "Configure an API key for Aider (for example OPENAI_API_KEY or ANTHROPIC_API_KEY).";
  }
}

export function isTaskAgentNonInteractiveAuthFailure(
  agentType: SupportedTaskAgentAdapter,
  ...details: Array<string | undefined>
): boolean {
  if (agentType !== "claude") {
    return false;
  }
  return details.some(
    (detail) =>
      typeof detail === "string" &&
      CLAUDE_NON_INTERACTIVE_AUTH_FAILURE_RE.test(detail),
  );
}

function mergeAuthOutput(
  current: TaskAgentAuthLaunchResult,
  next: Partial<TaskAgentAuthLaunchResult>,
): TaskAgentAuthLaunchResult {
  return {
    ...current,
    ...Object.fromEntries(
      Object.entries(next).filter(([, value]) => value !== undefined),
    ),
  };
}

function extractTaskAgentAuthHints(
  output: string,
): Partial<TaskAgentAuthLaunchResult> {
  const hints: Partial<TaskAgentAuthLaunchResult> = {};
  const urlMatch = output.match(/https?:\/\/[^\s"'<>]+/i);
  if (urlMatch?.[0]) {
    hints.url = urlMatch[0];
  }
  const deviceCodeMatch = output.match(
    /\b(?:device code|enter code|code)[:\s]+([A-Z0-9-]{4,})\b/i,
  );
  if (deviceCodeMatch?.[1]) {
    hints.deviceCode = deviceCodeMatch[1];
  }
  const trimmed = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(" ");
  if (trimmed) {
    hints.instructions = trimmed;
  }
  return hints;
}

function hasGeminiCredential(runtime?: IAgentRuntime): boolean {
  return Boolean(
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
      process.env.GOOGLE_API_KEY?.trim() ||
      readConfigEnvKey("GOOGLE_GENERATIVE_AI_API_KEY") ||
      readConfigEnvKey("GOOGLE_API_KEY") ||
      safeRuntimeSetting(runtime, "GOOGLE_GENERATIVE_AI_API_KEY") ||
      safeRuntimeSetting(runtime, "GOOGLE_API_KEY"),
  );
}

function hasAiderCredential(runtime?: IAgentRuntime): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
      process.env.GOOGLE_API_KEY?.trim() ||
      readConfigEnvKey("ANTHROPIC_API_KEY") ||
      readConfigEnvKey("OPENAI_API_KEY") ||
      readConfigEnvKey("GOOGLE_GENERATIVE_AI_API_KEY") ||
      readConfigEnvKey("GOOGLE_API_KEY") ||
      safeRuntimeSetting(runtime, "ANTHROPIC_API_KEY") ||
      safeRuntimeSetting(runtime, "OPENAI_API_KEY") ||
      safeRuntimeSetting(runtime, "GOOGLE_GENERATIVE_AI_API_KEY") ||
      safeRuntimeSetting(runtime, "GOOGLE_API_KEY"),
  );
}

function hasCloudProxyCredential(): boolean {
  return Boolean(readConfigCloudKey("apiKey"));
}

export async function probeTaskAgentAuth(
  agentType: SupportedTaskAgentAdapter,
  options: TaskAgentAuthOptions = {},
): Promise<TaskAgentAuthStatus> {
  const deps = getDeps(options.deps);
  const env = options.env ?? process.env;
  switch (agentType) {
    case "claude": {
      try {
        const { stdout, stderr } = await deps.execFile(
          "claude",
          ["auth", "status"],
          {
            encoding: "utf8",
            env,
            timeout: DEFAULT_COMMAND_TIMEOUT_MS,
          },
        );
        const combined = `${stdout}\n${stderr}`.trim();
        try {
          const parsed = JSON.parse(combined) as {
            loggedIn?: boolean;
            authMethod?: string;
          };
          if (parsed.loggedIn === true) {
            return {
              status: "authenticated",
              method:
                normalizeTaskAgentAuthText(parsed.authMethod) ?? "claude.ai",
            };
          }
          if (parsed.loggedIn === false) {
            return {
              status: "unauthenticated",
              method: normalizeTaskAgentAuthText(parsed.authMethod),
              loginHint: getTaskAgentLoginHint(agentType),
            };
          }
        } catch {
          if (/\blogged in\b/i.test(combined)) {
            return {
              status: "authenticated",
              method: "claude.ai",
            };
          }
        }
        return {
          status: "unknown",
          detail: combined || "Unable to determine Claude Code auth status.",
          loginHint: getTaskAgentLoginHint(agentType),
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          status:
            /\bnot logged in\b|\bunauthenticated\b|\binvalid authentication credentials\b/i.test(
              detail,
            )
              ? "unauthenticated"
              : "unknown",
          detail,
          loginHint: getTaskAgentLoginHint(agentType),
        };
      }
    }
    case "codex": {
      try {
        const { stdout, stderr } = await deps.execFile(
          "codex",
          ["login", "status"],
          {
            encoding: "utf8",
            env,
            timeout: DEFAULT_COMMAND_TIMEOUT_MS,
          },
        );
        const combined = `${stdout}\n${stderr}`.trim();
        if (/\bnot logged in\b|\bno stored credentials\b/i.test(combined)) {
          return {
            status: "unauthenticated",
            loginHint: getTaskAgentLoginHint(agentType),
          };
        }
        if (/\blogged in\b/i.test(combined)) {
          return {
            status: "authenticated",
            method: combined.replace(/\s+/g, " ").trim(),
          };
        }
        return {
          status: "unknown",
          detail: combined || "Unable to determine Codex auth status.",
          loginHint: getTaskAgentLoginHint(agentType),
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          status: /\bnot logged in\b|\bunauthenticated\b/i.test(detail)
            ? "unauthenticated"
            : "unknown",
          detail,
          loginHint: getTaskAgentLoginHint(agentType),
        };
      }
    }
    case "gemini":
      if (hasGeminiCredential(options.runtime)) {
        return { status: "authenticated", method: "api_key" };
      }
      return {
        status: "unauthenticated",
        loginHint: getTaskAgentLoginHint(agentType),
      };
    case "aider":
      if (hasCloudProxyCredential() || hasAiderCredential(options.runtime)) {
        return {
          status: "authenticated",
          method: hasCloudProxyCredential() ? "cloud" : "api_key",
        };
      }
      return {
        status: "unauthenticated",
        loginHint: getTaskAgentLoginHint(agentType),
      };
  }
}

function getTaskAgentAuthCommand(
  agentType: SupportedTaskAgentAdapter,
): { command: string; args: string[] } | null {
  switch (agentType) {
    case "claude":
      return { command: "claude", args: ["auth", "login", "--claudeai"] };
    case "codex":
      return { command: "codex", args: ["login"] };
    default:
      return null;
  }
}

export async function launchTaskAgentAuthFlow(
  agentType: SupportedTaskAgentAdapter,
  options: TaskAgentAuthOptions = {},
): Promise<{
  handle: TaskAgentAuthFlowHandle | null;
  result: TaskAgentAuthLaunchResult;
}> {
  const command = getTaskAgentAuthCommand(agentType);
  if (!command) {
    return {
      handle: null,
      result: {
        launched: false,
        instructions:
          getTaskAgentLoginHint(agentType) ??
          `No automated auth flow is available for ${agentType}.`,
      },
    };
  }

  const deps = getDeps(options.deps);
  const env = options.env ?? process.env;
  const child = deps.spawn(command.command, command.args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // On Windows, .cmd files require the shell to resolve PATHEXT extensions.
    shell: process.platform === "win32",
  });
  const childProcess: ChildProcessByStdio<null, Readable, Readable> = child;

  let current: TaskAgentAuthLaunchResult = {
    launched: true,
    instructions: `Starting ${agentType} authentication…`,
  };
  let handle!: TaskAgentAuthFlowHandle;
  let settled = false;
  let resolveInitial:
    | ((value: {
        handle: TaskAgentAuthFlowHandle;
        result: TaskAgentAuthLaunchResult;
      }) => void)
    | null = null;
  const initialPromise = new Promise<{
    handle: TaskAgentAuthFlowHandle;
    result: TaskAgentAuthLaunchResult;
  }>((resolve) => {
    resolveInitial = resolve;
  });

  const settleInitial = (handle: TaskAgentAuthFlowHandle): void => {
    if (settled) return;
    settled = true;
    resolveInitial?.({ handle, result: { ...current } });
  };

  const applyOutput = (chunk: string): void => {
    const text = chunk.trim();
    if (!text) return;
    current = mergeAuthOutput(current, extractTaskAgentAuthHints(text));
    if (current.url || current.deviceCode) {
      settleInitial(handle);
    }
  };

  childProcess.stdout.setEncoding("utf8");
  childProcess.stderr.setEncoding("utf8");
  childProcess.stdout.on("data", (chunk: string) => applyOutput(chunk));
  childProcess.stderr.on("data", (chunk: string) => applyOutput(chunk));

  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("error", (error) => {
      current = mergeAuthOutput(current, {
        launched: false,
        instructions: error.message,
      });
      settleInitial(handle);
      resolve({ code: null, signal: null });
    });
    child.once("exit", (code, signal) => {
      settleInitial(handle);
      resolve({ code, signal });
    });
  });

  handle = {
    agentType,
    startedAt: Date.now(),
    completion,
    snapshot: () => ({ ...current }),
    stop: () => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    },
  };

  setTimeout(() => settleInitial(handle), DEFAULT_INITIAL_AUTH_WAIT_MS);

  return await initialPromise;
}

function resolveLocalApiBaseUrl(
  runtime: IAgentRuntime | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const configured = parseHttpBaseUrl(
    readTaskAgentAuthSetting(runtime, env, [
      "TASK_AGENT_AUTH_API_BASE_URL",
      "ELIZA_TASK_AGENT_AUTH_API_BASE_URL",
    ]),
  );
  if (configured) {
    return configured;
  }
  const rawPort =
    safeRuntimeSetting(runtime, "SERVER_PORT") ||
    env.SERVER_PORT?.trim() ||
    env.ELIZA_API_PORT?.trim() ||
    env.ELIZA_PORT?.trim() ||
    "31337";
  return `http://127.0.0.1:${rawPort}`;
}

function isTrustedTaskAgentAuthUrl(
  rawUrl: string,
  runtime: IAgentRuntime | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (!/^https?:$/i.test(parsed.protocol)) return false;
    return getConfiguredTaskAgentAuthHosts(runtime, env).has(
      parsed.hostname.toLowerCase(),
    );
  } catch {
    return false;
  }
}

export async function assistTaskAgentBrowserLogin(
  agentType: SupportedTaskAgentAdapter,
  rawUrl: string,
  options: TaskAgentAuthOptions = {},
): Promise<{
  opened: boolean;
  clicked: boolean;
  detail?: string;
}> {
  const deps = getDeps(options.deps);
  const env = options.env ?? process.env;
  const commandUrl = `${resolveLocalApiBaseUrl(
    options.runtime,
    env,
  )}/api/browser-workspace/command`;
  const selectors = getTaskAgentBrowserClickSelectors(
    agentType,
    options.runtime,
    env,
  );
  if (!rawUrl.trim()) {
    return { opened: false, clicked: false, detail: "Missing auth URL." };
  }
  if (!isTrustedTaskAgentAuthUrl(rawUrl, options.runtime, env)) {
    return {
      opened: false,
      clicked: false,
      detail: `Refused to auto-open untrusted auth URL: ${rawUrl}`,
    };
  }

  try {
    const openResponse = await deps.fetch(commandUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subaction: "open",
        show: true,
        url: rawUrl,
      }),
    });
    if (!openResponse.ok) {
      return {
        opened: false,
        clicked: false,
        detail: `Browser workspace open failed with ${openResponse.status}.`,
      };
    }
    const openedPayload = (await openResponse.json()) as {
      tab?: { id?: string };
    };
    const tabId = openedPayload.tab?.id;
    if (!tabId) {
      return {
        opened: true,
        clicked: false,
        detail: "Browser workspace opened the auth page without a tab id.",
      };
    }

    const waitResponse = await deps
      .fetch(commandUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subaction: "wait",
          id: tabId,
          timeoutMs: DEFAULT_BROWSER_ASSIST_TIMEOUT_MS,
        }),
      })
      .catch(() => null);
    if (waitResponse && !waitResponse.ok) {
      // Ignore wait failures. The click probes below are still safe.
    }

    for (const selector of selectors) {
      const clickResponse = await deps
        .fetch(commandUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subaction: "click",
            id: tabId,
            selector,
          }),
        })
        .catch(() => null);
      if (clickResponse?.ok) {
        return {
          opened: true,
          clicked: true,
        };
      }
    }

    return {
      opened: true,
      clicked: false,
      detail:
        "Opened the provider sign-in page. No trusted first-party button was clicked automatically.",
    };
  } catch (error) {
    return {
      opened: false,
      clicked: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function augmentTaskAgentPreflightResults(
  results: PreflightResult[],
  options: TaskAgentAuthOptions = {},
): Promise<PreflightResult[]> {
  return await Promise.all(
    results.map(async (result) => {
      const adapterId = normalizeTaskAgentAdapterId(result.adapter);
      if (!adapterId) return result;
      const auth = await probeTaskAgentAuth(adapterId, options);
      return {
        ...result,
        auth: toPreflightAuthStatus(auth),
      } satisfies PreflightResult;
    }),
  );
}
