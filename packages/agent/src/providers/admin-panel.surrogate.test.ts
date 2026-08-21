/** Surrogate safety for admin panel conversation formatting in admin-panel.ts. */

import {
  type IAgentRuntime,
  MESSAGE_SOURCE_CLIENT_CHAT,
  type Memory,
  type State,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("../security/access.ts", () => ({
  hasAdminAccess: vi.fn(async () => true),
}));

import {
  ADMIN_PANEL_LINE_LIMIT,
  clampAdminPanelResult,
  createAdminPanelProvider,
  formatAdminPanelLine,
  MAX_TEXT_LENGTH,
} from "./admin-panel.ts";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return true;
}

const OWNER_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const AGENT_ID = "22222222-2222-2222-2222-222222222222" as UUID;
const ROOM_ID = "33333333-3333-3333-3333-333333333333" as UUID;
const EMPTY_STATE = { values: {}, data: {}, text: "" } as unknown as State;

function makeMemory(
  text: string,
  createdAt: number,
  entityId: string = OWNER_ID,
): Memory {
  return {
    id: `00000000-0000-0000-0000-${String(createdAt).padStart(12, "0")}` as UUID,
    entityId: entityId as UUID,
    roomId: ROOM_ID,
    content: { text },
    createdAt,
  } as unknown as Memory;
}

function makeRuntime(memories: Memory[]): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    character: { name: "Test" },
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ID : undefined,
    getRoomsForParticipant: async () => [ROOM_ID],
    getRoom: async () =>
      ({ id: ROOM_ID, source: MESSAGE_SOURCE_CLIENT_CHAT }) as unknown as never,
    getMemoriesByRoomIds: async () => memories,
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

function triggerMessage(): Memory {
  return {
    id: "99999999-9999-9999-9999-999999999999" as UUID,
    entityId: OWNER_ID,
    roomId: ROOM_ID,
    content: { text: "trigger" },
  } as unknown as Memory;
}

describe("admin panel conversation surrogate safety via exported seams", () => {
  it("per-line 200: emoji at 199 boundary backs off without lone surrogate", () => {
    const fox = "🦊";
    // 199 a's + fox (2 code units) = 201 code units, cut at 200 must back off to 199
    const text = `${"a".repeat(199)}${fox}${"b".repeat(50)}`;
    const line = formatAdminPanelLine("Owner", text);
    // mutation check: reverting formatAdminPanelLine to substring produces lone high surrogate -> not well-formed -> fails
    expect(isWellFormed(line)).toBe(true);
    expect(line.length).toBeLessThanOrEqual(
      "[Owner] ".length + ADMIN_PANEL_LINE_LIMIT,
    );
    expect(line).toBe(`[Owner] ${"a".repeat(199)}`);
    expect(line.includes("\uD83D")).toBe(false);
    expect(() => JSON.stringify({ line })).not.toThrow();
  });

  it("per-line 200: fitting emoji ending at 200 kept intact well-formed", () => {
    const fox = "🦊";
    const text = `${"a".repeat(198)}${fox}`;
    const line = formatAdminPanelLine("Agent", text);
    expect(isWellFormed(line)).toBe(true);
    expect(line.includes(fox)).toBe(true);
    expect(line).toBe(`[Agent] ${text}`);
    expect(() => JSON.stringify({ line })).not.toThrow();
  });

  it("per-line 200: lone high surrogate sanitized to replacement", () => {
    const badText = `Owner chat with \ud800 lone ${"x".repeat(300)}`;
    const line = formatAdminPanelLine("Owner", badText);
    expect(isWellFormed(line)).toBe(true);
    expect(line.includes("\ud800")).toBe(false);
    expect(line.includes("�")).toBe(true);
    expect(() => JSON.stringify({ line })).not.toThrow();
  });

  it("aggregate 2000: fox at MAX-3 boundary backs off without lone surrogate", () => {
    const fox = "🦊";
    const raw = `${"a".repeat(MAX_TEXT_LENGTH - 4)}${fox}${"b".repeat(50)}`;
    const out = clampAdminPanelResult(raw);
    // mutation check: reverting clampAdminPanelResult to substring yields lone surrogate at 1997 cut
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    expect(out.endsWith("...")).toBe(true);
    expect(out.includes(fox)).toBe(false);
    expect(() => JSON.stringify({ out })).not.toThrow();
  });

  it("aggregate 2000: short input passthrough well-formed", () => {
    const short = "short conversation";
    expect(clampAdminPanelResult(short)).toBe(short);
    expect(isWellFormed(clampAdminPanelResult(short))).toBe(true);
  });

  it("aggregate 2000: lone high surrogate sanitized", () => {
    const bad = `conversation \ud800 with ${"y".repeat(3000)}`;
    const out = clampAdminPanelResult(bad);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\ud800")).toBe(false);
  });
});

describe("admin panel provider surrogate safety via real provider", () => {
  it("per-line 200 via provider: Owner message with emoji at 199 boundary is well-formed and clamped", async () => {
    const fox = "🦊";
    const text = `${"a".repeat(199)}${fox}${"b".repeat(50)}`;
    const memories = [makeMemory(text, 1)];
    const runtime = makeRuntime(memories);
    const provider = createAdminPanelProvider();
    const result = await provider.get(runtime, triggerMessage(), EMPTY_STATE);
    const out = result.text ?? "";
    // must drive real formatMessages -> formatAdminPanelLine -> truncateWellFormed
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    expect(out).toContain(`[Owner] ${"a".repeat(199)}`);
    expect(out.includes(fox)).toBe(false);
    expect(isWellFormed(out)).toBe(true);
    expect(() => JSON.stringify({ out })).not.toThrow();
  });

  it("aggregate 2000 via provider: many Owner messages with emojis clamp to 2000 well-formed", async () => {
    const fox = "🦊";
    // 15 lines * ~120 chars each will exceed 2000 after header+join, triggering aggregate clamp
    const memories = Array.from({ length: 15 }, (_, i) =>
      makeMemory(`${"a".repeat(120)}${fox}${"b".repeat(10)}#${i}`, 100 + i),
    );
    const runtime = makeRuntime(memories);
    const provider = createAdminPanelProvider();
    const result = await provider.get(runtime, triggerMessage(), EMPTY_STATE);
    const out = result.text ?? "";
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    expect(out.length).toBeGreaterThan(0);
    // truncation should end with ... when over budget
    if (out.length === MAX_TEXT_LENGTH) {
      expect(out.endsWith("...")).toBe(true);
    }
    expect(() => JSON.stringify({ out })).not.toThrow();
  });

  it("provider sanitizes lone high surrogate in Owner message", async () => {
    const badText = `Owner says \ud800 bad ${"x".repeat(300)}`;
    const memories = [makeMemory(badText, 1)];
    const runtime = makeRuntime(memories);
    const provider = createAdminPanelProvider();
    const result = await provider.get(runtime, triggerMessage(), EMPTY_STATE);
    const out = result.text ?? "";
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\ud800")).toBe(false);
    expect(() => JSON.stringify({ out })).not.toThrow();
  });
});
