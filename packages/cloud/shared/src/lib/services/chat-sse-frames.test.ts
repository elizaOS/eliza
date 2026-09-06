/**
 * Contract tests for the canonical chat SSE frame builder shared by every
 * Cloud chat producer (#17122): each frame keeps its named `event:` line,
 * stamps the canonical JSON `type`, and the canonical type cannot be
 * overridden by a payload field.
 */
import { describe, expect, test } from "bun:test";
import { chatSseFrame, normalizeChatSseDonePayload } from "./chat-sse-frames";

describe("chatSseFrame", () => {
  test("stamps the canonical JSON type for each named event", () => {
    expect(chatSseFrame("chunk", { text: "hi" })).toBe(
      'event: chunk\ndata: {"text":"hi","type":"token"}\n\n',
    );
    expect(chatSseFrame("done", { fullText: "hi" })).toBe(
      'event: done\ndata: {"fullText":"hi","type":"done"}\n\n',
    );
    expect(chatSseFrame("error", { message: "boom" })).toBe(
      'event: error\ndata: {"message":"boom","type":"error"}\n\n',
    );
  });

  test("the canonical type wins over a conflicting payload field", () => {
    const frame = chatSseFrame("done", { type: "token", fullText: "hi" });
    const data = JSON.parse(frame.split("\ndata: ")[1] ?? "{}") as {
      type?: string;
    };
    expect(data.type).toBe("done");
  });
});

