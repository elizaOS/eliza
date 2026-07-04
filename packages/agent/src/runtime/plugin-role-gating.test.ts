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

import { applyPluginRoleGating } from "./plugin-role-gating.ts";

const runtime = {
  agentId: "11111111-1111-1111-1111-111111111111",
} as IAgentRuntime;

function message(metadata: Record<string, unknown> = {}): Memory {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    entityId: "33333333-3333-3333-3333-333333333333",
    roomId: "44444444-4444-4444-4444-444444444444",
    content: { text: "hi", source: "discord" },
    metadata,
  } as Memory;
}

/** A sensitive provider that declares its own gate — the only thing that gates. */
function gatedProvider(name: string, minRole: string): Provider {
  return {
    name,
    roleGate: { minRole },
    get: vi.fn(async () => ({ text: `${name}: visible` })),
  } as unknown as Provider;
}

/** A provider with NO declared gate — must stay public. */
function plainProvider(name: string): Provider {
  return {
    name,
    get: vi.fn(async () => ({ text: `${name}: visible` })),
  } as unknown as Provider;
}

function pluginWithProviders(providers: Provider[]): Plugin {
  return {
    name: "test-plugin",
    providers,
  } as Plugin;
}

describe("applyPluginRoleGating — in-flight role-check dedup", () => {
  beforeEach(() => {
    rolesMock.checkSenderRole.mockReset();
  });

  it("deduplicates concurrent provider role checks for the same message", async () => {
    rolesMock.checkSenderRole.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ role: "ADMIN", isOwner: false, isAdmin: true });
          }, 10);
        }),
    );
    const providers = [
      gatedProvider("SECRETS_STATUS", "ADMIN"),
      gatedProvider("MISSING_SECRETS", "ADMIN"),
    ];
    applyPluginRoleGating([pluginWithProviders(providers)]);

    const results = await Promise.all(
      providers.map((item) =>
        item.get?.(runtime, message({ fromId: "discord-user-1" }), {} as State),
      ),
    );

    expect(rolesMock.checkSenderRole).toHaveBeenCalledTimes(1);
    expect(results.map((item) => item?.text)).toEqual([
      "SECRETS_STATUS: visible",
      "MISSING_SECRETS: visible",
    ]);
  });

  it("does not reuse a resolved role decision across later turns", async () => {
    rolesMock.checkSenderRole
      .mockResolvedValueOnce({ role: "ADMIN", isOwner: false, isAdmin: true })
      .mockResolvedValueOnce({ role: "GUEST", isOwner: false, isAdmin: false });
    const provider = gatedProvider("SECRETS_STATUS", "ADMIN");
    applyPluginRoleGating([pluginWithProviders([provider])]);

    await expect(
      provider.get?.(
        runtime,
        message({ fromId: "discord-user-1" }),
        {} as State,
      ),
    ).resolves.toMatchObject({ text: "SECRETS_STATUS: visible" });
    await expect(
      provider.get?.(
        runtime,
        message({ fromId: "discord-user-1" }),
        {} as State,
      ),
    ).resolves.toMatchObject({ text: "" });

    expect(rolesMock.checkSenderRole).toHaveBeenCalledTimes(2);
  });

  it("keeps concurrent role checks separate when live connector metadata differs", async () => {
    rolesMock.checkSenderRole.mockResolvedValue({
      role: "ADMIN",
      isOwner: false,
      isAdmin: true,
    });
    const provider = gatedProvider("SECRETS_STATUS", "ADMIN");
    applyPluginRoleGating([pluginWithProviders([provider])]);

    await Promise.all([
      provider.get?.(
        runtime,
        message({ fromId: "discord-user-1" }),
        {} as State,
      ),
      provider.get?.(
        runtime,
        message({ fromId: "discord-user-2" }),
        {} as State,
      ),
    ]);

    expect(rolesMock.checkSenderRole).toHaveBeenCalledTimes(2);
  });
});

