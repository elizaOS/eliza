import type { Content, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { FarcasterCastService } from "../services/CastService";

const agentId = "00000000-0000-0000-0000-000000000001" as const;

function runtime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    agentId,
    character: { settings: {} },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getSetting: vi.fn((key: string) => settings[key] ?? null),
    createMemory: vi.fn(),
    useModel: vi.fn(),
  } as unknown as IAgentRuntime;
}

function client() {
  return {
    getTimeline: vi.fn(async () => ({ timeline: [] })),
    sendCast: vi.fn(),
  };
}

describe("FarcasterCastService hardening", () => {
  it("rejects post connector content for a different account before sending", async () => {
    const fakeClient = client();
    const service = new FarcasterCastService(fakeClient as never, runtime(), "brand");

    await expect(
      service.handleSendPost(runtime(), { text: "hello", accountId: "other" } as Content)
    ).rejects.toThrow("Farcaster account 'other' is not available");

    expect(fakeClient.sendCast).not.toHaveBeenCalled();
  });

  it("rejects blank post connector content before generating or sending", async () => {
    const fakeClient = client();
    const rt = runtime();
    const service = new FarcasterCastService(fakeClient as never, rt, "brand");

    await expect(
      service.handleSendPost(rt, { text: "   ", accountId: "brand" } as Content)
    ).rejects.toThrow("requires non-empty text");

    expect(rt.useModel).not.toHaveBeenCalled();
    expect(fakeClient.sendCast).not.toHaveBeenCalled();
  });

  it("returns no search results for blank queries without fetching the feed", async () => {
    const fakeClient = client();
    const rt = runtime();
    const service = new FarcasterCastService(fakeClient as never, rt, "brand");

    await expect(
      service.searchPosts({ runtime: rt, accountId: "brand" }, { query: " \n\t " })
    ).resolves.toEqual([]);

    expect(fakeClient.getTimeline).not.toHaveBeenCalled();
  });

  it("clamps hostile feed limits before calling the Farcaster client", async () => {
    const fakeClient = client();
    const rt = runtime({
      FARCASTER_ACCOUNTS: JSON.stringify({
        brand: {
          FARCASTER_FID: 456,
          FARCASTER_SIGNER_UUID: "signer-brand",
          FARCASTER_NEYNAR_API_KEY: "key-brand",
        },
      }),
    });
    const service = new FarcasterCastService(fakeClient as never, rt, "brand");

    await expect(
      service.fetchFeed({ runtime: rt, accountId: "brand" }, { limit: Number.POSITIVE_INFINITY })
    ).resolves.toEqual([]);

    expect(fakeClient.getTimeline).toHaveBeenCalledWith({
      fid: 456,
      pageSize: 25,
    });
  });
});
