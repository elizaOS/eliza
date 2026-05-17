import { describe, expect, it } from "vitest";
import {
  createAndroidAvfMicrodroidProvider,
  createAndroidIsolatedProcessHook,
  createAndroidIsolatedProcessProvider,
  createIosJavaScriptCoreProvider,
  createMobileSafeCapabilityBroker,
  createMobileSafeVirtualFileSystemAdapter,
  createMobileSafeVirtualFileSystemBroker,
  detectMobileSafeRuntimeFeatures,
  MemoryMobileSafeVirtualFileSystem,
  normalizeMobileSafePath,
  selectMobileSafeRuntimeProvider,
} from "./mobile-safe-runtime";

describe("detectMobileSafeRuntimeFeatures", () => {
  it("detects attached iOS JavaScriptCore and QuickJS hooks without claiming Bun or Node", () => {
    const features = detectMobileSafeRuntimeFeatures({
      platform: "ios",
      iosJavaScriptCoreAvailable: true,
      iosQuickJsAvailable: true,
      globals: { WebAssembly: {}, SharedArrayBuffer: undefined },
    });

    expect(features.platform).toBe("ios");
    expect(features.availableProviders).toContain("javascriptcore");
    expect(features.availableProviders).toContain("quickjs");
    expect(features.availableProviders).toContain("wasm");
    expect(features.hasNodeRuntime).toBe(false);
    expect(features.hasBunRuntime).toBe(false);
  });

  it("does not advertise iOS JS runtime boundaries until a native bridge is attached", () => {
    const features = detectMobileSafeRuntimeFeatures({
      platform: "ios",
      globals: { WebAssembly: {} },
    });

    expect(features.availableProviders).not.toContain("javascriptcore");
    expect(features.availableProviders).not.toContain("quickjs");
    expect(features.unavailableProviders.javascriptcore).toMatch(
      /not attached/,
    );
    expect(features.unavailableProviders.quickjs).toMatch(/not attached/);
  });

  it("does not advertise Android isolated-process without an attached shell boundary", () => {
    const features = detectMobileSafeRuntimeFeatures({
      env: { ELIZA_PLATFORM: "android" },
      globals: {},
    });

    expect(features.platform).toBe("android");
    expect(features.availableProviders).not.toContain(
      "android-isolated-process",
    );
    expect(features.availableProviders).not.toContain("android-avf-microdroid");
    expect(features.unavailableProviders["android-isolated-process"]).toMatch(
      /not attached/,
    );
    expect(features.unavailableProviders["android-avf-microdroid"]).toMatch(
      /virtualization framework/i,
    );
    expect(features.androidAvfMicrodroid).toMatchObject({
      state: "framework-unavailable",
      available: false,
      payloadAvailable: false,
    });
    expect(features.availableProviders).not.toContain("wasm");
    expect(features.unavailableProviders.wasm).toMatch(/WebAssembly/);
  });

  it("does not advertise Android AVF/Microdroid from framework availability alone", () => {
    const features = detectMobileSafeRuntimeFeatures({
      env: { ELIZA_PLATFORM: "android", ELIZA_ANDROID_AVF_AVAILABLE: "1" },
      globals: { WebAssembly: {} },
    });

    expect(features.availableProviders).toEqual(["wasm"]);
    expect(features.androidAvfMicrodroid).toMatchObject({
      state: "payload-missing",
      available: false,
      avfAvailable: true,
      payloadAvailable: false,
    });
    expect(features.unavailableProviders["android-avf-microdroid"]).toMatch(
      /payload/,
    );
  });

  it("advertises Android AVF/Microdroid only when the Microdroid payload is ready", () => {
    const features = detectMobileSafeRuntimeFeatures({
      env: {
        ELIZA_PLATFORM: "android",
        ELIZA_ANDROID_AVF_AVAILABLE: "1",
        ELIZA_ANDROID_MICRODROID_AVAILABLE: "1",
        ELIZA_ANDROID_MICRODROID_PAYLOAD_READY: "1",
        ELIZA_ANDROID_AVF_MICRODROID_STATE: "ready",
      },
      globals: { WebAssembly: {} },
    });

    expect(features.availableProviders).toEqual([
      "android-avf-microdroid",
      "wasm",
    ]);
    expect(features.androidAvfMicrodroid).toMatchObject({
      state: "ready",
      available: true,
      avfAvailable: true,
      microdroidAvailable: true,
      payloadAvailable: true,
    });
  });

  it("detects Android isolated-process only when the shell reports it", () => {
    const features = detectMobileSafeRuntimeFeatures({
      env: {
        ELIZA_PLATFORM: "android",
        ELIZA_ANDROID_ISOLATED_PROCESS_AVAILABLE: "1",
      },
      globals: {},
    });

    expect(features.availableProviders).toContain("android-isolated-process");
  });

  it("detects the dev-only safe-js applet fallback when explicitly enabled", () => {
    const features = detectMobileSafeRuntimeFeatures({
      platform: "ios",
      allowInProcessSafeJsApplet: true,
      globals: { Function, WebAssembly: {} },
    });

    expect(features.availableProviders).toContain("safe-js-applet");
  });

  it("does not advertise safe-js applets by default because they are not a hard sandbox", () => {
    const features = detectMobileSafeRuntimeFeatures({
      platform: "ios",
      globals: { Function, WebAssembly: {} },
    });

    expect(features.availableProviders).not.toContain("safe-js-applet");
    expect(features.unavailableProviders["safe-js-applet"]).toMatch(/dev-only/);
  });

  it("falls back gracefully for unknown hosts", () => {
    const features = detectMobileSafeRuntimeFeatures({ globals: {} });

    expect(features.platform).toBe("unknown");
    expect(features.availableProviders).toEqual([]);
    expect(features.unavailableProviders.javascriptcore).toMatch(/iOS/);
    expect(features.unavailableProviders["android-isolated-process"]).toMatch(
      /Android/,
    );
  });
});