describe("gating is driven ONLY by the provider's declared roleGate", () => {
  beforeEach(() => {
    rolesMock.checkSenderRole.mockReset();
  });

  async function visibleText(
    provider: Provider,
    callerRole: string,
  ): Promise<string | undefined> {
    rolesMock.checkSenderRole.mockResolvedValue({
      role: callerRole,
      isOwner: callerRole === "OWNER",
      isAdmin: callerRole === "OWNER" || callerRole === "ADMIN",
    });
    const result = await provider.get?.(
      runtime,
      message({ fromId: "discord-user-1" }),
      {} as State,
    );
    return result?.text;
  }

  it("denies an ADMIN-gated provider to a lower role, passes at/above ADMIN", async () => {
    const provider = gatedProvider("SECRETS_STATUS", "ADMIN");
    applyPluginRoleGating([pluginWithProviders([provider])]);
    expect(await visibleText(provider, "GUEST")).toBe("");
    expect(await visibleText(provider, "USER")).toBe("");
    expect(await visibleText(provider, "ADMIN")).toBe(
      "SECRETS_STATUS: visible",
    );
    expect(await visibleText(provider, "OWNER")).toBe(
      "SECRETS_STATUS: visible",
    );
  });

  it("denies an OWNER-gated provider to everyone below OWNER, passes OWNER", async () => {
    const provider = gatedProvider("browser_workspace", "OWNER");
    applyPluginRoleGating([pluginWithProviders([provider])]);
    expect(await visibleText(provider, "GUEST")).toBe("");
    expect(await visibleText(provider, "USER")).toBe("");
    expect(await visibleText(provider, "ADMIN")).toBe("");
    expect(await visibleText(provider, "OWNER")).toBe(
      "browser_workspace: visible",
    );
  });

  it("passes a USER-gated provider for everyone above GUEST, denies GUEST/NONE", async () => {
    const provider = gatedProvider("CURRENT_TODOS", "USER");
    applyPluginRoleGating([pluginWithProviders([provider])]);
    expect(await visibleText(provider, "NONE")).toBe("");
    expect(await visibleText(provider, "GUEST")).toBe("");
    expect(await visibleText(provider, "USER")).toBe("CURRENT_TODOS: visible");
    expect(await visibleText(provider, "ADMIN")).toBe("CURRENT_TODOS: visible");
    expect(await visibleText(provider, "OWNER")).toBe("CURRENT_TODOS: visible");
  });

  it("fails OPEN is impossible: removing the declaration leaves it PUBLIC (so the gate must live on the provider)", async () => {
    // A provider with NO declared roleGate is NOT gated — visible to everyone,
    // including NONE. This is the fail-open surface the old name-keyed override
    // map created on every rename; the fix moves the gate onto the provider so a
    // sensitive provider is only ungated if its OWN declaration is removed —
    // a visible, reviewable edit in the owning plugin, never silent name drift.
    const provider = plainProvider("SHELL_HISTORY");
    applyPluginRoleGating([pluginWithProviders([provider])]);
    expect((provider as { __roleGate?: string }).__roleGate).toBeUndefined();
    expect(await visibleText(provider, "NONE")).toBe("SHELL_HISTORY: visible");
  });

  it("treats a GUEST/NONE minRole as non-restricting (public)", async () => {
    const guestGated = gatedProvider("public-ish", "GUEST");
    applyPluginRoleGating([pluginWithProviders([guestGated])]);
    expect((guestGated as { __roleGate?: string }).__roleGate).toBeUndefined();
    expect(await visibleText(guestGated, "NONE")).toBe("public-ish: visible");
  });
});

describe("fail-CLOSED: a sensitive provider that cannot be wrapped is withheld", () => {
  beforeEach(() => {
    rolesMock.checkSenderRole.mockReset();
  });

  it("withholds a declared-sensitive provider from EVERYONE when wrapping throws", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    rolesMock.checkSenderRole.mockResolvedValue({
      role: "OWNER",
      isOwner: true,
      isAdmin: true,
    });

    // A sensitive provider whose `get` is a read-only data property: the wrap
    // path's `provider.get = …` reassignment throws (strict-mode module), so the
    // fail-closed branch must force-replace `get` with a redactor via
    // defineProperty and withhold the content rather than register it exposed.
    const original = vi.fn(
      async (): Promise<ProviderResult> => ({ text: "SHELL_HISTORY: leak" }),
    );
    const locked = {
      name: "SHELL_HISTORY",
      roleGate: { minRole: "ADMIN" },
    } as unknown as Provider;
    Object.defineProperty(locked, "get", {
      value: original,
      writable: false,
      configurable: true,
      enumerable: true,
    });

    applyPluginRoleGating([pluginWithProviders([locked])]);

    // Even OWNER must NOT see the leaked content — it was withheld, not gated.
    const result = await locked.get?.(
      runtime,
      message({ fromId: "discord-user-1" }),
      {} as State,
    );
    expect(result?.text).toBe("");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
