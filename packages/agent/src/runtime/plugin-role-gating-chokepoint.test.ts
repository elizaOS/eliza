/**
 * P0 regression: provider role redaction must be enforced at a SINGLE runtime
 * chokepoint (runtime.registerPlugin), not as a one-shot boot pass. A plugin
 * registered AFTER boot via the runtime API (the hot-install / hot-reload path
 * in packages/agent/src/api/plugin-runtime-apply.ts) must have its sensitive
 * providers redacted identically to boot-registered plugins.
 *
 * The fix wraps runtime.registerPlugin via installProviderRoleGatingChokepoint
 * so that EVERY registration calls `applyPluginRoleGating([plugin])` — boot
 * constructor plugins, deferred waves, AND post-boot hot-installs. This suite
 * installs that wrapper on a minimal runtime and drives runtime.registerPlugin
 * directly, proving:
 *   1. A plugin gated at boot and a plugin gated post-boot are redacted
 *      identically.
 *   2. Gating failure fails CLOSED: a sensitive provider that cannot be wrapped
 *      is withheld from EVERY caller (even OWNER) and reported at ERROR — never
 *      silently exposed.
 */
import type {
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rolesMock = vi.hoisted(() => ({
  checkSenderRole: vi.fn(),
}));

vi.mock("./roles.ts", () => rolesMock);

import { installProviderRoleGatingChokepoint } from "./plugin-role-gating.ts";

let runtime: IAgentRuntime & {
  plugins: Plugin[];
  registerPlugin(plugin: Plugin): Promise<void>;
};

function makeRuntime() {
  const plugins: Plugin[] = [];
  const nextRuntime = {
    agentId: "11111111-1111-1111-1111-111111111111",
    plugins,
    registerPlugin: vi.fn(async (plugin: Plugin) => {
      plugins.push(plugin);
    }),
  } as unknown as IAgentRuntime & {
    plugins: Plugin[];
    registerPlugin(plugin: Plugin): Promise<void>;
  };
  installProviderRoleGatingChokepoint(nextRuntime);
  return nextRuntime;
}

async function registerViaChokepoint(plugin: Plugin): Promise<void> {
  await runtime.registerPlugin(plugin);
}

function message(metadata: Record<string, unknown> = {}): Memory {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    entityId: "33333333-3333-3333-3333-333333333333",
    roomId: "44444444-4444-4444-4444-444444444444",
    content: { text: "hi", source: "discord" },
    metadata,
  } as Memory;
}

function provider(name: string, minRole?: string): Provider {
  return {
    name,
    ...(minRole ? { roleGate: { minRole } } : {}),
    get: vi.fn(async () => ({ text: `${name}: visible` })),
  } as unknown as Provider;
}

function pluginWithProviders(name: string, providers: Provider[]): Plugin {
  return { name, providers } as Plugin;
}

async function callGet(
  gated: Provider,
  role: string,
): Promise<string | undefined> {
  rolesMock.checkSenderRole.mockResolvedValue({
    role,
    isOwner: role === "OWNER",
    isAdmin: role === "OWNER" || role === "ADMIN",
  });
  const result = await gated.get?.(
    runtime,
    message({ fromId: "discord-user-1" }),
    {} as State,
  );
  return result?.text;
}

describe("registerPlugin chokepoint gates post-boot plugins", () => {
  beforeEach(() => {
    rolesMock.checkSenderRole.mockReset();
    runtime = makeRuntime();
  });

  it("gates a plugin registered AFTER boot identically to a boot-registered one", async () => {
    // "boot" plugin — registered during the initial gating pass.
    const bootProvider = provider("SECRETS_STATUS", "ADMIN"); // admin-gated
    await registerViaChokepoint(
      pluginWithProviders("boot-plugin", [bootProvider]),
    );

    // "post-boot" plugin — the exact hot-install path: a later
    // runtime.registerPlugin with an owner-gated provider. Before the chokepoint
    // this plugin bypassed gating entirely and leaked owner-tier context to
    // everyone.
    const hotProvider = provider("wallet", "OWNER"); // owner-gated
    await registerViaChokepoint(
      pluginWithProviders("hot-wallet-plugin", [hotProvider]),
    );

    expect(runtime.plugins.map((plugin) => plugin.name)).toEqual([
      "boot-plugin",
      "hot-wallet-plugin",
    ]);

    // Boot-registered admin provider: redacted below ADMIN, visible at/above.
    expect(await callGet(bootProvider, "GUEST")).toBe("");
    expect(await callGet(bootProvider, "USER")).toBe("");
    expect(await callGet(bootProvider, "ADMIN")).toBe(
      "SECRETS_STATUS: visible",
    );

    // Post-boot owner provider: redacted for everyone below OWNER, visible for
    // OWNER — identical enforcement to the boot-registered provider.
    expect(await callGet(hotProvider, "GUEST")).toBe("");
    expect(await callGet(hotProvider, "USER")).toBe("");
    expect(await callGet(hotProvider, "ADMIN")).toBe("");
    expect(await callGet(hotProvider, "OWNER")).toBe("wallet: visible");
  });

  it("leaves non-sensitive providers untouched", async () => {
    const plain = provider("someHarmlessProvider");
    await registerViaChokepoint(pluginWithProviders("plain-plugin", [plain]));
    expect(await callGet(plain, "GUEST")).toBe("someHarmlessProvider: visible");
  });

  it("fails CLOSED: a sensitive provider that cannot be wrapped is withheld from everyone", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    // A sensitive provider whose `get` is a read-only data property, so
    // the wrap path.s reassignment throws. The fail-closed path must withhold it
    // rather than register it exposed.
    const original = vi.fn(
      async (): Promise<ProviderResult> => ({ text: "wallet: leak" }),
    );
    const locked = {
      name: "wallet",
      roleGate: { minRole: "OWNER" },
    } as unknown as Provider;
    Object.defineProperty(locked, "get", {
      value: original,
      writable: false,
      configurable: true,
      enumerable: true,
    });

    await registerViaChokepoint(pluginWithProviders("locked-plugin", [locked]));

    // Even an OWNER must NOT see the content — proves it was withheld, not merely
    // gated (a normally-gated owner provider is visible to OWNER).
    expect(await callGet(locked, "OWNER")).toBe("");
    // ...and the failure was reported loudly (ERROR), not silently dropped.
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
