import { describe, expect, it } from "vitest";
import {
  createAndroidIsolatedProcessHook,
  createAndroidIsolatedProcessProvider,
  createIosJavaScriptCoreProvider,
  createMobileSafeCapabilityBroker,
  detectMobileSafeRuntimeFeatures,
  MemoryMobileSafeVirtualFileSystem,
  normalizeMobileSafePath,
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
    expect(features.availableProviders).not.toContain("wasm");
    expect(features.unavailableProviders.wasm).toMatch(/WebAssembly/);
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
  it("normalizes virtual file-system paths inside the runtime root", () => {
    expect(normalizeMobileSafePath("/tmp/../agent/./state.json")).toBe(
      "/agent/state.json",
    );
    expect(normalizeMobileSafePath("../../escape.txt")).toBe("/escape.txt");
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
});
