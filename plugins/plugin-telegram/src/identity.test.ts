/**
 * Sender entity-id resolution. Proves inbound messages, slash-command auth,
 * and callback/reaction paths share one UUID, including the default account
 * whose old `scopedTelegramKey` omitted the `default:` prefix, the configured
 * canonical-owner store path, and fail-closed `getEntityById` errors.
 */
import { createUniqueUuid, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { resolveTelegramRuntimeEntityId } from "./identity";

// The shared vitest setup stubs `getConfiguredOwnerEntityIds` to `[]`, which
// would hide the canonical-owner store path this file exists to cover.
vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return { ...actual };
});

const OWNER_ENTITY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function runtime(): IAgentRuntime {
  return {
    agentId: "agent-1",
    getSetting: () => undefined,
  } as unknown as IAgentRuntime;
}

function ownerRuntime(
  getEntityById?: IAgentRuntime["getEntityById"],
): IAgentRuntime {
  return {
    agentId: "agent-1",
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ENTITY_ID : undefined,
    ...(getEntityById ? { getEntityById } : {}),
  } as unknown as IAgentRuntime;
}

describe("resolveTelegramRuntimeEntityId", () => {
  it("seeds the default account as default:<telegramUserId>, not the bare id", async () => {
    const rt = runtime();
    const inbound = await resolveTelegramRuntimeEntityId(rt, "default", "4242");
    expect(inbound).toBe(createUniqueUuid(rt, "default:4242"));
    expect(inbound).not.toBe(createUniqueUuid(rt, "4242"));
  });

  it("keeps non-default account seeds identical to the historical scoped key", async () => {
    const rt = runtime();
    const accounts = ["acct-a", "bot-2", "other"];
    for (const accountId of accounts) {
      const resolved = await resolveTelegramRuntimeEntityId(
        rt,
        accountId,
        "555001",
      );
      expect(resolved).toBe(createUniqueUuid(rt, `${accountId}:555001`));
    }
  });

  it("returns the configured owner entity when Telegram metadata matches", async () => {
    const getEntityById = vi.fn(async () => ({
      id: OWNER_ENTITY_ID,
      names: ["owner"],
      metadata: { telegram: { userId: "4242" } },
    }));
    const rt = ownerRuntime(getEntityById);
    await expect(
      resolveTelegramRuntimeEntityId(rt, "default", "4242"),
    ).resolves.toBe(OWNER_ENTITY_ID);
    expect(getEntityById).toHaveBeenCalledWith(OWNER_ENTITY_ID);
    expect(OWNER_ENTITY_ID).not.toBe(createUniqueUuid(rt, "default:4242"));
  });

  it("falls back to the connector UUID when the configured owner is unpaired", async () => {
    const getEntityById = vi.fn(async () => ({
      id: OWNER_ENTITY_ID,
      names: ["owner"],
      metadata: { telegram: { userId: "9999" } },
    }));
    const rt = ownerRuntime(getEntityById);
    await expect(
      resolveTelegramRuntimeEntityId(rt, "default", "4242"),
    ).resolves.toBe(createUniqueUuid(rt, "default:4242"));
  });

  it("throws TELEGRAM_IDENTITY_NOT_READY when getEntityById is absent", async () => {
    const rt = ownerRuntime();
    await expect(
      resolveTelegramRuntimeEntityId(rt, "default", "4242"),
    ).rejects.toMatchObject({
      name: "ElizaError",
      code: "TELEGRAM_IDENTITY_NOT_READY",
    });
  });

  it("propagates getEntityById storage failure", async () => {
    const rt = ownerRuntime(
      vi.fn(async () => {
        throw new Error("disk full");
      }),
    );
    await expect(
      resolveTelegramRuntimeEntityId(rt, "default", "4242"),
    ).rejects.toThrow("disk full");
  });
});
