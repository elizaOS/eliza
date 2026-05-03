import { afterEach, describe, expect, mock, test } from "bun:test";
import {
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
    expect(resolveSource({ platformName: "unknown-platform" })).toBe("agent-server");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("accepts all known platforms", () => {
    for (const p of ["telegram", "whatsapp", "twilio", "blooio"]) {
      expect(resolveSource({ platformName: p })).toBe(p);
    }
  });
});

describe("resolveUserName", () => {
  test("returns senderName when provided", () => {
    expect(resolveUserName("user-001", { senderName: "Alice" })).toBe("Alice");
  });

  test("falls back to userId when senderName is undefined", () => {
    expect(resolveUserName("user-001", { platformName: "telegram" })).toBe("user-001");
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
    expect(buildConnectionMetadata({ chatId: "", platformName: "" })).toBeUndefined();
  });

  test("omits chatId key when chatId is empty string with valid platform", () => {
    expect(buildConnectionMetadata({ platformName: "telegram", chatId: "" })).toEqual({
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

  test("excludes both chatId and platformName when platform is unrecognized", () => {
    const spy = mock(() => {});
    logger.debug = spy;
    expect(buildConnectionMetadata({ platformName: "garbage", chatId: "42" })).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  test("excludes unrecognized platformName when it is the only field", () => {
    expect(buildConnectionMetadata({ platformName: "garbage" })).toBeUndefined();
  });
});