describe("normalizeChatSseDonePayload", () => {
  test("preserves the terminal client contract and authoritative upstream IDs", () => {
    expect(
      normalizeChatSseDonePayload(
        {
          messageId: "upstream-assistant",
          userMessageId: "upstream-user",
          text: "final answer",
          actionResults: [{ actionName: "VIEWS", success: true }],
          usage: { totalTokens: 4 },
          failureKind: "no_provider",
          accountConnect: { provider: "openai" },
          untrustedExtra: "drop-me",
        },
        { messageId: "fallback", fullText: "partial" },
      ),
    ).toEqual({
      userMessageId: "upstream-user",
      failureKind: "no_provider",
      accountConnect: { provider: "openai" },
      actionResults: [{ actionName: "VIEWS", success: true }],
      usage: { totalTokens: 4 },
      messageId: "upstream-assistant",
      text: "final answer",
      fullText: "final answer",
    });
  });

  // The allowlist is a proxy boundary: every name in it is a field the shared
  // client reducer reads, and anything absent from it is dropped. Both halves
  // matter, so name each field individually rather than asserting a handful and
  // trusting the rest — deleting a single entry silently stops that field
  // crossing while every other assertion stays green.
  const DONE_METADATA_FIELD_CASES = [
    ["transcriptVisibility", "internal"],
    ["agentName", "Eliza"],
    ["userMessageId", "upstream-user"],
    ["assistantEphemeral", true],
    ["historyRefreshRequired", true],
    ["thought", "considering the request"],
    ["noResponseReason", "ignored"],
    ["failureKind", "no_provider"],
    ["accountConnect", { provider: "openai" }],
    ["localInference", { provider: "mobile-local-direct-reply" }],
    ["actionResults", [{ actionName: "VIEWS", success: true }]],
    ["usage", { totalTokens: 4 }],
  ] as const satisfies readonly (readonly [string, unknown][]);

  test.each(DONE_METADATA_FIELD_CASES)(
    "carries %s across the proxy boundary and omits it when upstream does",
    (field, value) => {
      expect(
        normalizeChatSseDonePayload({ [field]: value }, { messageId: "id", fullText: "text" }),
      ).toEqual({
        [field]: value,
        messageId: "id",
        text: "text",
        fullText: "text",
      });
      expect(
        Object.hasOwn(
          normalizeChatSseDonePayload({}, { messageId: "id", fullText: "text" }),
          field,
        ),
      ).toBe(false);
    },
  );

  // A generated `test.each` table registers zero cases over an empty list and
  // still reports green, so pin the exact key set independently. This also
  // fails on a silent ADDITION, which per-field cases cannot see.
  test("forwards exactly the allowlisted keys and no others", () => {
    const payload = Object.fromEntries(
      DONE_METADATA_FIELD_CASES.map(([field, value]) => [field, value]),
    );
    expect(
      Object.keys(
        normalizeChatSseDonePayload(payload, { messageId: "id", fullText: "text" }),
      ).sort(),
    ).toEqual(
      [
        ...DONE_METADATA_FIELD_CASES.map(([field]) => field),
        "messageId",
        "text",
        "fullText",
      ].sort(),
    );
  });

  test("drops every field outside the allowlist", () => {
    const smuggled = {
      metadata: { internal: true },
      sessionId: "sess-1",
      provider: "openai",
      apiKey: "sk-should-never-cross",
      cost: 0.01,
      headers: { authorization: "Bearer x" },
      raw: "upstream-debug",
      type: "token",
      error: "boom",
    };
    const normalized = normalizeChatSseDonePayload(smuggled, {
      messageId: "id",
      fullText: "text",
    });
    for (const field of Object.keys(smuggled)) {
      expect(Object.hasOwn(normalized, field)).toBe(false);
    }
    expect(Object.keys(normalized).sort()).toEqual(["fullText", "messageId", "text"]);
  });

  // `Object.hasOwn`, not truthiness or `in`: an upstream that sends the field
  // explicitly as `undefined` has still SENT it, and the key is forwarded. This
  // distinguishes the guard from `if (payload[field] !== undefined)`, which
  // would drop it, and from a plain truthiness check, which would also drop
  // `false` and `0`.
  test("forwards an explicitly undefined allowlisted field as a present key", () => {
    const normalized = normalizeChatSseDonePayload(
      { thought: undefined },
      { messageId: "id", fullText: "text" },
    );
    expect(Object.hasOwn(normalized, "thought")).toBe(true);
    expect(normalized.thought).toBeUndefined();
  });

  test.each([
    ["a falsy boolean", "assistantEphemeral", false],
    ["a zero-valued count", "usage", 0],
    ["an empty string", "agentName", ""],
  ])("forwards %s rather than dropping it", (_label, field, value) => {
    expect(
      normalizeChatSseDonePayload({ [field]: value }, { messageId: "id", fullText: "text" }),
    ).toEqual({
      [field]: value,
      messageId: "id",
      text: "text",
      fullText: "text",
    });
  });

  // An empty `fullText` is a legitimate terminal value, not a missing one: the
  // ambient voice gate emits `{ fullText: "", noResponseReason: "ignored" }` to
  // suppress a turn. A truthiness check here would substitute the accumulated
  // text and un-suppress it, so the `typeof === "string"` test is load-bearing.
  test("preserves an empty upstream fullText instead of falling back", () => {
    expect(
      normalizeChatSseDonePayload(
        { fullText: "", noResponseReason: "ignored" },
        { messageId: "id", fullText: "accumulated" },
      ),
    ).toEqual({
      noResponseReason: "ignored",
      messageId: "id",
      text: "",
      fullText: "",
    });
  });

  test("prefers fullText over text and falls back when neither is a string", () => {
    expect(
      normalizeChatSseDonePayload(
        { fullText: "authoritative", text: "secondary" },
        { messageId: "id", fullText: "accumulated" },
      ).fullText,
    ).toBe("authoritative");
    expect(
      normalizeChatSseDonePayload({ text: "secondary" }, { messageId: "id", fullText: "acc" })
        .fullText,
    ).toBe("secondary");
    expect(
      normalizeChatSseDonePayload({ text: 7 }, { messageId: "id", fullText: "acc" }).fullText,
    ).toBe("acc");
  });

  // The upstream id is trusted only when it is a non-blank string; each
  // rejected shape needs its own case, and the accepted neighbour above proves
  // the cases discriminate rather than always falling back.
  test.each([
    ["whitespace only", "   "],
    ["empty", ""],
    ["a non-string", 42],
    ["null", null],
  ])("falls back to the generated messageId when upstream sends %s", (_label, upstream) => {
    expect(
      normalizeChatSseDonePayload(
        { messageId: upstream },
        {
          messageId: "generated",
          fullText: "text",
        },
      ).messageId,
    ).toBe("generated");
  });

  test("trusts a padded upstream messageId verbatim, without trimming it", () => {
    expect(
      normalizeChatSseDonePayload(
        { messageId: " upstream " },
        {
          messageId: "generated",
          fullText: "text",
        },
      ).messageId,
    ).toBe(" upstream ");
  });

  test("uses generated identity and accumulated text only when upstream omits them", () => {
    expect(
      normalizeChatSseDonePayload({}, { messageId: "generated", fullText: "accumulated" }),
    ).toEqual({
      messageId: "generated",
      text: "accumulated",
      fullText: "accumulated",
    });
  });
});
