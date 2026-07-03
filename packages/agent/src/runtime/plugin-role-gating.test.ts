import type {
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  State,
} from "@elizaos/core";
import { roleRank } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rolesMock = vi.hoisted(() => ({
  checkSenderRole: vi.fn(),
}));

vi.mock("./roles.ts", () => rolesMock);

import {
  applyPluginRoleGating,
  PROVIDER_ROLE_OVERRIDES,
  TIER_TO_CANONICAL_ROLE,
} from "./plugin-role-gating.ts";

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

function provider(name: string): Provider {
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

describe("applyPluginRoleGating", () => {
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
    const providers = [provider("SECRETS_STATUS"), provider("MISSING_SECRETS")];
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
    const gatedProvider = provider("SECRETS_STATUS");
    applyPluginRoleGating([pluginWithProviders([gatedProvider])]);

    await expect(
      gatedProvider.get?.(
        runtime,
        message({ fromId: "discord-user-1" }),
        {} as State,
      ),
    ).resolves.toMatchObject({ text: "SECRETS_STATUS: visible" });
    await expect(
      gatedProvider.get?.(
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
    const gatedProvider = provider("SECRETS_STATUS");
    applyPluginRoleGating([pluginWithProviders([gatedProvider])]);

    await Promise.all([
      gatedProvider.get?.(
        runtime,
        message({ fromId: "discord-user-1" }),
        {} as State,
      ),
      gatedProvider.get?.(
        runtime,
        message({ fromId: "discord-user-2" }),
        {} as State,
      ),
    ]);

    expect(rolesMock.checkSenderRole).toHaveBeenCalledTimes(2);
  });
});

describe("declared provider roleGate is enforced (#12087 Item 14)", () => {
  beforeEach(() => {
    rolesMock.checkSenderRole.mockReset();
  });

  function gatedProvider(name: string, minRole: string): Provider {
    return {
      name,
      roleGate: { minRole },
      get: vi.fn(async () => ({ text: `${name}: visible` })),
    } as unknown as Provider;
  }

  async function textFor(
    minRole: string,
    callerRole: string,
  ): Promise<string | undefined> {
    rolesMock.checkSenderRole.mockResolvedValue({
      role: callerRole,
      isOwner: callerRole === "OWNER",
      isAdmin: callerRole === "OWNER" || callerRole === "ADMIN",
    });
    // A name NOT in PROVIDER_ROLE_OVERRIDES — gating must come from the
    // provider's own declared roleGate, not the override map.
    const gated = gatedProvider("NOT_IN_OVERRIDES_PROVIDER", minRole);
    applyPluginRoleGating([pluginWithProviders([gated])]);
    const result = await gated.get?.(
      runtime,
      message({ fromId: "discord-user-1" }),
      {} as State,
    );
    return result?.text;
  }

  it("redacts an ADMIN-declared provider for USER, passes for ADMIN", async () => {
    expect(await textFor("ADMIN", "USER")).toBe("");
    expect(await textFor("ADMIN", "ADMIN")).toBe(
      "NOT_IN_OVERRIDES_PROVIDER: visible",
    );
  });

  it("passes a USER-declared provider for USER, redacts for GUEST", async () => {
    expect(await textFor("USER", "USER")).toBe(
      "NOT_IN_OVERRIDES_PROVIDER: visible",
    );
    expect(await textFor("USER", "GUEST")).toBe("");
  });
});

describe("override tiers map onto canonical role ranks", () => {
  it("normalizes each lowercase tier to a canonical role rank", () => {
    expect(roleRank(TIER_TO_CANONICAL_ROLE.user)).toBe(roleRank("USER"));
    expect(roleRank(TIER_TO_CANONICAL_ROLE.admin)).toBe(roleRank("ADMIN"));
    expect(roleRank(TIER_TO_CANONICAL_ROLE.owner)).toBe(roleRank("OWNER"));
    // The tiers form a strict hierarchy: user < admin < owner.
    expect(roleRank("USER")).toBeLessThan(roleRank("ADMIN"));
    expect(roleRank("ADMIN")).toBeLessThan(roleRank("OWNER"));
  });

  it("only references known tiers in the provider override map", () => {
    for (const tier of Object.values(PROVIDER_ROLE_OVERRIDES)) {
      expect(TIER_TO_CANONICAL_ROLE[tier]).toBeDefined();
    }
  });
});

describe("provider gating outcomes follow the canonical gate", () => {
  beforeEach(() => {
    rolesMock.checkSenderRole.mockReset();
  });

  async function visibleText(
    providerName: string,
    callerRole: string,
  ): Promise<string | undefined> {
    rolesMock.checkSenderRole.mockResolvedValue({
      role: callerRole,
      isOwner: callerRole === "OWNER",
      isAdmin: callerRole === "OWNER" || callerRole === "ADMIN",
    });
    const gatedProvider = provider(providerName);
    applyPluginRoleGating([pluginWithProviders([gatedProvider])]);
    const result = await gatedProvider.get?.(
      runtime,
      message({ fromId: "discord-user-1" }),
      {} as State,
    );
    return result?.text;
  }

  it("redacts an owner-gated provider for GUEST and NONE callers but passes OWNER", async () => {
    // app_browser_workspace is an "owner" override.
    expect(PROVIDER_ROLE_OVERRIDES.app_browser_workspace).toBe("owner");
    expect(await visibleText("app_browser_workspace", "GUEST")).toBe("");
    expect(await visibleText("app_browser_workspace", "NONE")).toBe("");
    expect(await visibleText("app_browser_workspace", "USER")).toBe("");
    expect(await visibleText("app_browser_workspace", "ADMIN")).toBe("");
    expect(await visibleText("app_browser_workspace", "OWNER")).toBe(
      "app_browser_workspace: visible",
    );
  });

  it("passes an admin-gated provider for ADMIN and OWNER, redacts below", async () => {
    expect(PROVIDER_ROLE_OVERRIDES.SECRETS_STATUS).toBe("admin");
    expect(await visibleText("SECRETS_STATUS", "GUEST")).toBe("");
    expect(await visibleText("SECRETS_STATUS", "USER")).toBe("");
    expect(await visibleText("SECRETS_STATUS", "ADMIN")).toBe(
      "SECRETS_STATUS: visible",
    );
    expect(await visibleText("SECRETS_STATUS", "OWNER")).toBe(
      "SECRETS_STATUS: visible",
    );
  });

  it("passes a user-gated provider for everyone above GUEST", async () => {
    expect(PROVIDER_ROLE_OVERRIDES.todos).toBe("user");
    expect(await visibleText("todos", "GUEST")).toBe("");
    expect(await visibleText("todos", "USER")).toBe("todos: visible");
    expect(await visibleText("todos", "ADMIN")).toBe("todos: visible");
    expect(await visibleText("todos", "OWNER")).toBe("todos: visible");
  });
});
