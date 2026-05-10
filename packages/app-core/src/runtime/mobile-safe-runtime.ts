export type MobileSafeRuntimePlatform = "ios" | "android" | "web" | "unknown";

export type MobileSafeRuntimeProviderKind =
  | "javascriptcore"
  | "quickjs"
  | "wasm"
  | "android-isolated-process";

export type MobileSafeRuntimeCapability =
  | "fs.read"
  | "fs.write"
  | "fs.delete"
  | "net.fetch"
  | "crypto.random"
  | "model.inference"
  | (string & {});

export interface MobileSafeRuntimeFeatureProbe {
  env?: Record<string, string | undefined>;
  globals?: Record<string, unknown>;
  platform?: MobileSafeRuntimePlatform;
}

export interface MobileSafeRuntimeFeatures {
  platform: MobileSafeRuntimePlatform;
  supportsWebAssembly: boolean;
  supportsDynamicImport: boolean;
  supportsSharedArrayBuffer: boolean;
  hasNodeRuntime: boolean;
  hasBunRuntime: boolean;
  availableProviders: MobileSafeRuntimeProviderKind[];
  unavailableProviders: Partial<Record<MobileSafeRuntimeProviderKind, string>>;
}

export interface MobileSafeRuntimeFileInfo {
  path: string;
  kind: "file" | "directory";
  size: number;
  updatedAt?: number;
}

export interface MobileSafeVirtualFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<MobileSafeRuntimeFileInfo | null>;
  list(path: string): Promise<MobileSafeRuntimeFileInfo[]>;
}

export interface MobileSafeRuntimeCapabilityRequest<
  TArgs extends Record<string, unknown> = Record<string, unknown>,
> {
  id: string;
  capability: MobileSafeRuntimeCapability;
  operation: string;
  args: TArgs;
  subject?: string;
  timeoutMs?: number;
}

export type MobileSafeRuntimeCapabilityResponse<TResult = unknown> =
  | {
      id: string;
      ok: true;
      result: TResult;
    }
  | {
      id: string;
      ok: false;
      error: {
        code: string;
        message: string;
        retryable?: boolean;
      };
    };

export interface MobileSafeCapabilityBroker {
  call<TResult = unknown>(
    request: MobileSafeRuntimeCapabilityRequest,
  ): Promise<MobileSafeRuntimeCapabilityResponse<TResult>>;
}

export interface MobileSafeRuntimeExecuteInput {
  code: string;
  entrypoint?: string;
  env?: Record<string, string>;
  files?: MobileSafeVirtualFileSystem;
  broker?: MobileSafeCapabilityBroker;
  signal?: AbortSignal;
}

export type MobileSafeRuntimeExecuteResult =
  | {
      ok: true;
      value: unknown;
      logs?: string[];
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        provider: MobileSafeRuntimeProviderKind;
      };
      logs?: string[];
    };

export interface MobileSafeRuntimeProvider {
  kind: MobileSafeRuntimeProviderKind;
  displayName: string;
  supported: boolean;
  reason?: string;
  execute(
    input: MobileSafeRuntimeExecuteInput,
  ): Promise<MobileSafeRuntimeExecuteResult>;
}

export interface IosJavaScriptCoreBoundary {
  kind: "javascriptcore";
  evaluateScript(script: string): Promise<unknown>;
}

export interface IosQuickJsBoundary {
  kind: "quickjs";
  evaluateModule(moduleSource: string, entrypoint?: string): Promise<unknown>;
}

export interface AndroidIsolatedProcessBoundary {
  kind: "android-isolated-process";
  serviceName: string;
  request(
    request: MobileSafeRuntimeCapabilityRequest,
  ): Promise<MobileSafeRuntimeCapabilityResponse>;
}

export interface AndroidIsolatedProcessHook {
  serviceName: string;
  intentAction: string;
  binderInterface: string;
  requiredPermission?: string;
  processName?: string;
}

