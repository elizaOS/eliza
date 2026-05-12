export type MobileSafeRuntimePlatform = "ios" | "android" | "web" | "unknown";

export type MobileSafeRuntimeProviderKind =
  | "android-avf-microdroid"
  | "safe-js-applet"
  | "javascriptcore"
  | "quickjs"
  | "wasm"
  | "android-isolated-process";

export type AndroidAvfMicrodroidCapabilityState =
  | "unsupported-platform"
  | "unsupported-api"
  | "framework-unavailable"
  | "permission-denied"
  | "service-unavailable"
  | "payload-missing"
  | "ready";

export type MobileSafeRuntimeCapability =
  | "fs.read"
  | "fs.write"
  | "fs.delete"
  | "fs.mkdir"
  | "fs.stat"
  | "fs.list"
  | "fs.snapshot"
  | "fs.diff"
  | "fs.rollback"
  | "fs.quota"
  | "net.fetch"
  | "crypto.random"
  | "model.inference"
  | "shell.exec"
  | "app.compile"
  | "app.load"
  | "app.run"
  | (string & {});

export interface MobileSafeRuntimeFeatureProbe {
  env?: Record<string, string | undefined>;
  globals?: Record<string, unknown>;
  platform?: MobileSafeRuntimePlatform;
  androidAvfAvailable?: boolean;
  androidMicrodroidAvailable?: boolean;
  androidAvfPayloadAvailable?: boolean;
  androidAvfCapabilityState?: AndroidAvfMicrodroidCapabilityState;
  androidIsolatedProcessAvailable?: boolean;
  iosJavaScriptCoreAvailable?: boolean;
  iosQuickJsAvailable?: boolean;
  allowInProcessSafeJsApplet?: boolean;
}

export interface AndroidAvfMicrodroidRuntimeStatus {
  state: AndroidAvfMicrodroidCapabilityState;
  available: boolean;
  avfAvailable: boolean;
  microdroidAvailable: boolean;
  payloadAvailable: boolean;
  capabilities: string[];
  reason?: string;
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
  androidAvfMicrodroid: AndroidAvfMicrodroidRuntimeStatus;
}

export interface MobileSafeRuntimeFileInfo {
  path: string;
  kind: "file" | "directory";
  size: number;
  updatedAt?: number;
}

export type MobileSafeRuntimeDiffStatus = "added" | "modified" | "deleted";

export interface MobileSafeRuntimeSnapshot {
  id: string;
  createdAt: number;
  note?: string;
  filesBytes: number;
  fileCount: number;
}

export interface MobileSafeRuntimeDiffEntry {
  path: string;
  status: MobileSafeRuntimeDiffStatus;
  before?: MobileSafeRuntimeFileInfo;
  after?: MobileSafeRuntimeFileInfo;
}

export interface MobileSafeRuntimeQuota {
  usedBytes: number;
  fileCount: number;
  quotaBytes?: number;
  maxFileBytes?: number;
}

export interface MobileSafeVirtualFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<MobileSafeRuntimeFileInfo | null>;
  list(path: string): Promise<MobileSafeRuntimeFileInfo[]>;
  createSnapshot?(note?: string): Promise<MobileSafeRuntimeSnapshot>;
  diffCurrent?(snapshotId: string): Promise<MobileSafeRuntimeDiffEntry[]>;
  rollback?(snapshotId: string): Promise<void>;
  quota?(): Promise<MobileSafeRuntimeQuota>;
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
  mode?: "evaluate" | "compile-app" | "load-app" | "run-app" | "shell";
  applet?: MobileSafeRuntimeAppletExecuteOptions;
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

export type MobileSafeAppletModuleFormat = "javascript" | "typescript";

export interface MobileSafeAppletManifest {
  id: string;
  version: string;
  name?: string;
  description?: string;
  runtime?: "mobile-safe-js";
  entrypoint: string;
  moduleFormat?: MobileSafeAppletModuleFormat;
  files?: string[];
  permissions?: MobileSafeRuntimeCapability[];
  env?: Record<string, string>;
  createdAt?: number;
  compiled?: {
    bundlePath: string;
    compiledAt: number;
    sourceHash: string;
    files: string[];
  };
}

export interface MobileSafeCompiledApplet {
  manifestPath: string;
  bundlePath: string;
  manifest: MobileSafeAppletManifest;
  sourceHash: string;
  files: string[];
}

export interface MobileSafeLoadedApplet {
  manifestPath: string;
  bundlePath: string;
  manifest: MobileSafeAppletManifest;
  bundle: string;
}

export interface MobileSafeRuntimeAppletExecuteOptions {
  manifestPath?: string;
  appRoot?: string;
  bundlePath?: string;
  input?: unknown;
}

export interface CompileMobileSafeAppletOptions {
  files: MobileSafeVirtualFileSystem;
  manifest?: MobileSafeAppletManifest;
  manifestPath?: string;
  appRoot?: string;
  outputPath?: string;
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

export interface AndroidAvfMicrodroidBoundary {
  kind: "android-avf-microdroid";
  capabilityState?: AndroidAvfMicrodroidCapabilityState;
  reason?: string;
  capabilities?: string[];
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
  const androidAvfMicrodroid = resolveAndroidAvfMicrodroidStatus(
    platform,
    probe,
    env,
    globals,
  );
  const androidIsolatedProcessAvailable =
    probe.androidIsolatedProcessAvailable === true ||
    env.ELIZA_ANDROID_ISOLATED_PROCESS_AVAILABLE === "1" ||
    readBooleanGlobal(globals.AndroidIsolatedProcess, "available") === true ||
    readBooleanGlobal(globals.MobileSafeRuntimeService, "available") === true;
  const iosJavaScriptCoreAvailable =
    probe.iosJavaScriptCoreAvailable === true ||
    env.ELIZA_IOS_JAVASCRIPTCORE_AVAILABLE === "1" ||
    readBooleanGlobal(globals.CapacitorJsc, "available") === true ||
    readBooleanGlobal(globals.JavaScriptCoreBoundary, "available") === true;
  const iosQuickJsAvailable =
    probe.iosQuickJsAvailable === true ||
    env.ELIZA_IOS_QUICKJS_AVAILABLE === "1" ||
    readBooleanGlobal(globals.CapacitorQuickJs, "available") === true ||
    readBooleanGlobal(globals.QuickJsBoundary, "available") === true;
  const safeJsAppletAllowed =
    probe.allowInProcessSafeJsApplet === true ||
    env.ELIZA_MOBILE_SAFE_JS_APPLET_DEV === "1";

