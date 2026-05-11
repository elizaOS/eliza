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
  it("detects iOS JavaScriptCore and QuickJS hooks without claiming Bun or Node", () => {
    const features = detectMobileSafeRuntimeFeatures({
      platform: "ios",
      globals: { WebAssembly: {}, SharedArrayBuffer: undefined },
    });

    expect(features.platform).toBe("ios");
    expect(features.availableProviders).toContain("javascriptcore");
    expect(features.availableProviders).toContain("quickjs");
    expect(features.availableProviders).toContain("wasm");
    expect(features.hasNodeRuntime).toBe(false);
    expect(features.hasBunRuntime).toBe(false);
  });

  it("detects Android isolated-process hook availability", () => {
    const features = detectMobileSafeRuntimeFeatures({
      env: { ELIZA_PLATFORM: "android" },
      globals: {},
    });

    expect(features.platform).toBe("android");
    expect(features.availableProviders).toContain("android-isolated-process");
    expect(features.availableProviders).not.toContain("android-avf-microdroid");
    expect(features.unavailableProviders["android-avf-microdroid"]).toMatch(
      /AVF\/Microdroid/,
    );
    expect(features.availableProviders).not.toContain("wasm");
    expect(features.unavailableProviders.wasm).toMatch(/WebAssembly/);
  });

  it("prefers Android AVF/Microdroid when the platform reports support", () => {
    const features = detectMobileSafeRuntimeFeatures({
      env: { ELIZA_PLATFORM: "android", ELIZA_ANDROID_AVF_AVAILABLE: "1" },
      globals: { WebAssembly: {} },
    });

    expect(features.availableProviders).toEqual([
      "android-avf-microdroid",
      "android-isolated-process",
      "wasm",
    ]);
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

    await fs.mkdir("/agent");
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
    const provider = createAndroidIsolatedProcessProvider({
      kind: "android-isolated-process",
      serviceName: "test",
      async request(request) {
        return {
          id: request.id,
          ok: true,
          result: { entrypoint: request.args.entrypoint },
        };
      },
    });

    await expect(
      provider.execute({ code: "export default {}", entrypoint: "main" }),
    ).resolves.toEqual({
      ok: true,
      value: { entrypoint: "main" },
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
        env: { ELIZA_PLATFORM: "android", ELIZA_ANDROID_AVF_AVAILABLE: "1" },
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
        globals: {},
      }),
      providers: {
        "android-avf-microdroid": avf,
        "android-isolated-process": isolated,
      },
    });
    expect(fallback.kind).toBe("android-isolated-process");
  });
});
