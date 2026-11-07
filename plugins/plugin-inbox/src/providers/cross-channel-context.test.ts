import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxRepository } from "../inbox/repository.ts";
import type { TriageEntry } from "../inbox/types.ts";
import { crossChannelContextProvider } from "./cross-channel-context.ts";

const AGENT_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const OWNER_ID = "00000000-0000-4000-8000-000000000002" as UUID;

function ownerRuntime(ownerName: string): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ID : undefined,
    getEntityById: async () => ({ id: OWNER_ID, names: [ownerName] }),
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
}

function triageEntry(senderName: string): TriageEntry {
  return {
    id: `entry-${senderName}`,
    agentId: AGENT_ID,
    source: "gmail",
    sourceRoomId: null,
    sourceEntityId: null,
    sourceMessageId: null,
    channelName: `${senderName} thread`,
    channelType: "dm",
    deepLink: null,
    classification: "needs_reply",
    urgency: "medium",
    confidence: 0.9,
    snippet: `message from ${senderName}`,
    senderName,
    threadContext: null,
    triageReasoning: null,
    suggestedResponse: null,
    draftResponse: null,
    autoReplied: false,
    snoozedUntil: null,
    resolved: false,
    resolvedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

async function injectedSenders(
  ownerName: string,
  storedSenders: string[],
): Promise<string[]> {
  vi.spyOn(
    InboxRepository.prototype,
    "getUnresolvedForSender",
  ).mockResolvedValue(storedSenders.map(triageEntry));
  const message = {
    entityId: OWNER_ID,
    roomId: "00000000-0000-4000-8000-000000000003",
    content: { text: "hi", source: "discord" },
  } as Memory;
  const result = await crossChannelContextProvider.get(
    ownerRuntime(ownerName),
    message,
    {} as State,
  );
  const entries = (result.data?.entries ?? []) as TriageEntry[];
  return entries.map((entry) => entry.senderName ?? "");
}

describe("crossChannelContextProvider sender name matching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not attribute entries from Alice or Alan to sender Al", async () => {
    expect(await injectedSenders("Al", ["Al", "Alice", "Alan"])).toEqual([
      "Al",
    ]);
  });

  it("does not attribute entries from a shorter name contained in the sender's", async () => {
    expect(await injectedSenders("Alice", ["Al", "Li", "alice"])).toEqual([
      "alice",
    ]);
  });

  it("matches the same full name case-insensitively and by whole first name", async () => {
    expect(
      await injectedSenders("Alice Smith", [
        "alice smith",
        "ALICE SMITH",
        "Alice",
        "Alicia Smithers",
      ]),
    ).toEqual(["alice smith", "ALICE SMITH", "Alice"]);
  });

  it("keeps Korean names apart when one is a prefix of the other", async () => {
    expect(await injectedSenders("민수", ["민수", "민수정", "김민수"])).toEqual(
      ["민수"],
    );
  });

  it("matches nothing for a blank sender name or blank entry names", async () => {
    expect(await injectedSenders("  ", ["Al", "Alice"])).toEqual([]);
    expect(await injectedSenders("Al", ["", " "])).toEqual([]);
  });
});
