import { describe, expect, it } from "vitest";
import type { ChatEntry, ToolCall } from "../types/index";
import {
  buildToolResultEntry,
  decorateTelegramEntries,
  getTelegramSourceLabel,
  getUnflushedTelegramAssistantContent,
  replaceTurnEntries,
} from "./telegram-turn-ui";

const TOOL_CALL: ToolCall = {
  id: "tool-1",
  type: "function",
  function: {
    name: "read_file",
    arguments: '{"path":"src/ui/app.tsx"}',
  },
};

describe("telegram turn ui helpers", () => {
  it("returns only the unflushed suffix for accumulated assistant previews", () => {
    expect(getUnflushedTelegramAssistantContent("Planning tool work", 9)).toBe("tool work");
    expect(getUnflushedTelegramAssistantContent("done", 99)).toBe("");
  });

  it("decorates synced telegram entries with remote metadata", () => {
    const entries: ChatEntry[] = [
      { type: "user", content: "hi", timestamp: new Date() },
      { type: "assistant", content: "hello", timestamp: new Date() },
      buildToolResultEntry(TOOL_CALL, { success: true, output: "ok" }),
    ];

    const decorated = decorateTelegramEntries(entries, 42, "telegram:42:1");

    expect(decorated[0]).toMatchObject({
      remoteKey: "telegram:42:1",
      sourceLabel: getTelegramSourceLabel("user", 42),
    });
    expect(decorated[1]).toMatchObject({
      remoteKey: "telegram:42:1",
      sourceLabel: getTelegramSourceLabel("assistant", 42),
    });
    expect(decorated[2]).toMatchObject({
      remoteKey: "telegram:42:1",
    });
  });

  it("replaces only the temporary entries for the finished telegram turn", () => {
    const before: ChatEntry[] = [
      { type: "assistant", content: "local session", timestamp: new Date() },
      { type: "user", content: "remote temp user", timestamp: new Date(), remoteKey: "telegram:42:1" },
      { type: "tool_result", content: "temp tool", timestamp: new Date(), remoteKey: "telegram:42:1" },
    ];

    const synced = decorateTelegramEntries(
      [
        { type: "user", content: "remote persisted user", timestamp: new Date() },
        buildToolResultEntry(TOOL_CALL, { success: true, output: "persisted tool" }),
        { type: "assistant", content: "remote persisted answer", timestamp: new Date() },
      ],
      42,
      "telegram:42:1",
    );

    const replaced = replaceTurnEntries(before, "telegram:42:1", synced);

    expect(replaced).toHaveLength(4);
    expect(replaced[0].content).toBe("local session");
    expect(replaced.slice(1).map((entry) => entry.content)).toEqual([
      "remote persisted user",
      "persisted tool",
      "remote persisted answer",
    ]);
  });
});
