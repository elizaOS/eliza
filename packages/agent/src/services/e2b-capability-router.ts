/**
 * ElizaCapabilityRouter implementation that routes filesystem, terminal (pty),
 * and Git capabilities to a remote coding runner instead of the local host.
 * Three backends sit behind one provider-neutral surface: the `e2b` sandbox
 * (via the @elizaos/plugin-e2b-sandbox factory service), an `eliza-cloud`
 * coding container (provisioned over the Cloud API, then driven over its HTTP
 * runner contract), and a `home` machine HTTP runner. `resolveE2BRemoteRunnerConfig`
 * reads provider selection and credentials from runtime settings / env, and
 * `registerE2BRemoteCapabilityRouterIfEnabled` installs the service under
 * CAPABILITY_ROUTER_SERVICE_TYPE. Every path is mapped from the host workspace
 * root into the remote workdir and rejected if it escapes that root; model and
 * remote-plugin capabilities are intentionally unavailable on this router.
 */
import { randomUUID } from "node:crypto";
import nodePath from "node:path";
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type CapabilityAvailability,
  CapabilityError,
  type CapabilityName,
  E2B_SANDBOX_FACTORY_SERVICE_TYPE,
  type E2BSandboxClient,
  type E2BSandboxFactoryService,
  type ElizaCapabilityRouter,
  ElizaError,
  type FileListParams,
  type FileListResult,
  type FileReadTextParams,
  type FileReadTextResult,
  type FileStat,
  type FileWriteTextParams,
  type FileWriteTextResult,
  type GitCommandRunParams,
  type GitCommandRunResult,
  type GitDiffParams,
  type GitDiffResult,
  type GitStatusParams,
  type GitStatusResult,
  type IAgentRuntime,
  isBlockedHostname,
  isPrivateIpAddress,
  type JsonObject,
  type LocalModelStatusResult,
  logger,
  normalizeSandboxEntryType,
  type RemotePluginCapability,
  type SandboxCommandResult,
  type SandboxCommandRunOptions,
  type SandboxEntryInfo,
  Service,
  type TerminalRunParams,
  type TerminalRunResult,
} from "@elizaos/core";

export type {
  E2BSandboxClient,
  SandboxCommandResult,
  SandboxCommandRunOptions,
  SandboxEntryInfo,
} from "@elizaos/core";

const LOG_CONTEXT = { src: "service:e2b_remote_capability_router" } as const;
const DEFAULT_E2B_WORKDIR = "/home/user";
const DEFAULT_REMOTE_WORKDIR = "/workspace";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 1000;
const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_REMOTE_JSON_BYTES = 1024 * 1024;
const MAX_REMOTE_ERROR_BYTES = 16 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Default Eliza Cloud API base for the `eliza-cloud` sandbox provider. Exported
 * so the contract test asserts against this value instead of restating the host
 * as a literal, which is how it silently went stale across the eliza.app
 * consolidation.
 */
export const DEFAULT_ELIZA_CLOUD_API_BASE_URL = "https://api.eliza.app/api/v1";

export type CodingAgentRunner = "claude-code" | "codex";

export type SandboxRunnerProvider = "e2b" | "eliza-cloud" | "home";

// Third-party sandbox backends should sit behind Eliza Cloud until we expose
// them as reviewed product options instead of direct user-facing providers.
type DisabledSandboxRunnerProvider = "cloudflare" | "rivet" | "vercel";

const DEFAULT_SANDBOX_AGENT_RUNNERS: CodingAgentRunner[] = [
  "codex",
  "claude-code",
];

export interface E2BRemoteRunnerConfig {
  enabled: boolean;
  provider: SandboxRunnerProvider;
  apiKey?: string;
  accessToken?: string;
  domain?: string;
  sandboxId?: string;
  template?: string;
  cloudApiBaseUrl?: string;
  cloudApiToken?: string;
  cloudContainerImage?: string;
  remoteHttpBaseUrl?: string;
  remoteHttpToken?: string;
  remoteAccessUrl?: string;
  agentRunners: CodingAgentRunner[];
  workdir: string;
  hostWorkspaceRoot: string;
  timeoutMs: number;
  requestTimeoutMs: number;
  keepAlive: boolean;
  allowInternetAccess: boolean;
  bootstrapGitUrl?: string;
  bootstrapGitRef?: string;
  envs: Record<string, string>;
  metadata: Record<string, string>;
}

export interface E2BSandboxFactory {
  create(config: E2BRemoteRunnerConfig): Promise<E2BSandboxClient>;
}

// The e2b (`e2b.dev`) SDK backend lives in `@elizaos/plugin-e2b-sandbox`, which
// registers an `E2BSandboxFactoryService` under `E2B_SANDBOX_FACTORY_SERVICE_TYPE`.
// The router keeps the provider-neutral selection here and the eliza-cloud /
// home HTTP runners below; the `e2b` provider is only reachable when the plugin
// service is registered.
class DefaultSandboxFactory implements E2BSandboxFactory {
  private readonly remoteHttpFactory = new RemoteRunnerHttpFactory();
  private readonly cloudFactory = new ElizaCloudCodingContainerFactory(
    this.remoteHttpFactory,
  );

  constructor(private readonly runtime: IAgentRuntime) {}

  async create(config: E2BRemoteRunnerConfig): Promise<E2BSandboxClient> {
    if (config.provider === "eliza-cloud") {
      if (config.remoteHttpBaseUrl) {
        return this.remoteHttpFactory.create(config);
      }
      return this.cloudFactory.create(config);
    }
    if (config.provider === "home") {
      return this.remoteHttpFactory.create(config);
    }
    const factory = this.runtime.getService<E2BSandboxFactoryService>(
      E2B_SANDBOX_FACTORY_SERVICE_TYPE,
    );
    if (!factory) {
      throw new CapabilityError({
        code: "CAPABILITY_UNAVAILABLE",
        capability: "fs",
        method: "sandbox.create",
        message:
          "E2B sandbox provider requires the @elizaos/plugin-e2b-sandbox plugin. Add it to the agent's plugins, or select the eliza-cloud or home remote runner instead.",
      });
    }
    return factory.create(config);
  }
}

class RemoteRunnerHttpFactory implements E2BSandboxFactory {
  async create(config: E2BRemoteRunnerConfig): Promise<E2BSandboxClient> {
    if (!config.remoteHttpBaseUrl) {
      throw new Error(
        `${config.provider} runner requires a remote runner URL.`,
      );
    }
    const apiBase = normalizeHttpBaseUrl(
      config.remoteHttpBaseUrl,
      `${config.provider} remote runner URL`,
    );
    const headers = authHeaders(config.remoteHttpToken);
    const result = await fetchBounded(
      `${apiBase}/v1/health`,
      { headers },
      {
        timeoutMs: config.requestTimeoutMs,
        maxResponseBytes: MAX_REMOTE_ERROR_BYTES,
      },
    );
    if (!result.response.ok) {
      throw remoteHttpStatusError("health check", result.response.status);
    }
    return new RemoteRunnerHttpClient(
      config.provider,
      apiBase,
      headers,
      config.requestTimeoutMs,
    );
  }
}

class RemoteRunnerHttpClient implements E2BSandboxClient {
  readonly workspacePrepared = true;
  readonly files = {
    list: (
      path: string,
      opts?: { depth?: number; requestTimeoutMs?: number },
    ) => this.list(path, opts),
    read: (
      path: string,
      opts?: { format?: "text" | "bytes"; requestTimeoutMs?: number },
    ) => this.read(path, opts),
    write: (path: string, data: string, opts?: { requestTimeoutMs?: number }) =>
      this.write(path, data, opts),
  };
  readonly commands = {
    run: (cmd: string, opts?: SandboxCommandRunOptions) =>
      this.runCommand(cmd, opts),
  };

  constructor(
    readonly sandboxId: string,
    private readonly apiBase: string,
    private readonly headers: Record<string, string>,
    private readonly requestTimeoutMs: number,
  ) {}

  async kill(): Promise<void> {}

