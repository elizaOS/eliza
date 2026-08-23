/**
 * Behavioral coverage for the OpenAI/Anthropic compat body helpers: flatten
 * mixed content shapes, collapse resubmitted histories to system + last user,
 * resolve a room key from client identifiers, and scope long keys so a shared
 * 120-char prefix cannot alias two conversations onto one room. Drives the
 * real module — no mocks.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  COMPAT_ROOM_KEY_MAX_LENGTH,
  extractAnthropicSystemAndLastUser,
  extractCompatTextContent,
  extractOpenAiSystemAndLastUser,
  resolveCompatRoomKey,
  scopeCompatRoomKey,
} from "./compat-utils.ts";

describe("extractCompatTextContent", () => {
  it("returns a string content field unchanged", () => {
    expect(extractCompatTextContent("hello")).toBe("hello");
    expect(extractCompatTextContent("")).toBe("");
    expect(extractCompatTextContent("  keep whitespace  ")).toBe(
      "  keep whitespace  ",
    );
  });

  it("joins text parts from an array and skips non-text typed parts", () => {
    expect(
      extractCompatTextContent([
        { type: "text", text: "Hello " },
        { type: "image", text: "should-skip" },
        { type: "text", text: "world" },
        { type: "tool_use", text: "also-skip" },
      ]),
    ).toBe("Hello world");
  });

  it("keeps parts that omit type or use an empty type when they have text", () => {
    expect(
      extractCompatTextContent([
        { text: "alpha" },
        { type: "", text: "beta" },
        { type: "text", text: "gamma" },
      ]),
    ).toBe("alphabetagamma");
  });

  it("skips non-record items and parts whose text is not a non-empty string", () => {
    expect(
      extractCompatTextContent([
        "bare-string",
        12,
        null,
        undefined,
        { type: "text", text: 99 },
        { type: "text", text: "" },
        { type: "text" },
        { type: "text", text: "kept" },
      ]),
    ).toBe("kept");
  });

  it("returns empty for an empty array", () => {
    expect(extractCompatTextContent([])).toBe("");
  });

  it("reads a text field off a single object content value", () => {
    expect(extractCompatTextContent({ text: "from-object" })).toBe(
      "from-object",
    );
    expect(extractCompatTextContent({ text: 7 })).toBe("");
    expect(extractCompatTextContent({ type: "text" })).toBe("");
  });

  it("returns empty for non-content values", () => {
    expect(extractCompatTextContent(undefined)).toBe("");
    expect(extractCompatTextContent(null)).toBe("");
    expect(extractCompatTextContent(42)).toBe("");
    expect(extractCompatTextContent(true)).toBe("");
  });
});

describe("extractOpenAiSystemAndLastUser", () => {
  it("returns null when messages is not an array or has no user turn", () => {
    expect(extractOpenAiSystemAndLastUser(undefined)).toBeNull();
    expect(extractOpenAiSystemAndLastUser({ role: "user" })).toBeNull();
    expect(extractOpenAiSystemAndLastUser([])).toBeNull();
    expect(
      extractOpenAiSystemAndLastUser([
        { role: "system", content: "only system" },
        { role: "assistant", content: "only assistant" },
      ]),
    ).toBeNull();
  });

  it("returns the last user turn with an empty system when none was sent", () => {
    expect(
      extractOpenAiSystemAndLastUser([{ role: "user", content: "  hi  " }]),
    ).toEqual({ system: "", user: "hi" });
  });

  it("joins system and developer prompts and keeps only the last user turn", () => {
    expect(
      extractOpenAiSystemAndLastUser([
        { role: "system", content: "sys-a" },
        { role: "developer", content: "dev-b" },
        { role: "user", content: "first" },
        { role: "assistant", content: "ignored reply" },
        { role: "tool", content: "ignored tool" },
        { role: "function", content: "ignored fn" },
        { role: "user", content: "second" },
      ]),
    ).toEqual({ system: "sys-a\n\ndev-b", user: "second" });
  });

  it("skips non-record items and whitespace-only content", () => {
    expect(
      extractOpenAiSystemAndLastUser([
        "not-a-message",
        null,
        { role: "system", content: "   " },
        { role: "system", content: "real-system" },
        { role: "user", content: "\n\t" },
        { role: "user", content: [{ type: "text", text: " from-parts " }] },
      ]),
    ).toEqual({ system: "real-system", user: "from-parts" });
  });
});

describe("extractAnthropicSystemAndLastUser", () => {
  it("returns null when messages is not an array or has no user turn", () => {
    expect(
      extractAnthropicSystemAndLastUser({
        system: "sys",
        messages: { role: "user" },
      }),
    ).toBeNull();
    expect(
      extractAnthropicSystemAndLastUser({ system: "sys", messages: [] }),
    ).toBeNull();
    expect(
      extractAnthropicSystemAndLastUser({
        system: "sys",
        messages: [{ role: "assistant", content: "only assistant" }],
      }),
    ).toBeNull();
  });

  it("reads a string system prompt and the last non-empty user turn", () => {
    expect(
      extractAnthropicSystemAndLastUser({
        system: "  be terse  ",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ignored" },
          { role: "user", content: [{ type: "text", text: " second " }] },
        ],
      }),
    ).toEqual({ system: "be terse", user: "second" });
  });

  it("treats a non-string system field as empty rather than flattening parts", () => {
    expect(
      extractAnthropicSystemAndLastUser({
        system: [{ type: "text", text: "block-system" }],
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toEqual({ system: "", user: "hello" });
  });

  it("skips non-record items and whitespace-only user content", () => {
    expect(
      extractAnthropicSystemAndLastUser({
        messages: [
          "not-a-message",
          null,
          { role: "user", content: "   " },
          { role: "user", content: "kept" },
        ],
      }),
    ).toEqual({ system: "", user: "kept" });
  });
});

describe("resolveCompatRoomKey", () => {
  it("prefers body.user over metadata identifiers", () => {
    expect(
      resolveCompatRoomKey({
        user: "direct-user",
        metadata: {
          conversation_id: "conv",
          conversationId: "camel",
          user_id: "meta-user",
        },
      }),
    ).toBe("direct-user");
  });

  it("prefers metadata.conversation_id, then camelCase conversationId, then user_id", () => {
    expect(
      resolveCompatRoomKey({
        metadata: {
          conversation_id: "snake-conv",
          conversationId: "camel-conv",
          user_id: "meta-user",
        },
      }),
    ).toBe("snake-conv");
    expect(
      resolveCompatRoomKey({
        metadata: { conversationId: "camel-conv", user_id: "meta-user" },
      }),
    ).toBe("camel-conv");
    expect(resolveCompatRoomKey({ metadata: { user_id: "meta-user" } })).toBe(
      "meta-user",
    );
  });

  it("treats blank or non-string identifiers as missing and uses the fallback", () => {
    expect(resolveCompatRoomKey({})).toBe("default");
    expect(resolveCompatRoomKey({}, "room-x")).toBe("room-x");
    expect(
      resolveCompatRoomKey({
        user: "   ",
        metadata: { conversation_id: "\t", user_id: 99 },
      }),
    ).toBe("default");
    expect(resolveCompatRoomKey({ metadata: ["not-a-record"] }, "fb")).toBe(
      "fb",
    );
  });

  it("trims accepted identifiers", () => {
    expect(resolveCompatRoomKey({ user: "  alice  " })).toBe("alice");
    expect(
      resolveCompatRoomKey({ metadata: { conversation_id: "  conv-1  " } }),
    ).toBe("conv-1");
  });
});

describe("scopeCompatRoomKey", () => {
  it("exports the 120-character verbatim embedding limit", () => {
    expect(COMPAT_ROOM_KEY_MAX_LENGTH).toBe(120);
  });

  it("returns keys at or under the limit unchanged, including empty", () => {
    expect(scopeCompatRoomKey("")).toBe("");
    expect(scopeCompatRoomKey("short")).toBe("short");
    const exact = "k".repeat(COMPAT_ROOM_KEY_MAX_LENGTH);
    expect(exact.length).toBe(120);
    expect(scopeCompatRoomKey(exact)).toBe(exact);
  });

  it("replaces longer keys with a sha256 digest of the full original key", () => {
    const raw = "k".repeat(COMPAT_ROOM_KEY_MAX_LENGTH + 1);
    const digest = createHash("sha256").update(raw, "utf8").digest("hex");
    expect(scopeCompatRoomKey(raw)).toBe(`sha256:${digest}`);
    expect(scopeCompatRoomKey(raw)).not.toContain(raw.slice(0, 16));
  });

  it("does not alias two long keys that share a 120-char prefix", () => {
    const prefix = "p".repeat(COMPAT_ROOM_KEY_MAX_LENGTH);
    const a = `${prefix}alpha`;
    const b = `${prefix}bravo`;
    const scopedA = scopeCompatRoomKey(a);
    const scopedB = scopeCompatRoomKey(b);
    expect(scopedA).not.toBe(scopedB);
    expect(scopedA).toBe(
      `sha256:${createHash("sha256").update(a, "utf8").digest("hex")}`,
    );
    expect(scopedB).toBe(
      `sha256:${createHash("sha256").update(b, "utf8").digest("hex")}`,
    );
  });
});