export function detectMobileSafeRuntimeFeatures(
  probe: MobileSafeRuntimeFeatureProbe = {},
): MobileSafeRuntimeFeatures {
  const globals = probe.globals ?? globalThisAsRecord();
  const env = probe.env ?? {};
  const platform = resolveMobileSafeRuntimePlatform(
    probe.platform,
    env,
    globals,
  );
  const supportsWebAssembly = typeof globals.WebAssembly === "object";
  const supportsDynamicImport = env.ELIZA_MOBILE_DYNAMIC_IMPORT === "1";
  const supportsSharedArrayBuffer =
    typeof globals.SharedArrayBuffer === "function";
  const hasNodeRuntime = typeof globals.process === "object";
  const hasBunRuntime = typeof globals.Bun === "object";

  const unavailableProviders: Partial<
    Record<MobileSafeRuntimeProviderKind, string>
  > = {};
  const availableProviders: MobileSafeRuntimeProviderKind[] = [];

  if (platform === "ios") {
    availableProviders.push("javascriptcore", "quickjs");
  } else {
    unavailableProviders.javascriptcore =
      "JavaScriptCore host boundary is only available in the iOS app shell";
    unavailableProviders.quickjs =
      "QuickJS host boundary is only available in the iOS app shell";
  }

  if (platform === "android") {
    availableProviders.push("android-isolated-process");
  } else {
    unavailableProviders["android-isolated-process"] =
      "Android isolated-process boundary is only available in the Android app shell";
  }

  if (supportsWebAssembly) {
    availableProviders.push("wasm");
  } else {
    unavailableProviders.wasm =
      "WebAssembly is not exposed by this host runtime";
  }

  return {
    platform,
    supportsWebAssembly,
    supportsDynamicImport,
    supportsSharedArrayBuffer,
    hasNodeRuntime,
    hasBunRuntime,
    availableProviders,
    unavailableProviders,
  };
}

export function createUnavailableMobileSafeRuntimeProvider(
  kind: MobileSafeRuntimeProviderKind,
  reason: string,
): MobileSafeRuntimeProvider {
  return {
    kind,
    displayName: displayNameForProvider(kind),
    supported: false,
    reason,
    async execute() {
      return {
        ok: false,
        error: {
          code: "MOBILE_SAFE_RUNTIME_PROVIDER_UNAVAILABLE",
          message: reason,
          provider: kind,
        },
      };
    },
  };
}

export function createIosJavaScriptCoreProvider(
  boundary?: IosJavaScriptCoreBoundary,
): MobileSafeRuntimeProvider {
  if (!boundary) {
    return createUnavailableMobileSafeRuntimeProvider(
      "javascriptcore",
      "iOS JavaScriptCore boundary is not attached; this contract does not imply Bun or Node on iOS",
    );
  }

  return {
    kind: "javascriptcore",
    displayName: "iOS JavaScriptCore",
    supported: true,
    async execute(input) {
      try {
        return { ok: true, value: await boundary.evaluateScript(input.code) };
      } catch (error) {
        return providerFailure("javascriptcore", error);
      }
    },
  };
}

export function createIosQuickJsProvider(
  boundary?: IosQuickJsBoundary,
): MobileSafeRuntimeProvider {
  if (!boundary) {
    return createUnavailableMobileSafeRuntimeProvider(
      "quickjs",
      "iOS QuickJS boundary is not attached; this is a native embedder hook, not a Node/Bun runtime",
    );
  }

  return {
    kind: "quickjs",
    displayName: "iOS QuickJS",
    supported: true,
    async execute(input) {
      try {
        return {
          ok: true,
          value: await boundary.evaluateModule(input.code, input.entrypoint),
        };
      } catch (error) {
        return providerFailure("quickjs", error);
      }
    },
  };
}

export function createAndroidIsolatedProcessHook(
  options: Partial<AndroidIsolatedProcessHook> = {},
): AndroidIsolatedProcessHook {
  return {
    serviceName:
      options.serviceName ?? "ai.elizaos.app.MobileSafeRuntimeService",
    intentAction:
      options.intentAction ?? "ai.elizaos.app.action.MOBILE_SAFE_RUNTIME",
    binderInterface:
      options.binderInterface ?? "ai.elizaos.app.IMobileSafeRuntime",
    requiredPermission:
      options.requiredPermission ??
      "ai.elizaos.app.permission.MOBILE_SAFE_RUNTIME",
    processName: options.processName ?? ":eliza_mobile_safe_runtime",
  };
}

export function createAndroidIsolatedProcessProvider(
  boundary?: AndroidIsolatedProcessBoundary,
): MobileSafeRuntimeProvider {
  if (!boundary) {
    return createUnavailableMobileSafeRuntimeProvider(
      "android-isolated-process",
      "Android isolated-process boundary is not attached",
    );
  }

  return {
    kind: "android-isolated-process",
    displayName: "Android isolated process",
    supported: true,
    async execute(input) {
      const response = await boundary.request({
        id: cryptoRequestId(),
        capability: "model.inference",
        operation: "execute",
        args: {
          code: input.code,
          entrypoint: input.entrypoint,
          env: input.env ?? {},
        },
      });

      if (response.ok) return { ok: true, value: response.result };
      return {
        ok: false,
        error: {
          code: response.error.code,
          message: response.error.message,
          provider: "android-isolated-process",
        },
      };
    },
  };
}