  private async list(
    path: string,
    opts?: { depth?: number; requestTimeoutMs?: number },
  ): Promise<SandboxEntryInfo[]> {
    const url = new URL(`${this.apiBase}/v1/fs/entries`);
    url.searchParams.set("path", path);
    const result = await fetchBounded(
      url,
      { headers: this.headers },
      {
        timeoutMs: opts?.requestTimeoutMs ?? this.requestTimeoutMs,
        maxResponseBytes: MAX_REMOTE_JSON_BYTES,
      },
    );
    if (!result.response.ok) {
      throw remoteHttpStatusError("file listing", result.response.status);
    }
    const payload = decodeJson(
      result.body,
      "Remote runner fs entries response",
    );
    const entries = Array.isArray(payload)
      ? payload
      : isObject(payload) && Array.isArray(payload.entries)
        ? payload.entries
        : null;
    if (!entries) {
      throw remoteProtocolError(
        "REMOTE_FS_RESPONSE_INVALID",
        "Remote runner fs entries response was not an array.",
      );
    }
    return entries.map((entry) => {
      if (!isObject(entry)) {
        throw remoteProtocolError(
          "REMOTE_FS_ENTRY_INVALID",
          "Remote runner fs entry was not an object.",
        );
      }
      const pathValue = requiredNonEmptyString(
        entry.path,
        "Remote runner fs entry path",
      );
      const name =
        entry.name === undefined
          ? nodePath.posix.basename(pathValue)
          : requiredNonEmptyString(entry.name, "Remote runner fs entry name");
      const size = requiredNonNegativeSafeInteger(
        entry.size,
        "Remote runner fs entry size",
      );
      const modifiedValue = entry.modifiedAt ?? entry.modified;
      const modified =
        modifiedValue === undefined || modifiedValue === null
          ? undefined
          : requiredNonEmptyString(
              modifiedValue,
              "Remote runner fs entry modified time",
            );
      const stat: SandboxEntryInfo = {
        path: pathValue,
        name,
        type: remoteEntryType(entry),
        size,
      };
      if (modified) {
        const modifiedTime = new Date(modified);
        if (Number.isNaN(modifiedTime.getTime())) {
          throw remoteProtocolError(
            "REMOTE_FS_ENTRY_INVALID",
            "Remote runner fs entry modified time was not a valid date.",
          );
        }
        stat.modifiedTime = modifiedTime;
      }
      return stat;
    });
  }

  private async read(
    path: string,
    opts?: { format?: "text" | "bytes"; requestTimeoutMs?: number },
  ): Promise<string | Uint8Array> {
    const url = new URL(`${this.apiBase}/v1/fs/file`);
    url.searchParams.set("path", path);
    const result = await fetchBounded(
      url,
      {
        headers: this.headers,
      },
      {
        timeoutMs: opts?.requestTimeoutMs ?? this.requestTimeoutMs,
        maxResponseBytes: MAX_READ_BYTES,
      },
    );
    if (result.response.status === 404) {
      const error = new Error(`File not found: ${path}`);
      error.name = "FileNotFoundError";
      throw error;
    }
    if (!result.response.ok) {
      throw remoteHttpStatusError("file read", result.response.status);
    }
    return opts?.format === "bytes"
      ? result.body
      : decodeUtf8(result.body, "Remote runner file response");
  }

  private async write(
    path: string,
    data: string,
    opts?: { requestTimeoutMs?: number },
  ): Promise<{ path: string; name: string }> {
    const url = new URL(`${this.apiBase}/v1/fs/file`);
    url.searchParams.set("path", path);
    const result = await fetchBounded(
      url,
      {
        method: "PUT",
        headers: {
          ...this.headers,
          "content-type": "text/plain",
        },
        body: data,
      },
      {
        timeoutMs: opts?.requestTimeoutMs ?? this.requestTimeoutMs,
        maxResponseBytes: MAX_REMOTE_ERROR_BYTES,
      },
    );
    if (!result.response.ok) {
      throw remoteHttpStatusError("file write", result.response.status);
    }
    return { path, name: nodePath.posix.basename(path) };
  }

  private async runCommand(
    cmd: string,
    opts: SandboxCommandRunOptions = {},
  ): Promise<SandboxCommandResult> {
    const effectiveTimeoutMs =
      opts.timeoutMs ?? opts.requestTimeoutMs ?? this.requestTimeoutMs;
    const result = await fetchBounded(
      `${this.apiBase}/v1/processes/run`,
      {
        method: "POST",
        headers: {
          ...this.headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "sh",
          args: ["-lc", cmd],
          cwd: opts.cwd,
          env: opts.envs,
          timeoutMs: opts.timeoutMs,
        }),
      },
      {
        timeoutMs: effectiveTimeoutMs,
        maxResponseBytes: MAX_REMOTE_JSON_BYTES,
      },
    );
    if (!result.response.ok) {
      throw remoteHttpStatusError("process execution", result.response.status);
    }
    const payload = decodeJson(result.body, "Remote runner process response");
    if (!isObject(payload)) {
      throw remoteProtocolError(
        "REMOTE_PROCESS_RESPONSE_INVALID",
        "Remote runner process response was not an object.",
      );
    }
    const exitCode = parseRemoteExitCode(payload);
    const stdout = optionalStringAlias(
      payload,
      ["stdout", "output"],
      "Remote runner process stdout",
      true,
    );
    const stderr = optionalStringAlias(
      payload,
      ["stderr"],
      "Remote runner process stderr",
      true,
    );
    return {
      exitCode,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      ...(payload.timedOut === true ? { timedOut: true } : {}),
    };
  }
}

type CloudCodingAgent = "claude" | "codex";

type CloudCodingContainerSession = {
  containerId: string;
  status?: string;
  url?: string | null;
};

type CloudEnvelope = {
  data?: unknown;
  polling?: unknown;
};

class ElizaCloudCodingContainerFactory implements E2BSandboxFactory {
  constructor(private readonly remoteHttpFactory: RemoteRunnerHttpFactory) {}

  async create(config: E2BRemoteRunnerConfig): Promise<E2BSandboxClient> {
    if (!config.cloudApiBaseUrl || !config.cloudApiToken) {
      throw new Error(
        "Eliza Cloud runner requires a Cloud API base URL and API key.",
      );
    }
    const remoteToken = randomUUID();
    const deadline = deadlineFromNow(Math.min(config.timeoutMs, 120_000));
    const session = await this.requestCodingContainer(
      config,
      remoteToken,
      deadline,
    );
    if (!session.url) {
      throw new Error(
        `Eliza Cloud coding container ${session.containerId} did not return a remote runner URL.`,
      );
    }
    return this.remoteHttpFactory.create({
      ...config,
      remoteHttpBaseUrl: normalizeProvisionedRunnerUrl(
        session.url,
        config.cloudApiBaseUrl,
      ),
      remoteHttpToken: remoteToken,
    });
  }

