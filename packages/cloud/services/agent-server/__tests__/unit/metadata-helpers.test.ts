/** Exercises agent-server metadata helpers with deterministic cloud fixtures. */
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  buildCanonicalMessageMetadata,
  buildConnectionMetadata,
  type MessageMetadata,
  resolveSource,
  resolveUserName,
} from "../../src/agent-manager";
import { logger } from "../../src/logger";

afterEach(() => mock.restore());

describe("resolveSource", () => {
  test("returns platformName when provided", () => {
    expect(resolveSource({ platformName: "telegram" })).toBe("telegram");
  });

  test("returns 'agent-server' when platformName is undefined", () => {
    expect(resolveSource({ senderName: "Alice" })).toBe("agent-server");
  });

  test("returns 'agent-server' when metadata is undefined", () => {
    expect(resolveSource()).toBe("agent-server");
  });

  test("returns 'agent-server' when platformName is empty string", () => {
    expect(resolveSource({ platformName: "" })).toBe("agent-server");
  });

  test("returns 'agent-server' when platformName is unrecognized", () => {
    const spy = mock(() => {});
    logger.warn = spy;
    expect(resolveSource({ platformName: "unknown-platform" })).toBe(
      "agent-server",
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("accepts all known platforms", () => {
    for (const p of ["discord", "telegram", "whatsapp", "twilio", "blooio"]) {
      expect(resolveSource({ platformName: p })).toBe(p);
    }
  });

  test("does not accept email/calendar platform names on the chat message route", () => {
    for (const p of ["gmail", "email", "calendar", "google_calendar"]) {
      expect(resolveSource({ platformName: p })).toBe("agent-server");
    }
  });
});

describe("buildCanonicalMessageMetadata", () => {
  test("stamps provenance fields used by canonical memory recall", () => {
    expect(
      buildCanonicalMessageMetadata({
        source: "telegram",
        userId: "telegram-user-1",
        entityId: "00000000-0000-0000-0000-000000000001",
        metadata: {
          platformName: "telegram",
          senderName: "Alice",
          accountId: "bot:main",
          platformRecordId: "msg-123",
          chatType: "private",
        },
      }),
    ).toMatchObject({
      type: "message",
      scope: "private",
      provider: "telegram",
      accountId: "bot:main",
      platformMessageId: "msg-123",
      sourceId: "msg-123",
      chatType: "private",
      sender: { id: "telegram-user-1", name: "Alice" },
      telegram: {
        id: "telegram-user-1",
        userId: "telegram-user-1",
        entityId: "00000000-0000-0000-0000-000000000001",
        accountId: "bot:main",
        messageId: "msg-123",
      },
    });
  });
});

describe("resolveUserName", () => {
  test("returns senderName when provided", () => {
    expect(resolveUserName("user-001", { senderName: "Alice" })).toBe("Alice");
  });

  test("falls back to userId when senderName is undefined", () => {
    expect(resolveUserName("user-001", { platformName: "telegram" })).toBe(
      "user-001",
    );
  });

  test("falls back to userId when metadata is undefined", () => {
    expect(resolveUserName("user-001")).toBe("user-001");
  });

  test("falls back to userId when senderName is empty string", () => {
    expect(resolveUserName("user-001", { senderName: "" })).toBe("user-001");
  });

  test("truncates senderName exceeding 255 characters", () => {
    const longName = "A".repeat(300);
    const result = resolveUserName("user-001", { senderName: longName });
    expect(result.length).toBe(255);
    expect(result).toBe("A".repeat(255));
  });

  test("does not split a surrogate pair when the 255-cut lands inside one", () => {
    // 256 UTF-16 units: the emoji's surrogate pair straddles the cut at 255.
    const longName = `${"A".repeat(254)}\u{1F600}`;
    const result = resolveUserName("user-001", { senderName: longName });
    // Backs off before the split pair rather than truncating to a lone surrogate.
    expect(result).toBe("A".repeat(254));
  });
});

describe("buildConnectionMetadata", () => {
  test("returns chatId and platformName when both are provided", () => {
    const meta: MessageMetadata = {
      platformName: "telegram",
      senderName: "Alice",
      chatId: "42",
    };
    expect(buildConnectionMetadata(meta)).toEqual({
      chatId: "42",
      platformName: "telegram",
    });
  });

  test("returns only platformName when chatId is absent", () => {
    expect(buildConnectionMetadata({ platformName: "whatsapp" })).toEqual({
      platformName: "whatsapp",
    });
  });

  test("returns undefined and logs debug when chatId is present but platformName is absent", () => {
    const spy = mock(() => {});
    logger.debug = spy;
    expect(buildConnectionMetadata({ chatId: "42" })).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("returns undefined when metadata is undefined", () => {
    expect(buildConnectionMetadata()).toBeUndefined();
  });

  test("returns undefined when metadata is empty", () => {
    expect(buildConnectionMetadata({})).toBeUndefined();
  });

  test("returns undefined when only senderName is provided", () => {
    expect(buildConnectionMetadata({ senderName: "Alice" })).toBeUndefined();
  });

  test("returns undefined when chatId and platformName are empty strings", () => {
    expect(
      buildConnectionMetadata({ chatId: "", platformName: "" }),
    ).toBeUndefined();
  });

  test("omits chatId key when chatId is empty string with valid platform", () => {
    expect(
      buildConnectionMetadata({ platformName: "telegram", chatId: "" }),
    ).toEqual({
      platformName: "telegram",
    });
  });

  test("truncates chatId exceeding 128 characters", () => {
    const longId = "x".repeat(200);
    const result = buildConnectionMetadata({
      platformName: "whatsapp",
      chatId: longId,
    });
    expect(result?.chatId?.length).toBe(128);
    expect(result).toEqual({
      platformName: "whatsapp",
      chatId: "x".repeat(128),
    });
  });

  test("does not split a surrogate pair when the 128-cut lands inside one", () => {
    // 129 UTF-16 units: the emoji's surrogate pair straddles the cut at 128.
    const longId = `${"x".repeat(127)}\u{1F600}`;
    const result = buildConnectionMetadata({
      platformName: "whatsapp",
      chatId: longId,
    });
    // Backs off before the split pair rather than truncating to a lone surrogate.
    expect(result).toEqual({
      platformName: "whatsapp",
      chatId: "x".repeat(127),
    });
  });

  test("excludes both chatId and platformName when platform is unrecognized", () => {
    const spy = mock(() => {});
    logger.debug = spy;
    expect(
      buildConnectionMetadata({ platformName: "garbage", chatId: "42" }),
    ).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  test("excludes unrecognized platformName when it is the only field", () => {
    expect(
      buildConnectionMetadata({ platformName: "garbage" }),
    ).toBeUndefined();
  });
});