  const unavailableProviders: Partial<
    Record<MobileSafeRuntimeProviderKind, string>
  > = {};
  const availableProviders: MobileSafeRuntimeProviderKind[] = [];

  if (platform === "ios") {
    if (iosJavaScriptCoreAvailable) {
      availableProviders.push("javascriptcore");
    } else {
      unavailableProviders.javascriptcore =
        "iOS JavaScriptCore boundary is not attached in this app shell";
    }
    if (iosQuickJsAvailable) {
      availableProviders.push("quickjs");
    } else {
      unavailableProviders.quickjs =
        "iOS QuickJS boundary is not attached in this app shell";
    }
  } else {
    unavailableProviders.javascriptcore =
      "JavaScriptCore host boundary is only available in the iOS app shell";
    unavailableProviders.quickjs =
      "QuickJS host boundary is only available in the iOS app shell";
  }

  if (platform === "android") {
    if (androidAvfMicrodroid.available) {
      availableProviders.push("android-avf-microdroid");
    } else {
      unavailableProviders["android-avf-microdroid"] =
        androidAvfMicrodroid.reason ??
        "Android AVF/Microdroid boundary is not available on this device/build";
    }
    if (androidIsolatedProcessAvailable) {
      availableProviders.push("android-isolated-process");
    } else {
      unavailableProviders["android-isolated-process"] =
        "Android isolated-process boundary is not attached in this app shell";
    }
  } else {
    unavailableProviders["android-avf-microdroid"] =
      "Android AVF/Microdroid boundary is only available in supported Android app shells";
    unavailableProviders["android-isolated-process"] =
      "Android isolated-process boundary is only available in the Android app shell";
  }

  if (supportsWebAssembly) {
    availableProviders.push("wasm");
  } else {
    unavailableProviders.wasm =
      "WebAssembly is not exposed by this host runtime";
  }