  private async requestCodingContainer(
    config: E2BRemoteRunnerConfig,
    remoteToken: string,
    deadline: number,
  ): Promise<CloudCodingContainerSession> {
    const result = await fetchBounded(
      `${config.cloudApiBaseUrl}/coding-containers`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.cloudApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agent: toCloudCodingAgent(config.agentRunners[0] ?? "codex"),
          workspacePath: config.workdir,
          container: {
            ...(config.cloudContainerImage
              ? { image: config.cloudContainerImage }
              : {}),
            environmentVars: {
              HOST: "0.0.0.0",
              ELIZA_REMOTE_RUNNER_HTTP_TOKEN: remoteToken,
              REMOTE_RUNNER_HTTP_TOKEN: remoteToken,
              ELIZA_CODING_WORKSPACE: config.workdir,
              ELIZA_SANDBOX_AGENT_RUNNERS: config.agentRunners.join(","),
              ...config.envs,
            },
          },
          metadata: config.metadata,
        }),
      },
      {
        timeoutMs: requestTimeoutWithinDeadline(
          deadline,
          config.requestTimeoutMs,
        ),
        maxResponseBytes: MAX_REMOTE_JSON_BYTES,
      },
    );
    const payload = readCloudEnvelope(result.body);
    if (!result.response.ok) {
      throw cloudHttpStatusError("provisioning", result.response.status);
    }
    const session = parseCloudCodingContainerSession(payload);
    return session.url
      ? session
      : await this.pollCodingContainer(config, session, deadline);
  }

  private async pollCodingContainer(
    config: E2BRemoteRunnerConfig,
    session: CloudCodingContainerSession,
    deadline: number,
  ): Promise<CloudCodingContainerSession> {
    let current = session;
    while (!current.url && Date.now() < deadline) {
      await sleep(Math.min(5000, Math.max(0, deadline - Date.now())));
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const result = await fetchBounded(
        `${config.cloudApiBaseUrl}/containers/${encodeURIComponent(current.containerId)}`,
        {
          headers: { authorization: `Bearer ${config.cloudApiToken}` },
        },
        {
          timeoutMs: requestTimeoutWithinDeadline(
            deadline,
            config.requestTimeoutMs,
          ),
          maxResponseBytes: MAX_REMOTE_JSON_BYTES,
        },
      );
      const payload = readCloudEnvelope(result.body);
      if (!result.response.ok) {
        throw cloudHttpStatusError("status polling", result.response.status);
      }
      current = parseCloudCodingContainerSession(payload);
      if (current.status === "failed" || current.status === "stopped") {
        throw new Error(
          `Eliza Cloud coding container ${current.containerId} reached status ${current.status}.`,
        );
      }
    }
    if (!current.url) {
      throw new Error(
        `Eliza Cloud coding container ${current.containerId} did not become reachable before timeout.`,
      );
    }
    return current;
  }
}

