import type {
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  State,
} from "@elizaos/core";
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
