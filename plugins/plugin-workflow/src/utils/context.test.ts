/**
 * Coverage for workflow conversation-context helpers.
 */
import { describe, expect, it, vi } from "vitest";
import type { Memory, IAgentRuntime, UUID } from "@elizaos/core";

import {
  buildConversationContext,
  getLocalOwnerEntityId,
  getUserTagName,
} from "./context";

describe("buildConversationContext", () => {
  it("returns currentText when no recentMessages", () => {
    const msg = { content: { text: "hello" } } as Memory;
    expect(buildConversationContext(msg, undefined)).toBe("hello");
    expect(buildConversationContext(msg, { values: {} } as never)).toBe("hello");
    expect(buildConversationContext(msg, { values: { recentMessages: "" } } as never)).toBe("hello");
  });

  it("concatenates recentMessages and current request", () => {
    const msg = { content: { text: "current" } } as Memory;
    const state = { values: { recentMessages: "prev" } } as unknown as never;
    expect(buildConversationContext(msg, state)).toBe("prev\n\nCurrent request: current");
  });

  it("handles missing text in message", () => {
    const msg = { content: {} } as Memory;
    const state = { values: { recentMessages: "history" } } as never;
    expect(buildConversationContext(msg, state)).toBe("history\n\nCurrent request: ");
  });

  it("ignores non-string recentMessages", () => {
    const msg = { content: { text: "hi" } } as Memory;
    const state = { values: { recentMessages: 123 as unknown as string } } as never;
    expect(buildConversationContext(msg, state)).toBe("hi");
  });
});

describe("getLocalOwnerEntityId", () => {
  it("returns canonical owner when configured", () => {
    const canonical = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const runtime = {
      agentId: "11111111-1111-4111-8111-111111111111",
      getSetting: (key: string) => key === "ELIZA_OWNER_CONTACTS_JSON" ? JSON.stringify({ telegram: { entityId: canonical } }) : null,
    } as unknown as IAgentRuntime;
    const result = getLocalOwnerEntityId(runtime);
    expect(result).toBe(canonical);
  });

  it("falls back to deterministic owner when no canonical id", () => {
    const runtime = {
      agentId: "11111111-1111-4111-8111-111111111111",
      getSetting: () => null,
    } as unknown as IAgentRuntime;
    const result = getLocalOwnerEntityId(runtime);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(10);
    expect(result).not.toBe("11111111-1111-4111-8111-111111111111");
  });
});

describe("getUserTagName", () => {
  it("builds tag with real name when entity has custom name", async () => {
    const runtime = {
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      getEntityById: vi.fn().mockResolvedValue({ names: ["Alice"] }),
    } as unknown as IAgentRuntime;
    const tag = await getUserTagName(runtime, "12345678-1234-4234-8234-123456789012");
    expect(tag).toContain("Alice");
    expect(tag).toContain("12345678");
    expect(tag).toContain("agent_");
  });

  it("uses user_ prefix when no entity or default name", async () => {
    const runtime = {
      agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      getEntityById: vi.fn().mockResolvedValue(null),
    } as unknown as IAgentRuntime;
    const tag = await getUserTagName(runtime, "87654321-4321-4321-8321-210987654321");
    expect(tag.startsWith("user_87654321")).toBe(true);
  });

  it("uses user_ for default User <id> names", async () => {
    const userId = "12345678-1234-4234-8234-123456789012";
    const runtime = {
      agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      getEntityById: vi.fn().mockResolvedValue({ names: [`User ${userId}`] }),
    } as unknown as IAgentRuntime;
    const tag = await getUserTagName(runtime, userId);
    expect(tag.startsWith("user_")).toBe(true);
  });
});