export class E2BRemoteCapabilityRouterService
  extends Service
  implements ElizaCapabilityRouter
{
  static serviceType = CAPABILITY_ROUTER_SERVICE_TYPE;
  capabilityDescription =
    "Routes filesystem, terminal, and local Git capabilities to a cloud remote runner.";

  readonly environment = "server";
  readonly fs = {
    list: (params?: FileListParams) => this.list(params),
    readText: (params: FileReadTextParams) => this.readText(params),
    writeText: (params: FileWriteTextParams) => this.writeText(params),
  };
  readonly pty = {
    runCommand: (params: TerminalRunParams) => this.runCommand(params),
  };
  readonly git = {
    status: (params: GitStatusParams) => this.gitStatus(params),
    diff: (params: GitDiffParams) => this.gitDiff(params),
    commandRun: (params: GitCommandRunParams) => this.gitCommandRun(params),
  };
  readonly model = {
    status: () => this.modelStatus(),
  };
  readonly plugin: RemotePluginCapability = {
    listModules: () => this.pluginUnavailable("plugin.module.list"),
    invokeAction: () => this.pluginUnavailable("plugin.action.invoke"),
    getProvider: () => this.pluginUnavailable("plugin.provider.get"),
    callRoute: () => this.pluginUnavailable("plugin.route.call"),
    getAsset: () => this.pluginUnavailable("plugin.asset.get"),
    shouldRunEvaluator: () =>
      this.pluginUnavailable("plugin.evaluator.shouldRun"),
    prepareEvaluator: () => this.pluginUnavailable("plugin.evaluator.prepare"),
    promptEvaluator: () => this.pluginUnavailable("plugin.evaluator.prompt"),
    processEvaluator: () => this.pluginUnavailable("plugin.evaluator.process"),
    shouldRunResponseHandlerEvaluator: () =>
      this.pluginUnavailable("plugin.responseHandlerEvaluator.shouldRun"),
    evaluateResponseHandlerEvaluator: () =>
      this.pluginUnavailable("plugin.responseHandlerEvaluator.evaluate"),
    shouldRunResponseHandlerFieldEvaluator: () =>
      this.pluginUnavailable("plugin.responseHandlerFieldEvaluator.shouldRun"),
    parseResponseHandlerFieldEvaluator: () =>
      this.pluginUnavailable("plugin.responseHandlerFieldEvaluator.parse"),
    handleResponseHandlerFieldEvaluator: () =>
      this.pluginUnavailable("plugin.responseHandlerFieldEvaluator.handle"),
    callLifecycle: () => this.pluginUnavailable("plugin.lifecycle.call"),
    handleEvent: () => this.pluginUnavailable("plugin.event.handle"),
    invokeModel: () => this.pluginUnavailable("plugin.model.invoke"),
    callService: () => this.pluginUnavailable("plugin.service.call"),
    callAppBridge: () => this.pluginUnavailable("plugin.appBridge.call"),
  };

  private sandboxPromise: Promise<E2BSandboxClient> | null = null;
  private preparePromise: Promise<void> | null = null;
  private createdSandbox = false;
  private readonly routerConfig: E2BRemoteRunnerConfig;
  private readonly factory: E2BSandboxFactory;

  constructor(
    runtime?: IAgentRuntime,
    routerConfig?: E2BRemoteRunnerConfig,
    factory?: E2BSandboxFactory,
  ) {
    if (!runtime) {
      throw new Error("E2BRemoteCapabilityRouterService requires a runtime.");
    }
    super(runtime);
    this.routerConfig = routerConfig ?? resolveE2BRemoteRunnerConfig(runtime);
    this.factory = factory ?? new DefaultSandboxFactory(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const config = resolveE2BRemoteRunnerConfig(runtime);
    const service = new E2BRemoteCapabilityRouterService(runtime, config);
    logger.info(
      {
        ...LOG_CONTEXT,
        provider: config.provider,
        workdir: config.workdir,
        template: config.template ?? null,
        hasSandboxId: Boolean(config.sandboxId),
        hasBootstrapGitUrl: Boolean(config.bootstrapGitUrl),
        agentRunners: config.agentRunners,
      },
      "[E2BRemoteCapabilityRouter] Service started",
    );
    return service;
  }

  async stop(): Promise<void> {
    const sandbox = await this.sandboxPromise?.catch(() => null);
    this.sandboxPromise = null;
    this.preparePromise = null;
    if (!sandbox || this.routerConfig.keepAlive || !this.createdSandbox) return;
    await sandbox.kill({
      requestTimeoutMs: this.routerConfig.requestTimeoutMs,
    });
  }

  async availability(): Promise<CapabilityAvailability> {
    const available = hasRunnerCredentials(this.routerConfig);
    return {
      environment: this.environment,
      available,
      capabilities: {
        fs: available,
        pty: available,
        git: available,
        model: false,
        plugin: false,
      },
      ...(available
        ? {}
        : {
            reason: runnerUnavailableReason(this.routerConfig),
          }),
    };
  }

  private async list(params: FileListParams = {}): Promise<FileListResult> {
    await this.requireAvailable("fs", "fs.list");
    const sandbox = await this.getSandbox();
    const target = this.mapPath(params.path ?? this.routerConfig.workdir);
    const limit = params.limit ?? Number.MAX_SAFE_INTEGER;
    const entries = await sandbox.files.list(target, {
      depth: 1,
      requestTimeoutMs: this.routerConfig.requestTimeoutMs,
    });
    const filtered = filterEntries(entries, params.ignore ?? []);
    const visible =
      params.includeHidden === true
        ? filtered
        : filtered.filter((entry) => !entry.name.startsWith("."));
    const capped = visible.slice(0, limit);
    return {
      root: this.rootObject(target),
      path: target,
      entries: capped.map(toFileStat),
      truncated: visible.length > capped.length,
      totalAfterIgnore: visible.length,
    };
  }

  private async readText(
    params: FileReadTextParams,
  ): Promise<FileReadTextResult> {
    await this.requireAvailable("fs", "fs.readText");
    if (
      params.maxBytes !== undefined &&
      (!Number.isSafeInteger(params.maxBytes) || params.maxBytes <= 0)
    ) {
      throw new CapabilityError({
        code: "CAPABILITY_REQUEST_FAILED",
        capability: "fs",
        method: "fs.readText",
        message: "fs.readText maxBytes must be a positive safe integer.",
      });
    }
    const sandbox = await this.getSandbox();
    const target = this.mapPath(params.path);
    const content = await sandbox.files.read(target, {
      format: "text",
      requestTimeoutMs: this.routerConfig.requestTimeoutMs,
    });
    const text =
      typeof content === "string"
        ? content
        : Buffer.from(content).toString("utf8");
    const bytes = Buffer.byteLength(text, "utf8");
    if (params.maxBytes !== undefined && bytes > params.maxBytes) {
      throw new CapabilityError({
        code: "CAPABILITY_REQUEST_FAILED",
        capability: "fs",
        method: "fs.readText",
        message: `fs.readText requires ${bytes} bytes, exceeding the requested ${params.maxBytes}-byte acceptance ceiling.`,
      });
    }
    return { path: target, text, size: bytes, truncated: false };
  }

  private async writeText(
    params: FileWriteTextParams,
  ): Promise<FileWriteTextResult> {
    await this.requireAvailable("fs", "fs.writeText");
    if (params.overwrite === false) {
      const exists = await this.pathExists(params.path);
      if (exists) {
        throw new CapabilityError({
          code: "CAPABILITY_REQUEST_FAILED",
          capability: "fs",
          method: "fs.writeText",
          message: `Refusing to overwrite existing file: ${params.path}`,
        });
      }
    }
    const sandbox = await this.getSandbox();
    const target = this.mapPath(params.path);
    await sandbox.files.write(target, params.text, {
      requestTimeoutMs: this.routerConfig.requestTimeoutMs,
    });
    return {
      path: target,
      bytesWritten: Buffer.byteLength(params.text, "utf8"),
    };
  }

  private async runCommand(
    params: TerminalRunParams,
  ): Promise<TerminalRunResult> {
    await this.requireAvailable("pty", "pty.command.run");
    const sandbox = await this.getSandbox();
    const command = commandLine(params.command, params.args ?? []);
    const cwd = this.mapPath(params.cwd ?? this.routerConfig.workdir);
    const opts: SandboxCommandRunOptions = {
      cwd,
      timeoutMs: params.timeoutMs ?? this.routerConfig.timeoutMs,
      requestTimeoutMs: params.timeoutMs ?? this.routerConfig.requestTimeoutMs,
      ...(params.env === undefined ? {} : { envs: params.env }),
    };
    try {
      const result = await sandbox.commands.run(command, opts);
      return commandRunResult(result, result.timedOut === true);
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      const commandResult = commandResultFromError(normalized);
      if (commandResult) {
        return commandRunResult(commandResult, commandResult.timedOut === true);
      }
      if (isTimeoutError(normalized)) {
        return {
          output: normalized.message,
          exitCode: null,
          timedOut: true,
        };
      }
      throw new CapabilityError({
        code: "CAPABILITY_REQUEST_FAILED",
        capability: "pty",
        method: "pty.command.run",
        message: normalized.message,
      });
    }
  }

  private async gitStatus(params: GitStatusParams): Promise<GitStatusResult> {
    const root = this.mapPath(params.root);
    const result = await this.runGit(root, [
      "status",
      "--porcelain=v1",
      "--branch",
    ]);
    const parsed = parseGitStatus(result.output);
    return {
      repo: this.rootObject(root),
      ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
      ...(parsed.ahead === undefined ? {} : { ahead: parsed.ahead }),
      ...(parsed.behind === undefined ? {} : { behind: parsed.behind }),
      files: parsed.files,
      raw: result.output,
    };
  }

  private async gitDiff(params: GitDiffParams): Promise<GitDiffResult> {
    const args = ["diff"];
    if (params.staged) args.push("--staged");
    if (params.path) args.push("--", params.path);
    const result = await this.runGit(this.mapPath(params.root), args);
    return { raw: result.output };
  }

  private async gitCommandRun(
    params: GitCommandRunParams,
  ): Promise<GitCommandRunResult> {
    const cwd = this.mapPath(params.root);
    const startedAt = new Date().toISOString();
    const id = randomUUID();
    try {
      const result = await this.runGit(cwd, params.args);
      return {
        operation: {
          id,
          name: "git.command.run",
          cwd,
          command: ["git", ...params.args],
          status: result.exitCode === 0 ? "completed" : "failed",
          stdout: result.output,
          stderr: "",
          exitCode: result.exitCode,
          signal: null,
          startedAt,
          completedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      return {
        operation: {
          id,
          name: "git.command.run",
          cwd,
          command: ["git", ...params.args],
          status: "failed",
          stdout: "",
          stderr: "",
          exitCode: null,
          signal: null,
          startedAt,
          completedAt: new Date().toISOString(),
          error: normalized.message,
        },
      };
    }
  }

  private async modelStatus(): Promise<LocalModelStatusResult> {
    throw new CapabilityError({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "model",
      method: "model.status",
      message: "Remote coding runner does not own local model control.",
    });
  }

  private async pluginUnavailable(method: string): Promise<never> {
    throw new CapabilityError({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "plugin",
      method,
      message: "Remote coding runner does not own remote plugin execution.",
    });
  }

  private async runGit(
    root: string,
    args: string[],
  ): Promise<TerminalRunResult> {
    return this.runCommand({
      command: "git",
      args,
      cwd: root,
      timeoutMs: this.routerConfig.timeoutMs,
    });
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      const sandbox = await this.getSandbox();
      await sandbox.files.read(this.mapPath(path), {
        format: "bytes",
        requestTimeoutMs: this.routerConfig.requestTimeoutMs,
      });
      return true;
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      if (
        normalized.name === "FileNotFoundError" ||
        /not found/i.test(normalized.message)
      ) {
        return false;
      }
      throw normalized;
    }
  }

  private async requireAvailable(
    capability: CapabilityName,
    method: string,
  ): Promise<void> {
    const availability = await this.availability();
    if (availability.available) return;
    throw new CapabilityError({
      code: "CAPABILITY_UNAVAILABLE",
      capability,
      method,
      message: availability.reason ?? "Remote coding runner is unavailable.",
    });
  }

  private async getSandbox(): Promise<E2BSandboxClient> {
    if (!this.sandboxPromise) {
      this.sandboxPromise = this.factory.create(this.routerConfig);
      this.createdSandbox = !this.routerConfig.sandboxId;
    }
    const sandbox = await this.sandboxPromise;
    if (!this.preparePromise) {
      this.preparePromise = this.prepareSandbox(sandbox);
    }
    await this.preparePromise;
    return sandbox;
  }

  private async prepareSandbox(sandbox: E2BSandboxClient): Promise<void> {
    if (!sandbox.workspacePrepared) {
      await sandbox.commands.run(
        `mkdir -p ${shellQuote(this.routerConfig.workdir)}`,
        {
          timeoutMs: this.routerConfig.requestTimeoutMs,
          requestTimeoutMs: this.routerConfig.requestTimeoutMs,
        },
      );
    }
    if (!this.routerConfig.bootstrapGitUrl) return;
    const exists = await sandbox.commands
      .run(
        `test -d ${shellQuote(posixJoin(this.routerConfig.workdir, ".git"))}`,
        {
          timeoutMs: this.routerConfig.requestTimeoutMs,
          requestTimeoutMs: this.routerConfig.requestTimeoutMs,
        },
      )
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      await sandbox.commands.run(
        `git clone ${shellQuote(this.routerConfig.bootstrapGitUrl)} ${shellQuote(this.routerConfig.workdir)}`,
        {
          timeoutMs: this.routerConfig.timeoutMs,
          requestTimeoutMs: this.routerConfig.timeoutMs,
        },
      );
    }
    if (this.routerConfig.bootstrapGitRef) {
      await sandbox.commands.run(
        `git fetch --all --tags && git checkout ${shellQuote(this.routerConfig.bootstrapGitRef)}`,
        {
          cwd: this.routerConfig.workdir,
          timeoutMs: this.routerConfig.timeoutMs,
          requestTimeoutMs: this.routerConfig.timeoutMs,
        },
      );
    }
  }

  private mapPath(input: string): string {
    const trimmed = input.trim();
    if (trimmed.length === 0) return this.routerConfig.workdir;
    if (isSandboxUri(trimmed)) {
      const parsed = new URL(trimmed);
      return normalizeSandboxPath(parsed.pathname || this.routerConfig.workdir);
    }
    if (isWithinSandboxPath(trimmed, this.routerConfig.workdir)) {
      return normalizeSandboxPath(trimmed);
    }
    if (!nodePath.isAbsolute(trimmed)) {
      return posixJoin(this.routerConfig.workdir, trimmed);
    }
    const resolved = nodePath.resolve(trimmed);
    if (isWithinHostPath(resolved, this.routerConfig.hostWorkspaceRoot)) {
      const relative = nodePath.relative(
        this.routerConfig.hostWorkspaceRoot,
        resolved,
      );
      return relative
        ? posixJoin(this.routerConfig.workdir, ...relative.split(nodePath.sep))
        : this.routerConfig.workdir;
    }
    throw new CapabilityError({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "fs",
      method: "path.map",
      message: `Path is outside the ${this.routerConfig.provider} mapped workspace: ${input}`,
      details: {
        hostWorkspaceRoot: this.routerConfig.hostWorkspaceRoot,
        workdir: this.routerConfig.workdir,
      },
    });
  }

  private rootObject(path: string): JsonObject {
    return {
      id: this.routerConfig.provider,
      provider: `remote:${this.routerConfig.provider}`,
      path,
      hostWorkspaceRoot: this.routerConfig.hostWorkspaceRoot,
      sandboxId: this.routerConfig.sandboxId ?? null,
      agentRunners: this.routerConfig.agentRunners,
    };
  }
}

export type E2BRegistrationResult =
  | { registered: true; provider: SandboxRunnerProvider }
  | { registered: false; reason: "disabled" | "already-registered" };

export async function registerE2BRemoteCapabilityRouterIfEnabled(
  runtime: IAgentRuntime,
): Promise<E2BRegistrationResult> {
  const config = resolveE2BRemoteRunnerConfig(runtime);
  if (!config.enabled) return { registered: false, reason: "disabled" };
  if (runtime.getService(CAPABILITY_ROUTER_SERVICE_TYPE)) {
    return { registered: false, reason: "already-registered" };
  }
  await runtime.registerService(E2BRemoteCapabilityRouterService);
  return { registered: true, provider: config.provider };
}

export function resolveE2BRemoteRunnerConfig(
  runtime: IAgentRuntime,
): E2BRemoteRunnerConfig {
  const codingRunner = normalizeRunnerSetting(
    readSetting(runtime, "ELIZA_CODING_REMOTE_RUNNER"),
  );
  const runner = normalizeRunnerSetting(
    readSetting(runtime, "ELIZA_REMOTE_RUNNER"),
  );
  const direct = readSetting(runtime, "ELIZA_E2B_REMOTE_RUNNER");
  const provider = resolveRunnerProvider(runtime, codingRunner ?? runner);
  const enabled =
    provider === "eliza-cloud" || provider === "home"
      ? true
      : codingRunner === "e2b" || runner === "e2b" || isTruthy(direct);
  const workdir = normalizeSandboxPath(
    readSetting(runtime, "ELIZA_SANDBOX_WORKDIR") ??
      readSetting(runtime, providerSettingKey(provider, "WORKDIR")) ??
      defaultWorkdir(provider),
  );
  const agentId = String(runtime.agentId);
  const agentName = runtime.character?.name ?? "eliza";
  const hostWorkspaceRoot =
    readSetting(runtime, "ELIZA_SANDBOX_HOST_WORKSPACE_ROOT") ??
    readSetting(runtime, providerSettingKey(provider, "HOST_WORKSPACE_ROOT")) ??
    process.cwd();
  return {
    enabled,
    provider,
    apiKey: readSetting(runtime, "E2B_API_KEY"),
    accessToken: readSetting(runtime, "E2B_ACCESS_TOKEN"),
    domain: readSetting(runtime, "E2B_DOMAIN"),
    sandboxId:
      provider === "eliza-cloud"
        ? readSetting(runtime, "ELIZA_CLOUD_SANDBOX_ID")
        : provider === "home"
          ? readSetting(runtime, "ELIZA_HOME_REMOTE_RUNNER_ID")
          : readSetting(runtime, "E2B_SANDBOX_ID"),
    template:
      readSetting(runtime, "E2B_TEMPLATE") ??
      readSetting(runtime, "ELIZA_E2B_TEMPLATE"),
    cloudApiBaseUrl: cloudApiBaseUrl(runtime, provider),
    cloudApiToken: cloudApiToken(runtime, provider),
    cloudContainerImage: cloudContainerImage(runtime, provider),
    remoteHttpBaseUrl: remoteHttpBaseUrl(runtime, provider),
    remoteHttpToken: remoteHttpToken(runtime, provider),
    remoteAccessUrl: remoteAccessUrl(runtime, provider),
    agentRunners: agentRunnersSetting(runtime, provider),
    workdir,
    hostWorkspaceRoot: nodePath.resolve(hostWorkspaceRoot),
    timeoutMs: positiveIntSetting(
      runtime,
      providerSettingKey(provider, "TIMEOUT_MS"),
      DEFAULT_TIMEOUT_MS,
    ),
    requestTimeoutMs: positiveIntSetting(
      runtime,
      providerSettingKey(provider, "REQUEST_TIMEOUT_MS"),
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    keepAlive: isTruthy(
      readSetting(runtime, providerSettingKey(provider, "KEEP_ALIVE")),
    ),
    allowInternetAccess: !isFalsey(
      readSetting(runtime, providerSettingKey(provider, "ALLOW_INTERNET")),
    ),
    bootstrapGitUrl:
      readSetting(runtime, "ELIZA_SANDBOX_BOOTSTRAP_GIT_URL") ??
      readSetting(runtime, providerSettingKey(provider, "BOOTSTRAP_GIT_URL")),
    bootstrapGitRef:
      readSetting(runtime, "ELIZA_SANDBOX_BOOTSTRAP_GIT_REF") ??
      readSetting(runtime, providerSettingKey(provider, "BOOTSTRAP_GIT_REF")),
    envs: {
      ELIZA_AGENT_ID: agentId,
      ELIZA_AGENT_NAME: agentName,
    },
    metadata: {
      app: "elizaos",
      provider: `remote:${provider}`,
      agentId,
      agentName,
    },
  };
}

function hasRunnerCredentials(config: E2BRemoteRunnerConfig): boolean {
  if (config.provider === "eliza-cloud") {
    return Boolean(
      config.remoteHttpBaseUrl ||
        (config.cloudApiBaseUrl && config.cloudApiToken),
    );
  }
  if (config.provider === "home") {
    return Boolean(config.remoteHttpBaseUrl);
  }
  return Boolean(config.apiKey || config.accessToken);
}

function runnerUnavailableReason(config: E2BRemoteRunnerConfig): string {
  if (config.provider === "eliza-cloud") {
    return "Eliza Cloud runner requires a direct remote runner URL or ELIZA_CLOUD_API_KEY/ELIZACLOUD_API_KEY for coding-container provisioning.";
  }
  if (config.provider === "home") {
    return "Home runner requires ELIZA_HOME_REMOTE_RUNNER_URL.";
  }
  return "E2B remote runner requires E2B_API_KEY, E2B_ACCESS_TOKEN, or matching runtime setting.";
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  if (!apiKey) return {};
  return { authorization: `Bearer ${apiKey}` };
}

function remoteEntryType(entry: JsonObject): SandboxEntryInfo["type"] {
  const value = optionalStringAlias(
    entry,
    ["type", "entryType", "kind"],
    "Remote runner fs entry type",
  );
  if (value === undefined) {
    throw remoteProtocolError(
      "REMOTE_FS_ENTRY_INVALID",
      "Remote runner fs entry type was missing.",
    );
  }
  return normalizeSandboxEntryType(value);
}

type BoundedFetchResult = {
  response: Response;
  body: Uint8Array;
};

class RemoteResponseProtocolError extends ElizaError {
  override readonly name: string = "RemoteResponseProtocolError";
}

class RemoteResponseTooLargeError extends RemoteResponseProtocolError {
  override readonly name = "RemoteResponseTooLargeError";
}

async function fetchBounded(
  input: string | URL,
  init: RequestInit,
  options: { timeoutMs: number; maxResponseBytes: number },
): Promise<BoundedFetchResult> {
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new RangeError(
      `Duration must be an integer between 1 and ${MAX_TIMER_DELAY_MS}ms.`,
    );
  }
  const controller = new AbortController();
  const timeoutError = new DOMException(
    `Remote runner request timed out after ${options.timeoutMs}ms.`,
    "TimeoutError",
  );
  const timer = setTimeout(
    () => controller.abort(timeoutError),
    options.timeoutMs,
  );
  timer.unref?.();
  try {
    const response = await fetch(input, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      if (!/^(0|[1-9]\d*)$/.test(declaredLength)) {
        throw remoteProtocolError(
          "REMOTE_RESPONSE_LENGTH_INVALID",
          "Remote response declared an invalid content length.",
        );
      }
      const declaredBytes = Number(declaredLength);
      if (
        !Number.isSafeInteger(declaredBytes) ||
        declaredBytes > options.maxResponseBytes
      ) {
        const error = responseTooLargeError(options.maxResponseBytes);
        cancelResponseBody(response, error);
        throw error;
      }
    }
    return {
      response,
      body: await readBoundedBody(
        response,
        options.maxResponseBytes,
        controller,
      ),
    };
  } catch (error) {
    // error-policy:J1 the outbound HTTP boundary preserves stable local
    // protocol errors but translates implementation-specific network failures
    // so an internal host, socket detail, or redirect target cannot escape.
    if (
      controller.signal.aborted &&
      controller.signal.reason === timeoutError
    ) {
      throw timeoutError;
    }
    controller.abort();
    if (error instanceof RemoteResponseProtocolError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    throw new ElizaError("Remote HTTP request failed.", {
      code: "REMOTE_HTTP_REQUEST_FAILED",
      severity: "ephemeral",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        const error = responseTooLargeError(maxBytes);
        controller.abort(error);
        cancelReader(reader, error);
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function cancelResponseBody(response: Response, reason: Error): void {
  if (!response.body) return;
  try {
    // error-policy:J6 cancellation is teardown after a rejected response; its
    // rejection is logged by the attached diagnostic handler, while a
    // hostile stream cannot delay the primary size-limit failure.
    void response.body.cancel(reason).catch((error: unknown) => {
      logger.debug(
        { ...LOG_CONTEXT, error },
        "[E2BRemoteCapabilityRouter] Failed to cancel rejected response body",
      );
    });
  } catch (error) {
    // error-policy:J6 cancellation is teardown after a rejected response.
    logger.debug(
      { ...LOG_CONTEXT, error },
      "[E2BRemoteCapabilityRouter] Failed to cancel rejected response body",
    );
  }
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: Error,
): void {
  try {
    // error-policy:J6 cancellation is teardown after a rejected response; its
    // rejection is logged by the attached diagnostic handler, while a
    // hostile stream cannot delay the primary size-limit failure.
    void reader.cancel(reason).catch((error: unknown) => {
      logger.debug(
        { ...LOG_CONTEXT, error },
        "[E2BRemoteCapabilityRouter] Failed to cancel oversized response stream",
      );
    });
  } catch (error) {
    // error-policy:J6 cancellation is teardown after the response exceeded its cap.
    logger.debug(
      { ...LOG_CONTEXT, error },
      "[E2BRemoteCapabilityRouter] Failed to cancel oversized response stream",
    );
  }
}

function responseTooLargeError(maxBytes: number): RemoteResponseTooLargeError {
  return new RemoteResponseTooLargeError(
    `Remote response exceeded the ${maxBytes}-byte safety limit.`,
    {
      code: "REMOTE_RESPONSE_TOO_LARGE",
      context: { maxBytes },
    },
  );
}

function remoteHttpStatusError(operation: string, status: number): ElizaError {
  return new ElizaError(
    `Remote runner ${operation} failed with HTTP ${status}.`,
    {
      code: "REMOTE_HTTP_STATUS_FAILED",
      context: { operation, status },
      severity: status >= 500 ? "ephemeral" : "fatal",
    },
  );
}

function cloudHttpStatusError(operation: string, status: number): ElizaError {
  return new ElizaError(
    `Eliza Cloud coding-container ${operation} failed with HTTP ${status}.`,
    {
      code: "CLOUD_CODING_CONTAINER_HTTP_STATUS_FAILED",
      context: { operation, status },
      severity: status >= 500 ? "ephemeral" : "fatal",
    },
  );
}

function decodeUtf8(body: Uint8Array, context: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    // error-policy:J1 malformed upstream bytes are translated without retaining
    // an implementation error that may quote attacker-controlled content.
    throw remoteProtocolError(
      "REMOTE_RESPONSE_UTF8_INVALID",
      `${context} was not valid UTF-8.`,
    );
  }
}

function decodeJson(body: Uint8Array, context: string): unknown {
  const text = decodeUtf8(body, context);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // error-policy:J1 JSON parser diagnostics may quote the untrusted response,
    // so the boundary exposes only a stable protocol failure.
    throw remoteProtocolError(
      "REMOTE_RESPONSE_JSON_INVALID",
      `${context} was not valid JSON.`,
    );
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCloudEnvelope(body: Uint8Array): CloudEnvelope {
  const text = decodeUtf8(body, "Eliza Cloud coding-container response");
  if (!text.trim()) return {};
  const parsed = decodeJson(body, "Eliza Cloud coding-container response");
  if (!isObject(parsed)) {
    throw remoteProtocolError(
      "CLOUD_CODING_CONTAINER_RESPONSE_INVALID",
      "Eliza Cloud coding-container response was not a JSON object.",
    );
  }
  return parsed;
}

function parseCloudCodingContainerSession(
  payload: CloudEnvelope,
): CloudCodingContainerSession {
  const data: JsonObject = isObject(payload.data)
    ? payload.data
    : (payload as JsonObject);
  const containerId = optionalStringAlias(
    data,
    ["containerId", "id"],
    "Eliza Cloud coding-container id",
  );
  if (!containerId) {
    throw remoteProtocolError(
      "CLOUD_CODING_CONTAINER_RESPONSE_INVALID",
      "Eliza Cloud coding-container response omitted container id.",
    );
  }
  return {
    containerId,
    status: optionalStringAlias(
      data,
      ["status"],
      "Eliza Cloud coding-container status",
    ),
    url: optionalStringAlias(
      data,
      ["url", "publicUrl", "load_balancer_url", "bridge_url"],
      "Eliza Cloud coding-container runner URL",
    ),
  };
}

function optionalStringAlias(
  record: JsonObject,
  keys: readonly string[],
  context: string,
  allowEmpty = false,
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && (allowEmpty || value.trim())) {
      return allowEmpty ? value : value.trim();
    }
    throw remoteProtocolError(
      "REMOTE_RESPONSE_SCHEMA_INVALID",
      `${context} was not a non-empty string.`,
    );
  }
  return undefined;
}

function requiredNonEmptyString(value: unknown, context: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw remoteProtocolError(
    "REMOTE_RESPONSE_SCHEMA_INVALID",
    `${context} was not a non-empty string.`,
  );
}

function requiredNonNegativeSafeInteger(
  value: unknown,
  context: string,
): number {
  if (Number.isSafeInteger(value) && (value as number) >= 0) {
    return value as number;
  }
  throw remoteProtocolError(
    "REMOTE_RESPONSE_SCHEMA_INVALID",
    `${context} was not a non-negative safe integer.`,
  );
}

function parseRemoteExitCode(payload: JsonObject): number {
  if (Number.isSafeInteger(payload.exitCode)) {
    return payload.exitCode as number;
  }
  if (payload.exitCode !== undefined && payload.exitCode !== null) {
    throw remoteProtocolError(
      "REMOTE_PROCESS_RESPONSE_INVALID",
      "Remote runner process exit code was not a safe integer.",
    );
  }
  if (payload.timedOut === true) return 124;
  throw remoteProtocolError(
    "REMOTE_PROCESS_RESPONSE_INVALID",
    "Remote runner process response omitted exit code.",
  );
}

function remoteProtocolError(
  code: string,
  message: string,
  cause?: unknown,
): RemoteResponseProtocolError {
  return new RemoteResponseProtocolError(message, {
    code,
    ...(cause === undefined ? {} : { cause }),
    severity: "fatal",
  });
}

function toCloudCodingAgent(value: CodingAgentRunner): CloudCodingAgent {
  return value === "claude-code" ? "claude" : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deadlineFromNow(timeoutMs: number): number {
  return Date.now() + timeoutMs;
}

function requestTimeoutWithinDeadline(
  deadline: number,
  requestTimeoutMs: number,
): number {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new DOMException(
      "Eliza Cloud coding-container provisioning timed out.",
      "TimeoutError",
    );
  }
  return Math.max(1, Math.min(requestTimeoutMs, remainingMs));
}

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const fromRuntime = runtime.getSetting(key);
  if (typeof fromRuntime === "string" && fromRuntime.trim().length > 0) {
    return fromRuntime.trim();
  }
  const fromEnv = process.env[key];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return undefined;
}

function normalizeRunnerSetting(
  value: string | undefined,
): SandboxRunnerProvider | DisabledSandboxRunnerProvider | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "e2b") return "e2b";
  if (normalized === "eliza-cloud" || normalized === "elizacloud") {
    return "eliza-cloud";
  }
  if (normalized === "home" || normalized === "home-machine") return "home";
  if (normalized === "cloudflare") return "cloudflare";
  if (normalized === "sandbox-agent" || normalized === "rivet") return "rivet";
  if (normalized === "vercel") return "vercel";
  throw new Error(`Unsupported remote runner provider: ${value}`);
}

function resolveRunnerProvider(
  runtime: IAgentRuntime,
  requested: SandboxRunnerProvider | DisabledSandboxRunnerProvider | undefined,
): SandboxRunnerProvider {
  if (
    requested === "cloudflare" ||
    requested === "rivet" ||
    requested === "vercel"
  ) {
    throw new Error(
      `${requested} runner is disabled; use eliza-cloud, home, or e2b.`,
    );
  }
  if (requested) return requested;
  if (
    hasAnySetting(runtime, [
      "ELIZA_CLOUD_SANDBOX_BASE_URL",
      "ELIZA_CLOUD_REMOTE_RUNNER_URL",
      "ELIZA_CLOUD_RUNNER_URL",
    ])
  ) {
    return "eliza-cloud";
  }
  if (
    hasAnySetting(runtime, [
      "ELIZA_HOME_REMOTE_RUNNER_URL",
      "ELIZA_HOME_RUNNER_URL",
    ])
  ) {
    return "home";
  }
  return "e2b";
}

function hasAnySetting(runtime: IAgentRuntime, keys: string[]): boolean {
  return keys.some((key) => readSetting(runtime, key) !== undefined);
}

function providerSettingKey(
  provider: SandboxRunnerProvider,
  suffix: string,
): string {
  if (provider === "eliza-cloud") return `ELIZA_CLOUD_SANDBOX_${suffix}`;
  if (provider === "home") return `ELIZA_HOME_REMOTE_RUNNER_${suffix}`;
  return `ELIZA_E2B_${suffix}`;
}

function defaultWorkdir(provider: SandboxRunnerProvider): string {
  return provider === "e2b" ? DEFAULT_E2B_WORKDIR : DEFAULT_REMOTE_WORKDIR;
}

function remoteHttpBaseUrl(
  runtime: IAgentRuntime,
  provider: SandboxRunnerProvider,
): string | undefined {
  if (provider === "eliza-cloud") {
    return (
      readSetting(runtime, "ELIZA_CLOUD_SANDBOX_BASE_URL") ??
      readSetting(runtime, "ELIZA_CLOUD_REMOTE_RUNNER_URL") ??
      readSetting(runtime, "ELIZA_CLOUD_RUNNER_URL")
    );
  }
  if (provider === "home") {
    return (
      readSetting(runtime, "ELIZA_HOME_REMOTE_RUNNER_URL") ??
      readSetting(runtime, "ELIZA_HOME_RUNNER_URL")
    );
  }
  return undefined;
}

function cloudApiBaseUrl(
  runtime: IAgentRuntime,
  provider: SandboxRunnerProvider,
): string | undefined {
  if (provider !== "eliza-cloud") return undefined;
  return normalizeCloudApiBaseUrl(
    readSetting(runtime, "ELIZA_CLOUD_SANDBOX_API_BASE_URL") ??
      readSetting(runtime, "ELIZA_CLOUD_API_BASE_URL") ??
      readSetting(runtime, "ELIZAOS_CLOUD_BASE_URL") ??
      readSetting(runtime, "ELIZA_CLOUD_BASE_URL") ??
      DEFAULT_ELIZA_CLOUD_API_BASE_URL,
  );
}

function cloudApiToken(
  runtime: IAgentRuntime,
  provider: SandboxRunnerProvider,
): string | undefined {
  if (provider !== "eliza-cloud") return undefined;
  return (
    readSetting(runtime, "ELIZA_CLOUD_SANDBOX_TOKEN") ??
    readSetting(runtime, "ELIZA_CLOUD_API_KEY") ??
    readSetting(runtime, "ELIZA_CLOUD_AUTH_TOKEN") ??
    readSetting(runtime, "ELIZAOS_CLOUD_API_KEY") ??
    readSetting(runtime, "ELIZACLOUD_API_KEY")
  );
}

function cloudContainerImage(
  runtime: IAgentRuntime,
  provider: SandboxRunnerProvider,
): string | undefined {
  if (provider !== "eliza-cloud") return undefined;
  return (
    readSetting(runtime, "ELIZA_CLOUD_SANDBOX_IMAGE") ??
    readSetting(runtime, "ELIZA_CLOUD_CODING_REMOTE_RUNNER_IMAGE") ??
    readSetting(runtime, "ELIZA_CODING_REMOTE_RUNNER_IMAGE") ??
    readSetting(runtime, "ELIZA_CLOUD_REMOTE_RUNNER_IMAGE")
  );
}

function remoteHttpToken(
  runtime: IAgentRuntime,
  provider: SandboxRunnerProvider,
): string | undefined {
  if (provider === "eliza-cloud") {
    return (
      readSetting(runtime, "ELIZA_CLOUD_SANDBOX_TOKEN") ??
      readSetting(runtime, "ELIZA_CLOUD_API_KEY") ??
      readSetting(runtime, "ELIZA_CLOUD_AUTH_TOKEN")
    );
  }
  if (provider === "home") {
    return readSetting(runtime, "ELIZA_HOME_REMOTE_RUNNER_TOKEN");
  }
  return undefined;
}

function normalizeCloudApiBaseUrl(value: string): string {
  const trimmed = normalizeHttpBaseUrl(value, "Eliza Cloud API base URL");
  if (trimmed.endsWith("/api/v1")) return trimmed;
  return `${trimmed}/api/v1`;
}

function normalizeHttpBaseUrl(value: string, context: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // error-policy:J3 configured and upstream endpoint text is validated before use.
    throw new ElizaError(`${context} must be a valid HTTP(S) URL.`, {
      code: "REMOTE_HTTP_URL_INVALID",
      context: { field: context },
      severity: "fatal",
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ElizaError(`${context} must use HTTP or HTTPS.`, {
      code: "REMOTE_HTTP_URL_INVALID",
      context: { field: context, protocol: parsed.protocol },
      severity: "fatal",
    });
  }
  if (parsed.username || parsed.password) {
    throw new ElizaError(`${context} must not contain embedded credentials.`, {
      code: "REMOTE_HTTP_URL_CREDENTIALS_REJECTED",
      context: { field: context },
      severity: "fatal",
    });
  }
  if (parsed.search || parsed.hash) {
    throw new ElizaError(`${context} must not contain a query or fragment.`, {
      code: "REMOTE_HTTP_URL_INVALID",
      context: { field: context },
      severity: "fatal",
    });
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeProvisionedRunnerUrl(
  value: string,
  cloudApiBaseUrl: string,
): string {
  const normalized = normalizeHttpBaseUrl(
    value,
    "Eliza Cloud coding-container runner URL",
  );
  const runnerUrl = new URL(normalized);
  const cloudApiUrl = new URL(cloudApiBaseUrl);
  const cloudApiUsesPrivateAuthority =
    isBlockedHostname(cloudApiUrl.hostname) ||
    isPrivateIpAddress(cloudApiUrl.hostname);
  if (
    !cloudApiUsesPrivateAuthority &&
    (runnerUrl.protocol !== "https:" ||
      isBlockedHostname(runnerUrl.hostname) ||
      isPrivateIpAddress(runnerUrl.hostname))
  ) {
    throw new ElizaError(
      "Eliza Cloud coding-container runner URL must use a public HTTPS authority.",
      {
        code: "CLOUD_CODING_CONTAINER_RUNNER_URL_REJECTED",
        severity: "fatal",
      },
    );
  }
  return normalized;
}

function remoteAccessUrl(
  runtime: IAgentRuntime,
  provider: SandboxRunnerProvider,
): string | undefined {
  if (provider === "eliza-cloud") {
    return readSetting(runtime, "ELIZA_CLOUD_SANDBOX_ACCESS_URL");
  }
  if (provider === "home") {
    return (
      readSetting(runtime, "ELIZA_HOME_REMOTE_RUNNER_ACCESS_URL") ??
      readSetting(runtime, "ELIZA_HOME_ACCESS_URL")
    );
  }
  return undefined;
}

function positiveIntSetting(
  runtime: IAgentRuntime,
  key: string,
  fallback: number,
): number {
  const value = readSetting(runtime, key);
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new ElizaError(
      `${key} must be a canonical integer from 1 to ${MAX_TIMER_DELAY_MS}.`,
      {
        code: "REMOTE_RUNNER_CONFIG_INVALID",
        context: { key },
        severity: "fatal",
      },
    );
  }
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed <= MAX_TIMER_DELAY_MS) {
    return parsed;
  }
  throw new ElizaError(
    `${key} must be an integer between 1 and ${MAX_TIMER_DELAY_MS}.`,
    {
      code: "REMOTE_RUNNER_CONFIG_INVALID",
      context: { key },
      severity: "fatal",
    },
  );
}

function agentRunnersSetting(
  runtime: IAgentRuntime,
  provider: SandboxRunnerProvider,
): CodingAgentRunner[] {
  const value =
    readSetting(runtime, "ELIZA_SANDBOX_AGENT_RUNNERS") ??
    readSetting(runtime, "SANDBOX_AGENT_RUNNERS");
  if (value === undefined) {
    return provider === "eliza-cloud" || provider === "home"
      ? DEFAULT_SANDBOX_AGENT_RUNNERS
      : [];
  }
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)
    .map(toCodingAgentRunner);
}

function toCodingAgentRunner(value: string): CodingAgentRunner {
  if (value === "codex") return "codex";
  if (value === "claude" || value === "claude-code") return "claude-code";
  throw new Error(`Unsupported sandbox agent runner: ${value}`);
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function isFalsey(value: string | undefined): boolean {
  if (!value) return false;
  return ["0", "false", "no", "off"].includes(value.toLowerCase());
}

function commandLine(command: string, args: string[]): string {
  if (args.length === 0) return command;
  return [command, ...args.map(shellQuote)].join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandRunResult(
  result: SandboxCommandResult,
  timedOut: boolean,
): TerminalRunResult {
  const stderr = result.stderr.length > 0 ? `\n${result.stderr}` : "";
  return {
    output: `${result.stdout}${stderr}`,
    exitCode: result.exitCode,
    timedOut,
  };
}

function commandResultFromError(error: Error): SandboxCommandResult | null {
  const candidate = error as Partial<SandboxCommandResult>;
  if (
    typeof candidate.exitCode === "number" &&
    typeof candidate.stdout === "string" &&
    typeof candidate.stderr === "string"
  ) {
    return {
      exitCode: candidate.exitCode,
      stdout: candidate.stdout,
      stderr: candidate.stderr,
      ...(typeof candidate.error === "string"
        ? { error: candidate.error }
        : {}),
    };
  }
  return null;
}

function isTimeoutError(error: Error): boolean {
  return (
    error.name === "TimeoutError" || /timed? out|timeout/i.test(error.message)
  );
}

function normalizeSandboxPath(input: string): string {
  const normalized = nodePath.posix.normalize(input.replace(/\\/g, "/"));
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function isSandboxUri(value: string): boolean {
  return /^(e2b|eliza-cloud|home|sandbox):\/\//.test(value);
}

function posixJoin(...parts: string[]): string {
  return nodePath.posix.normalize(nodePath.posix.join(...parts));
}

function isWithinSandboxPath(candidate: string, root: string): boolean {
  if (!candidate.startsWith("/")) return false;
  const normalized = normalizeSandboxPath(candidate);
  const normalizedRoot = normalizeSandboxPath(root);
  const relative = nodePath.posix.relative(normalizedRoot, normalized);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !nodePath.posix.isAbsolute(relative))
  );
}

function isWithinHostPath(candidate: string, root: string): boolean {
  const relative = nodePath.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !nodePath.isAbsolute(relative))
  );
}