describe("mobile safe runtime contracts", () => {
  it("normalizes virtual file-system paths and rejects traversal", () => {
    expect(normalizeMobileSafePath("/agent/./state.json")).toBe(
      "/agent/state.json",
    );
    expect(() => normalizeMobileSafePath("/tmp/../agent/state.json")).toThrow(
      /traversal/,
    );
    expect(() => normalizeMobileSafePath("../../escape.txt")).toThrow(
      /traversal/,
    );
  });

  it("exposes a virtual file-system contract with defensive copies", async () => {
    const fs = new MemoryMobileSafeVirtualFileSystem();
    const bytes = new Uint8Array([1, 2, 3]);

    await fs.writeFile("/agent/state.bin", bytes);
    bytes[0] = 9;

    await expect(fs.readFile("/agent/state.bin")).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await expect(fs.stat("/agent/state.bin")).resolves.toMatchObject({
      kind: "file",
      path: "/agent/state.bin",
      size: 3,
    });
    await expect(fs.list("/agent")).resolves.toHaveLength(1);
    await expect(fs.stat("/agent")).resolves.toMatchObject({
      kind: "directory",
      path: "/agent",
    });
  });

  it("tracks nested in-memory VFS directories and deletes subtrees", async () => {
    const fs = new MemoryMobileSafeVirtualFileSystem();

    await fs.writeFile(
      "/apps/demo/src/index.js",
      new TextEncoder().encode("ok"),
    );
    await expect(fs.stat("/apps")).resolves.toMatchObject({
      kind: "directory",
      path: "/apps",
    });
    await expect(fs.stat("/apps/demo/src")).resolves.toMatchObject({
      kind: "directory",
      path: "/apps/demo/src",
    });

    await fs.delete("/apps/demo");
    await expect(fs.stat("/apps")).resolves.toMatchObject({
      kind: "directory",
      path: "/apps",
    });
    await expect(fs.stat("/apps/demo")).resolves.toBeNull();
    await expect(fs.readFile("/apps/demo/src/index.js")).rejects.toThrow(
      /not found/i,
    );
  });

  it("supports VFS snapshots, diffs, rollback, and brokered file operations", async () => {
    const fs = new MemoryMobileSafeVirtualFileSystem();
    const broker = createMobileSafeVirtualFileSystemBroker(fs);

    await broker.call({
      id: "write-1",
      capability: "fs.write",
      operation: "writeFile",
      args: { path: "/app/index.js", content: "export default 1;" },
    });
    const snapshot = await fs.createSnapshot("before edit");

    await broker.call({
      id: "write-2",
      capability: "fs.write",
      operation: "writeFile",
      args: { path: "/app/index.js", content: "export default 2;" },
    });

    await expect(fs.diffCurrent(snapshot.id)).resolves.toMatchObject([
      { path: "/app/index.js", status: "modified" },
    ]);
    await expect(
      broker.call({
        id: "quota-1",
        capability: "fs.quota",
        operation: "quota",
        args: {},
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { usedBytes: 17, fileCount: 1 },
    });
    await fs.rollback(snapshot.id);
    await expect(fs.readFile("/app/index.js")).resolves.toEqual(
      new TextEncoder().encode("export default 1;"),
    );
  });

  it("enforces in-memory mobile-safe VFS quotas", async () => {
    const fs = new MemoryMobileSafeVirtualFileSystem({
      quotaBytes: 8,
      maxFileBytes: 5,
    });

    await expect(
      fs.writeFile("/large.txt", new TextEncoder().encode("123456")),
    ).rejects.toThrow(/max file size/);

    await fs.writeFile("/a.txt", new TextEncoder().encode("1234"));
    await fs.writeFile("/b.txt", new TextEncoder().encode("1234"));
    await expect(
      fs.writeFile("/c.txt", new TextEncoder().encode("1")),
    ).rejects.toThrow(/quota exceeded/i);

    await expect(fs.quota()).resolves.toMatchObject({
      usedBytes: 8,
      fileCount: 2,
      quotaBytes: 8,
      maxFileBytes: 5,
    });
  });

  it("adapts the agent VFS shape into the mobile-safe VFS contract", async () => {
    const files = new Map<string, Uint8Array>();
    const adapter = createMobileSafeVirtualFileSystemAdapter({
      async readFileBytes(path) {
        const value = files.get(normalizeMobileSafePath(path));
        if (!value) throw new Error("missing");
        return value;
      },
      async writeFile(path, data) {
        files.set(
          normalizeMobileSafePath(path),
          typeof data === "string" ? new TextEncoder().encode(data) : data,
        );
      },
      async list() {
        return [...files.entries()].map(([path, data]) => ({
          path,
          type: "file" as const,
          size: data.byteLength,
        }));
      },
      async quota() {
        return { usedBytes: 2, fileCount: 1, quotaBytes: 1024 };
      },
    });

    await adapter.writeFile("/plugin.ts", new TextEncoder().encode("ok"));
    await expect(adapter.readFile("/plugin.ts")).resolves.toEqual(
      new TextEncoder().encode("ok"),
    );
    await expect(adapter.list("/")).resolves.toMatchObject([
      { path: "/plugin.ts", kind: "file", size: 2 },
    ]);
    await expect(adapter.quota?.()).resolves.toMatchObject({
      usedBytes: 2,
      fileCount: 1,
      quotaBytes: 1024,
    });
  });

  it("wraps capability broker failures in the stable response shape", async () => {
    const broker = createMobileSafeCapabilityBroker(() => {
      throw new Error("denied");
    });

    await expect(
      broker.call({
        id: "request-1",
        capability: "fs.read",
        operation: "readFile",
        args: { path: "/agent/state.json" },
      }),
    ).resolves.toEqual({
      id: "request-1",
      ok: false,
      error: {
        code: "MOBILE_SAFE_CAPABILITY_FAILED",
        message: "denied",
        retryable: false,
      },
    });
  });

  it("returns unavailable iOS providers as explicit placeholders", async () => {
    const provider = createIosJavaScriptCoreProvider();

    expect(provider.supported).toBe(false);
    await expect(provider.execute({ code: "1 + 1" })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "MOBILE_SAFE_RUNTIME_PROVIDER_UNAVAILABLE",
        provider: "javascriptcore",
      },
    });
  });

  it("defines Android isolated-process defaults without invoking desktop shell APIs", () => {
    expect(createAndroidIsolatedProcessHook()).toEqual({
      serviceName: "ai.elizaos.app.MobileSafeRuntimeService",
      intentAction: "ai.elizaos.app.action.MOBILE_SAFE_RUNTIME",
      binderInterface: "ai.elizaos.app.IMobileSafeRuntime",
      requiredPermission: "ai.elizaos.app.permission.MOBILE_SAFE_RUNTIME",
      processName: ":eliza_mobile_safe_runtime",
    });
  });

  it("adapts Android isolated-process boundary responses to execute results", async () => {
    const capabilities: string[] = [];
    const provider = createAndroidIsolatedProcessProvider({
      kind: "android-isolated-process",
      serviceName: "test",
      async request(request) {
        capabilities.push(request.capability);
        return {
          id: request.id,
          ok: true,
          result: {
            capability: request.capability,
            entrypoint: request.args.entrypoint,
          },
        };
      },
    });

    await expect(
      provider.execute({ code: "export default {}", entrypoint: "main" }),
    ).resolves.toEqual({
      ok: true,
      value: { capability: "model.inference", entrypoint: "main" },
    });
    await expect(
      provider.execute({ code: "{}", mode: "compile-app" }),
    ).resolves.toMatchObject({
      ok: true,
      value: { capability: "app.compile" },
    });
    await expect(
      provider.execute({ code: "{}", mode: "run-app" }),
    ).resolves.toMatchObject({
      ok: true,
      value: { capability: "app.run" },
    });
    await expect(
      provider.execute({ code: "echo no", mode: "shell" }),
    ).resolves.toMatchObject({
      ok: true,
      value: { capability: "shell.exec" },
    });
    expect(capabilities).toEqual([
      "model.inference",
      "app.compile",
      "app.run",
      "shell.exec",
    ]);
  });

  it("returns an unavailable Android AVF provider when the probe state is payload-missing", async () => {
    const provider = createAndroidAvfMicrodroidProvider({
      kind: "android-avf-microdroid",
      capabilityState: "payload-missing",
      reason: "no packaged Microdroid payload",
      async request(request) {
        return { id: request.id, ok: true, result: { provider: "avf" } };
      },
    });

    expect(provider.supported).toBe(false);
    await expect(
      provider.execute({ code: "export default {}", mode: "run-app" }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "MOBILE_SAFE_RUNTIME_PROVIDER_UNAVAILABLE",
        provider: "android-avf-microdroid",
        message: "no packaged Microdroid payload",
      },
    });
  });

  it("sends the AVF execution request contract with VFS transport metadata", async () => {
    const fs = new MemoryMobileSafeVirtualFileSystem();
    const broker = createMobileSafeVirtualFileSystemBroker(fs);
    const provider = createAndroidAvfMicrodroidProvider({
      kind: "android-avf-microdroid",
      capabilityState: "ready",
      async request(request) {
        return {
          id: request.id,
          ok: true,
          result: {
            capability: request.capability,
            mode: request.args.mode,
            virtualFileSystem: request.args.virtualFileSystem,
          },
        };
      },
    });

    await expect(
      provider.execute({
        code: "export default {}",
        mode: "run-app",
        files: fs,
        broker,
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        capability: "app.run",
        mode: "run-app",
        virtualFileSystem: {
          attached: true,
          transport: "mobile-safe-capability-broker",
        },
      },
    });
  });

  it("selects AVF before isolated-process, and isolated-process as fallback", async () => {
    const avf = createAndroidAvfMicrodroidProvider({
      kind: "android-avf-microdroid",
      async request(request) {
        return { id: request.id, ok: true, result: { provider: "avf" } };
      },
    });
    const isolated = createAndroidIsolatedProcessProvider({
      kind: "android-isolated-process",
      serviceName: "test",
      async request(request) {
        return { id: request.id, ok: true, result: { provider: "isolated" } };
      },
    });

    const withAvf = selectMobileSafeRuntimeProvider({
      features: detectMobileSafeRuntimeFeatures({
        env: {
          ELIZA_PLATFORM: "android",
          ELIZA_ANDROID_AVF_AVAILABLE: "1",
          ELIZA_ANDROID_MICRODROID_AVAILABLE: "1",
          ELIZA_ANDROID_MICRODROID_PAYLOAD_READY: "1",
          ELIZA_ANDROID_AVF_MICRODROID_STATE: "ready",
        },
        globals: {},
      }),
      providers: {
        "android-avf-microdroid": avf,
        "android-isolated-process": isolated,
      },
    });
    expect(withAvf.kind).toBe("android-avf-microdroid");

    const fallback = selectMobileSafeRuntimeProvider({
      features: detectMobileSafeRuntimeFeatures({
        env: { ELIZA_PLATFORM: "android" },
        androidIsolatedProcessAvailable: true,
        globals: {},
      }),
      providers: {
        "android-avf-microdroid": avf,
        "android-isolated-process": isolated,
      },
    });
    expect(fallback.kind).toBe("android-isolated-process");
  });

  it("falls back past AVF when AVF exists but the Microdroid payload is absent", () => {
    const avf = createAndroidAvfMicrodroidProvider({
      kind: "android-avf-microdroid",
      capabilityState: "payload-missing",
      async request(request) {
        return { id: request.id, ok: true, result: { provider: "avf" } };
      },
    });
    const isolated = createAndroidIsolatedProcessProvider({
      kind: "android-isolated-process",
      serviceName: "test",
      async request(request) {
        return { id: request.id, ok: true, result: { provider: "isolated" } };
      },
    });

    const selected = selectMobileSafeRuntimeProvider({
      features: detectMobileSafeRuntimeFeatures({
        env: {
          ELIZA_PLATFORM: "android",
          ELIZA_ANDROID_AVF_AVAILABLE: "1",
          ELIZA_ANDROID_MICRODROID_AVAILABLE: "1",
        },
        androidIsolatedProcessAvailable: true,
        globals: {},
      }),
      providers: {
        "android-avf-microdroid": avf,
        "android-isolated-process": isolated,
      },
    });

    expect(selected.kind).toBe("android-isolated-process");
  });
});