  if (safeJsAppletAllowed && typeof globals.Function === "function") {
    availableProviders.push("safe-js-applet");
  } else {
    unavailableProviders["safe-js-applet"] = safeJsAppletAllowed
      ? "This host runtime does not expose JavaScript evaluation for applet fallback"
      : "In-process safe-js applet fallback is dev-only and is not a hard sandbox";
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
    androidAvfMicrodroid,
  };
}

export function createAndroidAvfMicrodroidProvider(
  boundary?: AndroidAvfMicrodroidBoundary,
): MobileSafeRuntimeProvider {
  if (!boundary) {
    return createUnavailableMobileSafeRuntimeProvider(
      "android-avf-microdroid",
      "Android AVF/Microdroid boundary is not attached",
    );
  }
  if (
    boundary.capabilityState !== undefined &&
    boundary.capabilityState !== "ready"
  ) {
    return createUnavailableMobileSafeRuntimeProvider(
      "android-avf-microdroid",
      boundary.reason ?? androidAvfMicrodroidReason(boundary.capabilityState),
    );
  }

  return {
    kind: "android-avf-microdroid",
    displayName: "Android AVF/Microdroid",
    supported: true,
    async execute(input) {
      const response = await boundary.request({
        id: cryptoRequestId(),
        capability: capabilityForExecuteMode(input.mode),
        operation: "execute",
        args: {
          code: input.code,
          entrypoint: input.entrypoint,
          env: input.env ?? {},
          mode: input.mode ?? "evaluate",
          applet: input.applet ?? {},
          virtualFileSystem: {
            attached: Boolean(input.files),
            transport: input.broker
              ? "mobile-safe-capability-broker"
              : input.files
                ? "host-vfs"
                : "none",
          },
        },
      });

      if (response.ok === true) return { ok: true, value: response.result };
      return {
        ok: false,
        error: {
          code: response.error.code,
          message: response.error.message,
          provider: "android-avf-microdroid",
        },
      };
    },
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

export function createInProcessSafeJsAppletProvider(
  options: { now?: () => number } = {},
): MobileSafeRuntimeProvider {
  return {
    kind: "safe-js-applet",
    displayName: "In-process safe JS applet",
    supported: typeof Function === "function",
    reason:
      typeof Function === "function"
        ? undefined
        : "This host runtime does not expose JavaScript evaluation",
    async execute(input) {
      try {
        if (input.mode === "shell") {
          return {
            ok: false,
            error: {
              code: "MOBILE_SAFE_SHELL_UNSUPPORTED",
              message:
                "The in-process applet provider never executes host shell commands",
              provider: "safe-js-applet",
            },
          };
        }

        if (input.mode === "compile-app") {
          if (!input.files) {
            return {
              ok: false,
              error: {
                code: "MOBILE_SAFE_APPLET_VFS_REQUIRED",
                message: "compile-app requires a mobile-safe VFS",
                provider: "safe-js-applet",
              },
            };
          }
          const manifest =
            input.code.trim().length > 0
              ? parseMobileSafeAppletManifest(input.code)
              : undefined;
          const compiled = await compileMobileSafeApplet({
            files: input.files,
            manifest,
            manifestPath: input.applet?.manifestPath,
            appRoot: input.applet?.appRoot,
            outputPath: input.applet?.bundlePath,
          });
          return { ok: true, value: compiled };
        }

        if (input.mode === "load-app") {
          if (!input.files) {
            return {
              ok: false,
              error: {
                code: "MOBILE_SAFE_APPLET_VFS_REQUIRED",
                message: "load-app requires a mobile-safe VFS",
                provider: "safe-js-applet",
              },
            };
          }
          return {
            ok: true,
            value: await loadMobileSafeApplet({
              files: input.files,
              manifestPath: input.applet?.manifestPath,
            }),
          };
        }

        const logs: string[] = [];
        const bundle =
          input.mode === "run-app" && input.files && input.applet?.manifestPath
            ? (
                await loadMobileSafeApplet({
                  files: input.files,
                  manifestPath: input.applet.manifestPath,
                })
              ).bundle
            : input.code;
        assertMobileSafeAppletSource(bundle, "bundle");
        const api = await createSafeAppletApi({
          files: input.files,
          broker: input.broker,
          env: input.env,
          logs,
          now: options.now,
        });
        const runner = new Function(
          "input",
          "api",
          "globalThis",
          "window",
          "self",
          "process",
          "Bun",
          "Deno",
          "require",
          "module",
          "exports",
          `"use strict";\n${bundle}\nreturn __mobileSafeApplet(input, api);`,
        );
        const value = await runner(
          input.applet?.input,
          api,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
        );
        return { ok: true, value, logs };
      } catch (error) {
        return {
          ...providerFailure("safe-js-applet", error),
          logs: [],
        };
      }
    },
  };
}

export async function writeMobileSafeAppletManifest(
  files: MobileSafeVirtualFileSystem,
  manifest: MobileSafeAppletManifest,
  manifestPath = "/app/mobile-safe-applet.json",
): Promise<MobileSafeAppletManifest> {
  const normalizedManifest = normalizeMobileSafeAppletManifest(manifest);
  await files.writeFile(
    manifestPath,
    new TextEncoder().encode(JSON.stringify(normalizedManifest, null, 2)),
  );
  return normalizedManifest;
}

export async function readMobileSafeAppletManifest(
  files: MobileSafeVirtualFileSystem,
  manifestPath = "/app/mobile-safe-applet.json",
): Promise<MobileSafeAppletManifest> {
  return normalizeMobileSafeAppletManifest(
    parseMobileSafeAppletManifest(
      new TextDecoder().decode(await files.readFile(manifestPath)),
    ),
  );
}

export async function compileMobileSafeApplet(
  options: CompileMobileSafeAppletOptions,
): Promise<MobileSafeCompiledApplet> {
  const appRoot = normalizeMobileSafePath(options.appRoot ?? "/app");
  const manifestPath = normalizeMobileSafePath(
    options.manifestPath ?? "/app/mobile-safe-applet.json",
  );
  const manifest = normalizeMobileSafeAppletManifest(
    options.manifest ??
      (await readMobileSafeAppletManifest(options.files, manifestPath)),
  );
  const appFiles = normalizeMobileSafeAppletFiles(manifest, appRoot);
  const modules: Array<{ path: string; source: string }> = [];

  for (const filePath of appFiles) {
    const source = new TextDecoder().decode(
      await options.files.readFile(filePath),
    );
    const compiledSource =
      manifest.moduleFormat === "typescript" || filePath.endsWith(".ts")
        ? stripMobileSafeTypeScript(source)
        : source;
    assertMobileSafeAppletSource(compiledSource, filePath);
    modules.push({
      path: filePath,
      source: compiledSource,
    });
  }

  const sourceHash = mobileSafeStableHash(
    modules.map((module) => `${module.path}\n${module.source}`).join("\n---\n"),
  );
  const bundlePath = normalizeMobileSafePath(
    options.outputPath ?? `${appRoot}/.mobile-safe/${manifest.id}.bundle.js`,
  );
  const compiledManifest: MobileSafeAppletManifest = {
    ...manifest,
    runtime: "mobile-safe-js",
    compiled: {
      bundlePath,
      compiledAt: Date.now(),
      sourceHash,
      files: appFiles,
    },
  };
  const bundle = createMobileSafeAppletBundle(compiledManifest, modules);

  await options.files.mkdir(parentPath(bundlePath));
  await options.files.writeFile(bundlePath, new TextEncoder().encode(bundle));
  await writeMobileSafeAppletManifest(
    options.files,
    compiledManifest,
    manifestPath,
  );

  return {
    manifestPath,
    bundlePath,
    manifest: compiledManifest,
    sourceHash,
    files: appFiles,
  };
}

export async function loadMobileSafeApplet(options: {
  files: MobileSafeVirtualFileSystem;
  manifestPath?: string;
}): Promise<MobileSafeLoadedApplet> {
  const manifestPath = normalizeMobileSafePath(
    options.manifestPath ?? "/app/mobile-safe-applet.json",
  );
  const manifest = await readMobileSafeAppletManifest(
    options.files,
    manifestPath,
  );
  const bundlePath = manifest.compiled?.bundlePath
    ? normalizeMobileSafePath(manifest.compiled.bundlePath)
    : normalizeMobileSafePath(
        `${parentPath(manifestPath)}/.mobile-safe/${manifest.id}.bundle.js`,
      );
  const bundle = new TextDecoder().decode(
    await options.files.readFile(bundlePath),
  );
  assertMobileSafeAppletSource(bundle, bundlePath);
  return { manifestPath, bundlePath, manifest, bundle };
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
        capability: capabilityForExecuteMode(input.mode),
        operation: "execute",
        args: {
          code: input.code,
          entrypoint: input.entrypoint,
          env: input.env ?? {},
        },
      });

      if (response.ok === true) return { ok: true, value: response.result };
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

export function createMobileSafeVirtualFileSystemBroker(
  files: MobileSafeVirtualFileSystem,
): MobileSafeCapabilityBroker {
  return createMobileSafeCapabilityBroker(async (request) => {
    const path =
      typeof request.args.path === "string"
        ? request.args.path
        : typeof request.args.target === "string"
          ? request.args.target
          : "/";
    switch (request.capability) {
      case "fs.read":
        return {
          id: request.id,
          ok: true,
          result: await files.readFile(path),
        };
      case "fs.write": {
        const raw = request.args.data ?? request.args.content;
        const data =
          raw instanceof Uint8Array
            ? raw
            : new TextEncoder().encode(
                typeof raw === "string" ? raw : JSON.stringify(raw ?? ""),
              );
        await files.writeFile(path, data);
        return { id: request.id, ok: true, result: { path } };
      }
      case "fs.delete":
        await files.delete(path);
        return { id: request.id, ok: true, result: { path } };
      case "fs.mkdir":
        await files.mkdir(path);
        return { id: request.id, ok: true, result: { path } };
      case "fs.stat":
        return { id: request.id, ok: true, result: await files.stat(path) };
      case "fs.list":
        return { id: request.id, ok: true, result: await files.list(path) };
      case "fs.snapshot":
        if (!files.createSnapshot) {
          return unsupportedCapability(
            request,
            "VFS snapshots are unavailable",
          );
        }
        return {
          id: request.id,
          ok: true,
          result: await files.createSnapshot(
            typeof request.args.note === "string"
              ? request.args.note
              : undefined,
          ),
        };
      case "fs.diff":
        if (!files.diffCurrent) {
          return unsupportedCapability(request, "VFS diffs are unavailable");
        }
        if (typeof request.args.snapshotId !== "string") {
          return unsupportedCapability(request, "snapshotId is required");
        }
        return {
          id: request.id,
          ok: true,
          result: await files.diffCurrent(request.args.snapshotId),
        };
      case "fs.rollback":
        if (!files.rollback) {
          return unsupportedCapability(request, "VFS rollback is unavailable");
        }
        if (typeof request.args.snapshotId !== "string") {
          return unsupportedCapability(request, "snapshotId is required");
        }
        await files.rollback(request.args.snapshotId);
        return { id: request.id, ok: true, result: { rolledBack: true } };
      case "fs.quota":
        if (!files.quota) {
          return unsupportedCapability(request, "VFS quota is unavailable");
        }
        return { id: request.id, ok: true, result: await files.quota() };
      default:
        return unsupportedCapability(
          request,
          `Unsupported mobile-safe VFS capability: ${request.capability}`,
        );
    }
  });
}

export interface AgentVirtualFilesystemLike {
  readFile?(path: string): Promise<string>;
  readFileBytes?(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<unknown>;
  delete?(path: string, options?: { recursive?: boolean }): Promise<void>;
  list?(
    path?: string,
    options?: { recursive?: boolean },
  ): Promise<
    Array<{
      path: string;
      type?: "file" | "directory";
      kind?: "file" | "directory";
      size: number;
      mtimeMs?: number;
      updatedAt?: number;
    }>
  >;
  createSnapshot?(note?: string): Promise<{
    id: string;
    createdAt?: string | number;
    note?: string;
    filesBytes: number;
    fileCount: number;
  }>;
  diffCurrent?(snapshotId: string): Promise<
    Array<{
      path: string;
      status: MobileSafeRuntimeDiffStatus;
      before?: {
        path: string;
        type?: "file" | "directory";
        kind?: "file" | "directory";
        size: number;
        mtimeMs?: number;
        updatedAt?: number;
      };
      after?: {
        path: string;
        type?: "file" | "directory";
        kind?: "file" | "directory";
        size: number;
        mtimeMs?: number;
        updatedAt?: number;
      };
    }>
  >;
  rollback?(snapshotId: string): Promise<unknown>;
  quota?(): Promise<MobileSafeRuntimeQuota>;
  quotaBytes?: number;
  maxFileBytes?: number;
}

export function createMobileSafeVirtualFileSystemAdapter(
  vfs: AgentVirtualFilesystemLike,
): MobileSafeVirtualFileSystem {
  return {
    async readFile(path) {
      if (vfs.readFileBytes) {
        return new Uint8Array(await vfs.readFileBytes(path));
      }
      if (vfs.readFile) {
        return new TextEncoder().encode(await vfs.readFile(path));
      }
      throw new Error("Wrapped VFS does not support readFile");
    },
    async writeFile(path, data) {
      await vfs.writeFile(path, data);
    },
    async delete(path) {
      if (!vfs.delete) throw new Error("Wrapped VFS does not support delete");
      await vfs.delete(path, { recursive: true });
    },
    async mkdir(_path) {
      // The agent VFS creates parent directories on write and intentionally does
      // not expose empty directory creation as a primitive.
    },
    async stat(path) {
      if (!vfs.list) return null;
      if (normalizeMobileSafePath(path) === "/") {
        return { path: "/", kind: "directory", size: 0 };
      }
      const parent = parentPath(path);
      const entries = await vfs.list(parent === "/" ? "." : parent);
      const normalized = normalizeMobileSafePath(path);
      const match = entries.find(
        (entry) => normalizeMobileSafePath(entry.path) === normalized,
      );
      return match ? toMobileSafeFileInfo(match) : null;
    },
    async list(path) {
      if (!vfs.list) return [];
      const entries = await vfs.list(path === "/" ? "." : path);
      return entries.map(toMobileSafeFileInfo);
    },
    createSnapshot: vfs.createSnapshot
      ? async (note) => toMobileSafeSnapshot(await vfs.createSnapshot?.(note))
      : undefined,
    diffCurrent: vfs.diffCurrent
      ? async (snapshotId) =>
          (await vfs.diffCurrent?.(snapshotId))?.map((entry) => ({
            path: normalizeMobileSafePath(entry.path),
            status: entry.status,
            ...(entry.before
              ? { before: toMobileSafeFileInfo(entry.before) }
              : {}),
            ...(entry.after
              ? { after: toMobileSafeFileInfo(entry.after) }
              : {}),
          })) ?? []
      : undefined,
    rollback: vfs.rollback
      ? async (snapshotId) => {
          await vfs.rollback?.(snapshotId);
        }
      : undefined,
    quota: async () => {
      if (vfs.quota) {
        return vfs.quota();
      }
      if (vfs.list) {
        const entries = await vfs.list?.(".", { recursive: true });
        const files = (entries ?? []).filter(
          (entry) => (entry.kind ?? entry.type) === "file",
        );
        return {
          usedBytes: files.reduce((sum, entry) => sum + entry.size, 0),
          fileCount: files.length,
          ...(typeof vfs.quotaBytes === "number"
            ? { quotaBytes: vfs.quotaBytes }
            : {}),
          ...(typeof vfs.maxFileBytes === "number"
            ? { maxFileBytes: vfs.maxFileBytes }
            : {}),
        };
      }
      return {
        usedBytes: 0,
        fileCount: 0,
        ...(typeof vfs.quotaBytes === "number"
          ? { quotaBytes: vfs.quotaBytes }
          : {}),
        ...(typeof vfs.maxFileBytes === "number"
          ? { maxFileBytes: vfs.maxFileBytes }
          : {}),
      };
    },
  };
}

export function selectMobileSafeRuntimeProvider(options: {
  features: MobileSafeRuntimeFeatures;
  providers: Partial<
    Record<MobileSafeRuntimeProviderKind, MobileSafeRuntimeProvider>
  >;
  preferredOrder?: MobileSafeRuntimeProviderKind[];
}): MobileSafeRuntimeProvider {
  const order =
    options.preferredOrder ??
    defaultProviderOrderForPlatform(options.features.platform);
  const available = new Set(options.features.availableProviders);
  for (const kind of order) {
    const provider = options.providers[kind];
    if (provider?.supported && available.has(kind)) {
      return provider;
    }
  }
  return createUnavailableMobileSafeRuntimeProvider(
    order[0] ?? "wasm",
    "No supported mobile-safe runtime provider is attached",
  );
}

export function normalizeMobileSafePath(path: string): string {
  if (typeof path !== "string" || path.includes("\0")) {
    throw new Error("Invalid mobile-safe VFS path");
  }
  const rawParts = path.replaceAll("\\", "/").split("/");
  if (rawParts.some((part) => part === "..")) {
    throw new Error("Path traversal segments are not allowed");
  }
  const normalized = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
    .reduce<string[]>((parts, part) => {
      parts.push(part);
      return parts;
    }, []);

  return `/${normalized.join("/")}`;
}

export class MemoryMobileSafeVirtualFileSystem
  implements MobileSafeVirtualFileSystem
{
  readonly quotaBytes?: number;
  readonly maxFileBytes?: number;
  private readonly files = new Map<
    string,
    { data: Uint8Array; updatedAt: number }
  >();
  private readonly directories = new Set<string>(["/"]);
  private readonly snapshots = new Map<
    string,
    {
      meta: MobileSafeRuntimeSnapshot;
      files: Map<string, { data: Uint8Array; updatedAt: number }>;
      directories: Set<string>;
    }
  >();
  private snapshotCounter = 0;

  constructor(options: { quotaBytes?: number; maxFileBytes?: number } = {}) {
    this.quotaBytes = options.quotaBytes;
    this.maxFileBytes = options.maxFileBytes;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const entry = this.files.get(normalizeMobileSafePath(path));
    if (!entry) throw new Error(`File not found: ${path}`);
    return new Uint8Array(entry.data);
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const normalized = normalizeMobileSafePath(path);
    if (
      typeof this.maxFileBytes === "number" &&
      data.byteLength > this.maxFileBytes
    ) {
      throw new Error(
        `Mobile-safe VFS file exceeds max file size of ${this.maxFileBytes} bytes`,
      );
    }

    const existing = this.files.get(normalized)?.data.byteLength ?? 0;
    const current = await this.usedBytes();
    const nextUsedBytes = current - existing + data.byteLength;
    if (
      typeof this.quotaBytes === "number" &&
      nextUsedBytes > this.quotaBytes
    ) {
      throw new Error(
        `Mobile-safe VFS quota exceeded: ${nextUsedBytes}/${this.quotaBytes} bytes`,
      );
    }

    this.ensureDirectoryPath(parentPath(normalized));
    this.files.set(normalized, {
      data: new Uint8Array(data),
      updatedAt: Date.now(),
    });
  }

  async delete(path: string): Promise<void> {
    const normalized = normalizeMobileSafePath(path);
    if (normalized === "/") {
      this.files.clear();
      this.directories.clear();
      this.directories.add("/");
      return;
    }
    this.files.delete(normalized);
    for (const filePath of [...this.files.keys()]) {
      if (filePath.startsWith(`${normalized}/`)) {
        this.files.delete(filePath);
      }
    }
    this.directories.delete(normalized);
    for (const directory of [...this.directories]) {
      if (directory.startsWith(`${normalized}/`)) {
        this.directories.delete(directory);
      }
    }
  }

  async mkdir(path: string): Promise<void> {
    this.ensureDirectoryPath(normalizeMobileSafePath(path));
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

  async createSnapshot(note?: string): Promise<MobileSafeRuntimeSnapshot> {
    const { usedBytes, fileCount } = await this.quota();
    const id = `mobile-safe-${Date.now()}-${++this.snapshotCounter}`;
    const meta: MobileSafeRuntimeSnapshot = {
      id,
      createdAt: Date.now(),
      ...(note ? { note } : {}),
      filesBytes: usedBytes,
      fileCount,
    };
    const files = new Map<string, { data: Uint8Array; updatedAt: number }>();
    for (const [filePath, entry] of this.files) {
      files.set(filePath, {
        data: new Uint8Array(entry.data),
        updatedAt: entry.updatedAt,
      });
    }
    this.snapshots.set(id, {
      meta,
      files,
      directories: new Set(this.directories),
    });
    return meta;
  }

  async diffCurrent(snapshotId: string): Promise<MobileSafeRuntimeDiffEntry[]> {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);
    return diffFileMaps(snapshot.files, this.files);
  }

  async rollback(snapshotId: string): Promise<void> {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);
    this.files.clear();
    for (const [filePath, entry] of snapshot.files) {
      this.files.set(filePath, {
        data: new Uint8Array(entry.data),
        updatedAt: entry.updatedAt,
      });
    }
    this.directories.clear();
    for (const directory of snapshot.directories) {
      this.directories.add(directory);
    }
  }

  async quota(): Promise<MobileSafeRuntimeQuota> {
    return {
      usedBytes: await this.usedBytes(),
      fileCount: this.files.size,
      ...(typeof this.quotaBytes === "number"
        ? { quotaBytes: this.quotaBytes }
        : {}),
      ...(typeof this.maxFileBytes === "number"
        ? { maxFileBytes: this.maxFileBytes }
        : {}),
    };
  }

  private async usedBytes(): Promise<number> {
    let usedBytes = 0;
    for (const entry of this.files.values()) {
      usedBytes += entry.data.byteLength;
    }
    return usedBytes;
  }

  private ensureDirectoryPath(path: string): void {
    const normalized = normalizeMobileSafePath(path);
    if (normalized === "/") {
      this.directories.add("/");
      return;
    }
    const parts = normalized.slice(1).split("/");
    let current = "";
    for (const part of parts) {
      current = `${current}/${part}`;
      this.directories.add(current);
    }
  }
}

function diffFileMaps(
  before: Map<string, { data: Uint8Array; updatedAt: number }>,
  after: Map<string, { data: Uint8Array; updatedAt: number }>,
): MobileSafeRuntimeDiffEntry[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  const entries: MobileSafeRuntimeDiffEntry[] = [];
  for (const filePath of [...paths].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const beforeEntry = before.get(filePath);
    const afterEntry = after.get(filePath);
    if (!beforeEntry && afterEntry) {
      entries.push({
        path: filePath,
        status: "added",
        after: fileInfo(filePath, afterEntry),
      });
      continue;
    }
    if (beforeEntry && !afterEntry) {
      entries.push({
        path: filePath,
        status: "deleted",
        before: fileInfo(filePath, beforeEntry),
      });
      continue;
    }
    if (
      beforeEntry &&
      afterEntry &&
      !sameBytes(beforeEntry.data, afterEntry.data)
    ) {
      entries.push({
        path: filePath,
        status: "modified",
        before: fileInfo(filePath, beforeEntry),
        after: fileInfo(filePath, afterEntry),
      });
    }
  }
  return entries;
}

function fileInfo(
  path: string,
  entry: { data: Uint8Array; updatedAt: number },
): MobileSafeRuntimeFileInfo {
  return {
    path,
    kind: "file",
    size: entry.data.byteLength,
    updatedAt: entry.updatedAt,
  };
}

function toMobileSafeFileInfo(entry: {
  path: string;
  type?: "file" | "directory";
  kind?: "file" | "directory";
  size: number;
  mtimeMs?: number;
  updatedAt?: number;
}): MobileSafeRuntimeFileInfo {
  return {
    path: normalizeMobileSafePath(entry.path),
    kind: entry.kind ?? entry.type ?? "file",
    size: entry.size,
    updatedAt: entry.updatedAt ?? entry.mtimeMs,
  };
}

function toMobileSafeSnapshot(
  snapshot:
    | {
        id: string;
        createdAt?: string | number;
        note?: string;
        filesBytes: number;
        fileCount: number;
      }
    | undefined,
): MobileSafeRuntimeSnapshot {
  if (!snapshot) throw new Error("Wrapped VFS did not return a snapshot");
  const createdAt =
    typeof snapshot.createdAt === "string"
      ? Date.parse(snapshot.createdAt)
      : snapshot.createdAt;
  return {
    id: snapshot.id,
    createdAt: Number.isFinite(createdAt) ? Number(createdAt) : Date.now(),
    ...(snapshot.note ? { note: snapshot.note } : {}),
    filesBytes: snapshot.filesBytes,
    fileCount: snapshot.fileCount,
  };
}

function parseMobileSafeAppletManifest(raw: string): MobileSafeAppletManifest {
  const parsed = JSON.parse(raw) as MobileSafeAppletManifest;
  return normalizeMobileSafeAppletManifest(parsed);
}

function normalizeMobileSafeAppletManifest(
  manifest: MobileSafeAppletManifest,
): MobileSafeAppletManifest {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Mobile-safe applet manifest is required");
  }
  if (
    typeof manifest.id !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,96}$/.test(manifest.id)
  ) {
    throw new Error("Mobile-safe applet manifest id is invalid");
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("Mobile-safe applet manifest version is required");
  }
  if (
    typeof manifest.entrypoint !== "string" ||
    manifest.entrypoint.length === 0
  ) {
    throw new Error("Mobile-safe applet manifest entrypoint is required");
  }
  if (manifest.runtime && manifest.runtime !== "mobile-safe-js") {
    throw new Error("Only mobile-safe-js applet manifests are supported");
  }
  if (
    manifest.moduleFormat &&
    manifest.moduleFormat !== "javascript" &&
    manifest.moduleFormat !== "typescript"
  ) {
    throw new Error("Unsupported mobile-safe applet module format");
  }
  for (const permission of manifest.permissions ?? []) {
    if (permission === "shell.exec") {
      throw new Error("Mobile-safe applets cannot request shell.exec");
    }
  }
  return {
    ...manifest,
    runtime: manifest.runtime ?? "mobile-safe-js",
    moduleFormat: manifest.moduleFormat ?? "javascript",
    entrypoint: normalizeMobileSafePath(manifest.entrypoint),
    files: manifest.files?.map(normalizeMobileSafePath),
    permissions: [...(manifest.permissions ?? [])],
    env: { ...(manifest.env ?? {}) },
    ...(manifest.compiled
      ? {
          compiled: {
            bundlePath: normalizeMobileSafePath(manifest.compiled.bundlePath),
            compiledAt: manifest.compiled.compiledAt,
            sourceHash: manifest.compiled.sourceHash,
            files: manifest.compiled.files.map(normalizeMobileSafePath),
          },
        }
      : {}),
  };
}