function filterEntries(
  entries: SandboxEntryInfo[],
  ignore: string[],
): SandboxEntryInfo[] {
  if (ignore.length === 0) return entries;
  const matchers = ignore.map(globToRegExp);
  return entries.filter(
    (entry) =>
      !matchers.some(
        (matcher) => matcher.test(entry.name) || matcher.test(entry.path),
      ),
  );
}

function globToRegExp(pattern: string): RegExp {
  let regex = "";
  let index = 0;
  while (index < pattern.length) {
    const ch = pattern[index];
    if (ch === "*") {
      if (pattern[index + 1] === "*") {
        regex += ".*";
        index += 2;
      } else {
        regex += "[^/]*";
        index += 1;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      index += 1;
    } else if (".+^$()|[]{}\\".includes(ch ?? "")) {
      regex += `\\${ch}`;
      index += 1;
    } else {
      regex += ch;
      index += 1;
    }
  }
  return new RegExp(`^${regex}$`);
}

function toFileStat(entry: SandboxEntryInfo): FileStat {
  const kind = entry.symlinkTarget
    ? "symlink"
    : entry.type === "dir"
      ? "directory"
      : entry.type === "file"
        ? "file"
        : "other";
  return {
    path: entry.path,
    name: entry.name,
    kind,
    size: entry.size,
    ...(entry.modifiedTime
      ? { modifiedAt: entry.modifiedTime.toISOString() }
      : {}),
  };
}

function parseGitStatus(raw: string): {
  branch?: string;
  ahead?: number;
  behind?: number;
  files: JsonObject[];
} {
  const lines = raw.split("\n").filter((line) => line.length > 0);
  let branch: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  const files: JsonObject[] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const parsed = parseBranchLine(line.slice(3));
      branch = parsed.branch;
      ahead = parsed.ahead;
      behind = parsed.behind;
      continue;
    }
    files.push({
      status: line.slice(0, 2),
      path: line.slice(3),
    });
  }
  return { branch, ahead, behind, files };
}

function parseBranchLine(line: string): {
  branch?: string;
  ahead?: number;
  behind?: number;
} {
  const [branchPart, metaPart] = line.split("...");
  const branch = branchPart === "HEAD (no branch)" ? undefined : branchPart;
  if (!metaPart) return { branch };
  const aheadMatch = metaPart.match(/ahead (\d+)/);
  const behindMatch = metaPart.match(/behind (\d+)/);
  return {
    branch,
    ...(aheadMatch ? { ahead: Number(aheadMatch[1]) } : {}),
    ...(behindMatch ? { behind: Number(behindMatch[1]) } : {}),
  };
}
