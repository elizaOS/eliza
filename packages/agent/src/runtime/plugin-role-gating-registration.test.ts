import type { Plugin, Provider } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createTestRuntime } from "../__tests__/plugin-lifecycle-test-utils.ts";
import { installRuntimePluginLifecycle } from "./plugin-lifecycle.ts";

/**
 * #12087 Item 1: sensitive-provider role gating must be applied when a plugin
 * REGISTERS (via the plugin-lifecycle registerPlugin wrapper), not only in the
 * one-shot boot pass. Otherwise a plugin hot-installed after boot (plugin
 * manager / VFS) went through registerPlugin but never the boot gating pass, so
 * its owner/admin-tier providers (SECRETS_STATUS, walletPortfolio, shellHistory)
 * stayed exposed to any sender. The `__roleGate` marker proves gateProvider
 * wrapped the provider at registration.
 */
function pluginWith(providers: Provider[], name = "hot-installed"): Plugin {
  return { name, description: "hot plugin", providers };
}

describe("provider role gating on post-boot plugin registration (#12087 Item 1)", () => {
  it("gates an admin-tier provider when its plugin registers via runtime.registerPlugin", async () => {
    const runtime = createTestRuntime();
    installRuntimePluginLifecycle(runtime);

    const secrets = {
      name: "SECRETS_STATUS",
      description: "secrets",
      get: async () => ({ text: "SENSITIVE" }),
    } as Provider;
    await runtime.registerPlugin(pluginWith([secrets], "hot-secrets"));

    expect((secrets as { __roleGate?: string }).__roleGate).toBe("admin");
  });

  it("gates an owner-tier provider (walletPortfolio) on registration", async () => {
    const runtime = createTestRuntime();
    installRuntimePluginLifecycle(runtime);

    const wallet = {
      name: "walletPortfolio",
      description: "wallet",
      get: async () => ({ text: "0x…balance" }),
    } as Provider;
    await runtime.registerPlugin(pluginWith([wallet], "hot-wallet"));

    expect((wallet as { __roleGate?: string }).__roleGate).toBe("owner");
  });

  it("leaves a non-sensitive provider un-wrapped", async () => {
    const runtime = createTestRuntime();
    installRuntimePluginLifecycle(runtime);

    const plain = {
      name: "SOME_PUBLIC_PROVIDER",
      description: "public",
      get: async () => ({ text: "public" }),
    } as Provider;
    await runtime.registerPlugin(pluginWith([plain], "public-plugin"));

    expect((plain as { __roleGate?: string }).__roleGate).toBeUndefined();
  });
});