function normalizeMobileSafeAppletFiles(
  manifest: MobileSafeAppletManifest,
  appRoot: string,
): string[] {
  const entrypoint = resolveMobileSafeAppletPath(appRoot, manifest.entrypoint);
  const paths = new Set<string>([entrypoint]);
  for (const filePath of manifest.files ?? []) {
    paths.add(resolveMobileSafeAppletPath(appRoot, filePath));
  }
  return [...paths].sort((left, right) => {
    if (left === entrypoint) return -1;
    if (right === entrypoint) return 1;
    return left.localeCompare(right);
  });
}

function resolveMobileSafeAppletPath(appRoot: string, path: string): string {
  const normalized = normalizeMobileSafePath(path);
  if (normalized === appRoot || normalized.startsWith(`${appRoot}/`)) {
    return normalized;
  }
  return normalizeMobileSafePath(`${appRoot}/${normalized.slice(1)}`);
}

function createMobileSafeAppletBundle(
  manifest: MobileSafeAppletManifest,
  modules: Array<{ path: string; source: string }>,
): string {
  const entrypoint = manifest.compiled?.files[0] ?? manifest.entrypoint;
  const module = modules.find((candidate) => candidate.path === entrypoint);
  if (!module) {
    throw new Error(`Applet entrypoint not found in bundle: ${entrypoint}`);
  }
  const transformedSource = transformMobileSafeAppletModule(module.source);
  return [
    "async function __mobileSafeApplet(input, api) {",
    `  const manifest = ${JSON.stringify(manifest)};`,
    "  const exports = {};",
    "  const module = { exports };",
    "  const console = api.console;",
    "  const crypto = api.crypto;",
    "  const env = api.env;",
    "  const fs = api.fs;",
    "  const applet = { manifest, input, api };",
    transformedSource
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
    "  const resolvedExports = module.exports === exports ? exports : module.exports;",
    "  const main = resolvedExports.default ?? resolvedExports.main ?? resolvedExports.run;",
    "  if (typeof main === 'function') return await main(input, api);",
    "  if (main !== undefined) return main;",
    "  return resolvedExports;",
    "}",
    "",
  ].join("\n");
}