export function createMobileSafeCapabilityBroker(
  handler: (
    request: MobileSafeRuntimeCapabilityRequest,
  ) =>
    | Promise<MobileSafeRuntimeCapabilityResponse>
    | MobileSafeRuntimeCapabilityResponse,
): MobileSafeCapabilityBroker {
  return {
    async call<TResult = unknown>(request: MobileSafeRuntimeCapabilityRequest) {
      try {
        const response = await handler(request);
        return response as MobileSafeRuntimeCapabilityResponse<TResult>;
      } catch (error) {
        return {
          id: request.id,
          ok: false,
          error: {
            code: "MOBILE_SAFE_CAPABILITY_FAILED",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        };
      }
    },
  };
}

export function normalizeMobileSafePath(path: string): string {
  const normalized = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
    .reduce<string[]>((parts, part) => {
      if (part === "..") parts.pop();
      else parts.push(part);
      return parts;
    }, []);

  return `/${normalized.join("/")}`;
}

export class MemoryMobileSafeVirtualFileSystem
  implements MobileSafeVirtualFileSystem
{
  private readonly files = new Map<
    string,
    { data: Uint8Array; updatedAt: number }
  >();
  private readonly directories = new Set<string>(["/"]);

  async readFile(path: string): Promise<Uint8Array> {
    const entry = this.files.get(normalizeMobileSafePath(path));
    if (!entry) throw new Error(`File not found: ${path}`);
    return new Uint8Array(entry.data);
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const normalized = normalizeMobileSafePath(path);
    this.directories.add(parentPath(normalized));
    this.files.set(normalized, {
      data: new Uint8Array(data),
      updatedAt: Date.now(),
    });
  }

  async delete(path: string): Promise<void> {
    const normalized = normalizeMobileSafePath(path);
    this.files.delete(normalized);
    this.directories.delete(normalized);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(normalizeMobileSafePath(path));
  }

  async stat(path: string): Promise<MobileSafeRuntimeFileInfo | null> {
    const normalized = normalizeMobileSafePath(path);
    const file = this.files.get(normalized);
    if (file) {
      return {
        path: normalized,
        kind: "file",
        size: file.data.byteLength,
        updatedAt: file.updatedAt,
      };
    }
    if (this.directories.has(normalized)) {
      return { path: normalized, kind: "directory", size: 0 };
    }
    return null;
  }

  async list(path: string): Promise<MobileSafeRuntimeFileInfo[]> {
    const normalized = normalizeMobileSafePath(path);
    const entries: MobileSafeRuntimeFileInfo[] = [];

    for (const [filePath, file] of this.files) {
      if (parentPath(filePath) === normalized) {
        entries.push({
          path: filePath,
          kind: "file",
          size: file.data.byteLength,
          updatedAt: file.updatedAt,
        });
      }
    }

    for (const directory of this.directories) {
      if (directory !== normalized && parentPath(directory) === normalized) {
        entries.push({ path: directory, kind: "directory", size: 0 });
      }
    }

    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }
}

function resolveMobileSafeRuntimePlatform(
  explicit: MobileSafeRuntimePlatform | undefined,
  env: Record<string, string | undefined>,
  globals: Record<string, unknown>,
): MobileSafeRuntimePlatform {
  if (explicit) return explicit;
  const envPlatform = env.ELIZA_PLATFORM?.toLowerCase();
  if (envPlatform === "ios" || envPlatform === "android") return envPlatform;
  if (typeof globals.Capacitor === "object" && globals.Capacitor !== null) {
    const capacitor = globals.Capacitor as { getPlatform?: () => string };
    const platform = capacitor.getPlatform?.();
    if (platform === "ios" || platform === "android" || platform === "web") {
      return platform;
    }
  }
  return "unknown";
}

function displayNameForProvider(kind: MobileSafeRuntimeProviderKind): string {
  switch (kind) {
    case "android-isolated-process":
      return "Android isolated process";
    case "javascriptcore":
      return "iOS JavaScriptCore";
    case "quickjs":
      return "iOS QuickJS";
    case "wasm":
      return "WebAssembly";
  }
}

function providerFailure(
  provider: MobileSafeRuntimeProviderKind,
  error: unknown,
): MobileSafeRuntimeExecuteResult {
  return {
    ok: false,
    error: {
      code: "MOBILE_SAFE_RUNTIME_EXECUTE_FAILED",
      message: error instanceof Error ? error.message : String(error),
      provider,
    },
  };
}

function globalThisAsRecord(): Record<string, unknown> {
  return globalThis as Record<string, unknown>;
}

function parentPath(path: string): string {
  const normalized = normalizeMobileSafePath(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function cryptoRequestId(): string {
  const cryptoGlobal = (
    globalThis as { crypto?: { randomUUID?: () => string } }
  ).crypto;
  return cryptoGlobal?.randomUUID?.() ?? `mobile-safe-${Date.now()}`;
}
