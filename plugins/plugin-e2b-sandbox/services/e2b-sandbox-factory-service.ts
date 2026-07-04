/**
 * E2B SDK-backed sandbox factory for the host remote capability router.
 *
 * The service is registered under the shared E2B factory service type; the host
 * router selects this provider only when the plugin is installed and configured.
 * SDK entry metadata is normalized into the core sandbox contract here.
 */

import {
  E2B_SANDBOX_FACTORY_SERVICE_TYPE,
  type E2BSandboxClient,
  type E2BSandboxCreateOptions,
  type E2BSandboxFactoryService as E2BSandboxFactoryServiceContract,
  type IAgentRuntime,
  logger,
  normalizeSandboxEntryType,
  type SandboxCommandRunOptions,
  type SandboxEntryInfo,
  Service,
} from "@elizaos/core";
import type { SandboxConnectOpts, SandboxOpts } from "e2b";

const LOG_CONTEXT = { src: "service:e2b_sandbox_factory" } as const;
export class E2BSandboxFactoryService
  extends Service
  implements E2BSandboxFactoryServiceContract
{
  static override serviceType = E2B_SANDBOX_FACTORY_SERVICE_TYPE;

  override capabilityDescription =
    "Creates and connects e2b.dev cloud sandboxes for the remote capability router.";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<E2BSandboxFactoryService> {
    logger.info(LOG_CONTEXT, "[E2BSandboxFactory] Service started");
    return new E2BSandboxFactoryService(runtime);
  }

  override async stop(): Promise<void> {}

  async create(options: E2BSandboxCreateOptions): Promise<E2BSandboxClient> {
    const { Sandbox } = await import("e2b");
    if (options.sandboxId) {
      return new E2BSandboxSdkClient(
        await Sandbox.connect(options.sandboxId, connectOptions(options)),
      );
    }
    if (options.template) {
      return new E2BSandboxSdkClient(
        await Sandbox.create(options.template, createOptions(options)),
      );
    }
    return new E2BSandboxSdkClient(
      await Sandbox.create(createOptions(options)),
    );
  }
}

type E2BSdkEntryInfo = {
  path: string;
  name: string;
  type?: string;
  size?: number;
  mode?: number;
  permissions?: string;
  owner?: string;
  group?: string;
  modifiedTime?: Date;
  symlinkTarget?: string;
};

type E2BSdkSandbox = {
  readonly sandboxId: string;
  readonly files: {
    list(
      path: string,
      opts?: { depth?: number; requestTimeoutMs?: number },
    ): Promise<E2BSdkEntryInfo[]>;
    read(
      path: string,
      opts?: { format?: "text" | "bytes"; requestTimeoutMs?: number },
    ): Promise<string | Uint8Array>;
    write(
      path: string,
      data: string,
      opts?: { requestTimeoutMs?: number },
    ): Promise<{ path: string; name: string }>;
  };
  readonly commands: {
    run(
      cmd: string,
      opts?: SandboxCommandRunOptions,
    ): Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
      error?: string;
    }>;
  };
  // Match the SDK's boolean kill result so Sandbox stays structurally assignable.
  kill(opts?: { requestTimeoutMs?: number }): Promise<boolean>;
};

export class E2BSandboxSdkClient implements E2BSandboxClient {
  readonly files = {
    list: (
      path: string,
      opts?: { depth?: number; requestTimeoutMs?: number },
    ) => this.list(path, opts),
    read: (
      path: string,
      opts?: { format?: "text" | "bytes"; requestTimeoutMs?: number },
    ) => this.sandbox.files.read(path, opts),
    write: (path: string, data: string, opts?: { requestTimeoutMs?: number }) =>
      this.sandbox.files.write(path, data, opts),
  };
  readonly commands = {
    run: (cmd: string, opts?: SandboxCommandRunOptions) =>
      this.sandbox.commands.run(cmd, opts),
  };

  constructor(private readonly sandbox: E2BSdkSandbox) {}

  get sandboxId(): string {
    return this.sandbox.sandboxId;
  }

  async kill(opts?: { requestTimeoutMs?: number }): Promise<void> {
    await this.sandbox.kill(opts);
  }

  private async list(
    path: string,
    opts?: { depth?: number; requestTimeoutMs?: number },
  ): Promise<SandboxEntryInfo[]> {
    const entries = await this.sandbox.files.list(path, opts);
    return entries.map((entry) => ({
      path: entry.path,
      name: entry.name,
      type: normalizeSandboxEntryType(entry.type),
      size: entry.size ?? 0,
      ...(entry.mode === undefined ? {} : { mode: entry.mode }),
      ...(entry.permissions === undefined
        ? {}
        : { permissions: entry.permissions }),
      ...(entry.owner === undefined ? {} : { owner: entry.owner }),
      ...(entry.group === undefined ? {} : { group: entry.group }),
      ...(entry.modifiedTime === undefined
        ? {}
        : { modifiedTime: entry.modifiedTime }),
      ...(entry.symlinkTarget === undefined
        ? {}
        : { symlinkTarget: entry.symlinkTarget }),
    }));
  }
}

function createOptions(options: E2BSandboxCreateOptions): SandboxOpts {
  return {
    apiKey: options.apiKey,
    accessToken: options.accessToken,
    domain: options.domain,
    envs: options.envs,
    metadata: options.metadata,
    timeoutMs: options.timeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
    allowInternetAccess: options.allowInternetAccess,
    secure: true,
  };
}

function connectOptions(options: E2BSandboxCreateOptions): SandboxConnectOpts {
  return {
    apiKey: options.apiKey,
    accessToken: options.accessToken,
    domain: options.domain,
    timeoutMs: options.timeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
  };
}