function transformMobileSafeAppletModule(source: string): string {
  const exportedBindings: string[] = [];
  let output = source
    .replace(
      /\bexport\s+default\s+async\s+function\s+([A-Za-z_$][\w$]*)?\s*\(/g,
      (_match, name: string | undefined) =>
        `exports.default = async function${name ? ` ${name}` : ""}(`,
    )
    .replace(
      /\bexport\s+default\s+function\s+([A-Za-z_$][\w$]*)?\s*\(/g,
      (_match, name: string | undefined) =>
        `exports.default = function${name ? ` ${name}` : ""}(`,
    )
    .replace(/\bexport\s+default\s+/g, "exports.default = ")
    .replace(
      /\bexport\s+async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g,
      "exports.$1 = async function $1(",
    )
    .replace(
      /\bexport\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g,
      "exports.$1 = function $1(",
    );

  output = output.replace(
    /\bexport\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    (_match, declaration: string, name: string) => {
      exportedBindings.push(name);
      return `${declaration} ${name}`;
    },
  );

  if (exportedBindings.length > 0) {
    output += `\n${exportedBindings
      .map((name) => `exports.${name} = ${name};`)
      .join("\n")}`;
  }
  return output;
}

function assertMobileSafeAppletSource(source: string, label: string): void {
  const deniedPatterns: Array<[RegExp, string]> = [
    [/\bimport\s*\(/, "dynamic import"],
    [/^\s*import\s+/m, "static import"],
    [/\bexport\s+[^;\n]+from\s+["']/, "re-export"],
    [/\brequire\s*\(/, "CommonJS require"],
    [/\beval\s*\(/, "eval"],
    [/\bFunction\s*\(/, "Function constructor"],
    [/\bWebAssembly\b/, "WebAssembly"],
    [/\bprocess\b/, "process global"],
    [/\bBun\b/, "Bun global"],
    [/\bDeno\b/, "Deno global"],
    [/\bchild_process\b/, "child_process"],
    [/\bnode:/, "node: builtin import"],
    [/\bshell\b/i, "shell access"],
    [/\bconstructor\b/, "constructor escape"],
    [/\b__proto__\b/, "__proto__ escape"],
  ];
  for (const [pattern, reason] of deniedPatterns) {
    if (pattern.test(source)) {
      throw new Error(`Mobile-safe applet ${label} uses denied ${reason}`);
    }
  }
}

function stripMobileSafeTypeScript(source: string): string {
  return source
    .replace(/^\s*import\s+type\s+[^;]+;\s*$/gm, "")
    .replace(/^\s*export\s+type\s+[^;]+;\s*$/gm, "")
    .replace(/^\s*type\s+[A-Za-z_$][\w$]*\s*=\s*[^;]+;\s*$/gm, "")
    .replace(/^\s*interface\s+[A-Za-z_$][\w$]*\s*\{[^}]*\}\s*$/gm, "")
    .replace(
      /:\s*(?:\{[^{}]*\}|[A-Za-z_$][\w$]*(?:<[^;=(){}]+>)?(?:\[\])?)(?=\s*[,)=;{])/g,
      "",
    )
    .replace(/\s+as\s+const\b/g, "");
}

async function createSafeAppletApi(options: {
  files?: MobileSafeVirtualFileSystem;
  broker?: MobileSafeCapabilityBroker;
  env?: Record<string, string>;
  logs: string[];
  now?: () => number;
}): Promise<Record<string, unknown>> {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  return deepFreeze({
    env: Object.freeze({ ...(options.env ?? {}) }),
    now: options.now?.() ?? Date.now(),
    console: Object.freeze({
      log: (...values: unknown[]) => {
        options.logs.push(values.map(String).join(" "));
      },
      warn: (...values: unknown[]) => {
        options.logs.push(values.map(String).join(" "));
      },
      error: (...values: unknown[]) => {
        options.logs.push(values.map(String).join(" "));
      },
    }),
    crypto: Object.freeze({
      randomUUID: () => cryptoRequestId(),
    }),
    fs: Object.freeze({
      readText: async (path: string) => {
        if (!options.files) throw new Error("Applet VFS is unavailable");
        return textDecoder.decode(await options.files.readFile(path));
      },
      writeText: async (path: string, content: string) => {
        if (!options.files) throw new Error("Applet VFS is unavailable");
        await options.files.writeFile(path, textEncoder.encode(content));
      },
      list: async (path: string) => {
        if (!options.files) throw new Error("Applet VFS is unavailable");
        return options.files.list(path);
      },
      stat: async (path: string) => {
        if (!options.files) throw new Error("Applet VFS is unavailable");
        return options.files.stat(path);
      },
    }),
    broker: options.broker
      ? Object.freeze({
          call: async (request: MobileSafeRuntimeCapabilityRequest) => {
            if (request.capability === "shell.exec") {
              return unsupportedCapability(
                request,
                "Applet broker calls cannot request shell.exec",
              );
            }
            return options.broker?.call(request);
          },
        })
      : undefined,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      if (child && typeof child === "object" && !Object.isFrozen(child)) {
        deepFreeze(child);
      }
    }
  }
  return value;
}

function mobileSafeStableHash(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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

function resolveAndroidAvfMicrodroidStatus(
  platform: MobileSafeRuntimePlatform,
  probe: MobileSafeRuntimeFeatureProbe,
  env: Record<string, string | undefined>,
  globals: Record<string, unknown>,
): AndroidAvfMicrodroidRuntimeStatus {
  const virtualization = objectGlobal(globals.AndroidVirtualization);
  const explicitState =
    probe.androidAvfCapabilityState ??
    parseAndroidAvfCapabilityState(
      env.ELIZA_ANDROID_AVF_MICRODROID_STATE ??
        readStringGlobal(virtualization, "state"),
    );
  const capabilities = readStringArrayGlobal(virtualization, "capabilities");
  const reason = readStringGlobal(virtualization, "reason");

  if (platform !== "android") {
    return {
      state: "unsupported-platform",
      available: false,
      avfAvailable: false,
      microdroidAvailable: false,
      payloadAvailable: false,
      capabilities,
      reason:
        "Android AVF/Microdroid boundary is only available in supported Android app shells",
    };
  }

  const avfAvailable =
    probe.androidAvfAvailable === true ||
    env.ELIZA_ANDROID_AVF_AVAILABLE === "1" ||
    readBooleanGlobal(virtualization, "avfAvailable") === true ||
    readBooleanGlobal(virtualization, "frameworkAvailable") === true ||
    readBooleanGlobal(virtualization, "hasVirtualizationService") === true;
  const microdroidAvailable =
    probe.androidMicrodroidAvailable === true ||
    env.ELIZA_ANDROID_MICRODROID_AVAILABLE === "1" ||
    readBooleanGlobal(virtualization, "microdroidAvailable") === true;
  const payloadAvailable =
    probe.androidAvfPayloadAvailable === true ||
    env.ELIZA_ANDROID_MICRODROID_PAYLOAD_READY === "1" ||
    readBooleanGlobal(virtualization, "payloadAvailable") === true ||
    explicitState === "ready";
  const legacyAvailable =
    readBooleanGlobal(virtualization, "available") === true;
  const state =
    explicitState ??
    (payloadAvailable &&
    (avfAvailable || microdroidAvailable || legacyAvailable)
      ? "ready"
      : avfAvailable || microdroidAvailable || legacyAvailable
        ? "payload-missing"
        : "framework-unavailable");

  return {
    state,
    available: state === "ready" && payloadAvailable,
    avfAvailable:
      avfAvailable ||
      microdroidAvailable ||
      legacyAvailable ||
      state === "ready" ||
      state === "payload-missing",
    microdroidAvailable:
      microdroidAvailable || legacyAvailable || state === "ready",
    payloadAvailable,
    capabilities,
    reason: reason ?? androidAvfMicrodroidReason(state),
  };
}

function parseAndroidAvfCapabilityState(
  value: string | undefined,
): AndroidAvfMicrodroidCapabilityState | undefined {
  switch (value) {
    case "unsupported-platform":
    case "unsupported-api":
    case "framework-unavailable":
    case "permission-denied":
    case "service-unavailable":
    case "payload-missing":
    case "ready":
      return value;
    default:
      return undefined;
  }
}

function androidAvfMicrodroidReason(
  state: AndroidAvfMicrodroidCapabilityState,
): string {
  switch (state) {
    case "ready":
      return "Android AVF/Microdroid payload boundary is ready";
    case "unsupported-platform":
      return "Android AVF/Microdroid boundary is only available in supported Android app shells";
    case "unsupported-api":
      return "Android AVF/Microdroid requires API 34+";
    case "framework-unavailable":
      return "Device image does not expose Android AVF/Microdroid virtualization framework";
    case "permission-denied":
      return "MANAGE_VIRTUAL_MACHINE is not declared or granted";
    case "service-unavailable":
      return "VirtualMachineManager service unavailable";
    case "payload-missing":
      return "Android AVF/Microdroid framework is present, but no Microdroid payload boundary is packaged for this build";
  }
}

function objectGlobal(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function displayNameForProvider(kind: MobileSafeRuntimeProviderKind): string {
  switch (kind) {
    case "android-avf-microdroid":
      return "Android AVF/Microdroid";
    case "android-isolated-process":
      return "Android isolated process";
    case "safe-js-applet":
      return "In-process safe JS applet";
    case "javascriptcore":
      return "iOS JavaScriptCore";
    case "quickjs":
      return "iOS QuickJS";
    case "wasm":
      return "WebAssembly";
    default:
      return kind;
  }
}

function defaultProviderOrderForPlatform(
  platform: MobileSafeRuntimePlatform,
): MobileSafeRuntimeProviderKind[] {
  switch (platform) {
    case "android":
      return [
        "android-avf-microdroid",
        "android-isolated-process",
        "safe-js-applet",
        "wasm",
      ];
    case "ios":
      return ["quickjs", "javascriptcore", "safe-js-applet", "wasm"];
    case "web":
      return ["safe-js-applet", "wasm"];
    default:
      return ["safe-js-applet", "wasm"];
  }
}

function capabilityForExecuteMode(
  mode: MobileSafeRuntimeExecuteInput["mode"],
): MobileSafeRuntimeCapability {
  switch (mode) {
    case "shell":
      return "shell.exec";
    case "compile-app":
      return "app.compile";
    case "load-app":
      return "app.load";
    case "run-app":
      return "app.run";
    case "evaluate":
    case undefined:
      return "model.inference";
    default:
      return mode;
  }
}

function unsupportedCapability(
  request: MobileSafeRuntimeCapabilityRequest,
  message: string,
): MobileSafeRuntimeCapabilityResponse {
  return {
    id: request.id,
    ok: false,
    error: {
      code: "MOBILE_SAFE_UNSUPPORTED_CAPABILITY",
      message,
      retryable: false,
    },
  };
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

function readBooleanGlobal(value: unknown, key: string): boolean | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "boolean" ? raw : undefined;
}

function readStringGlobal(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function readStringArrayGlobal(value: unknown, key: string): string[] {
  if (value === null || typeof value !== "object") return [];
  const raw = (value as Record<string, unknown>)[key];
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : [];
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
