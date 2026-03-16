/** @vitest-environment jsdom */

import {
  buildLifoPopoutUrl,
  generateLifoSessionId,
  getLifoSessionIdFromLocation,
  getLifoSyncChannelName,
  getPopoutValueFromLocation,
  isLifoPopoutModeAtLocation,
  isLifoPopoutValue,
  LIFO_SYNC_CHANNEL_PREFIX,
} from "@elizaos/app-core/platform";
import { describe, expect, it } from "vitest";

describe("isLifoPopoutValue", () => {
  it('returns true for ""', () => {
    expect(isLifoPopoutValue("")).toBe(true);
  });

  it('returns true for "1"', () => {
    expect(isLifoPopoutValue("1")).toBe(true);
  });

  it('returns true for "true"', () => {
    expect(isLifoPopoutValue("true")).toBe(true);
  });

  it('returns true for "lifo"', () => {
    expect(isLifoPopoutValue("lifo")).toBe(true);
  });

  it('returns true for case-insensitive "TRUE"', () => {
    expect(isLifoPopoutValue("TRUE")).toBe(true);
  });

  it('returns true for case-insensitive "Lifo"', () => {
    expect(isLifoPopoutValue("Lifo")).toBe(true);
  });

  it('returns true for " lifo " (with whitespace)', () => {
    expect(isLifoPopoutValue(" lifo ")).toBe(true);
  });

  it("returns false for null", () => {
    expect(isLifoPopoutValue(null)).toBe(false);
  });

  it('returns false for "false"', () => {
    expect(isLifoPopoutValue("false")).toBe(false);
  });

  it('returns false for "0"', () => {
    expect(isLifoPopoutValue("0")).toBe(false);
  });

  it('returns false for "no"', () => {
    expect(isLifoPopoutValue("no")).toBe(false);
  });

  it('returns false for "random"', () => {
    expect(isLifoPopoutValue("random")).toBe(false);
  });
});

describe("getPopoutValueFromLocation", () => {
  it("reads ?popout=lifo from search string", () => {
    expect(
      getPopoutValueFromLocation({ search: "?popout=lifo", hash: "" }),
    ).toBe("lifo");
  });

  it("reads #/lifo?popout=lifo from hash string", () => {
    expect(
      getPopoutValueFromLocation({ search: "", hash: "#/lifo?popout=lifo" }),
    ).toBe("lifo");
  });

  it("returns null when no popout param exists", () => {
    expect(getPopoutValueFromLocation({ search: "", hash: "" })).toBeNull();
  });

  it("search takes precedence over hash", () => {
    expect(
      getPopoutValueFromLocation({
        search: "?popout=1",
        hash: "#/lifo?popout=lifo",
      }),
    ).toBe("1");
  });
});

describe("isLifoPopoutModeAtLocation", () => {
  it("returns true for search ?popout=lifo", () => {
    expect(
      isLifoPopoutModeAtLocation({ search: "?popout=lifo", hash: "" }),
    ).toBe(true);
  });

  it("returns true for hash #/lifo?popout=true", () => {
    expect(
      isLifoPopoutModeAtLocation({ search: "", hash: "#/lifo?popout=true" }),
    ).toBe(true);
  });

  it("returns false for empty location", () => {
    expect(isLifoPopoutModeAtLocation({ search: "", hash: "" })).toBe(false);
  });

  it("returns false for ?popout=false", () => {
    expect(
      isLifoPopoutModeAtLocation({ search: "?popout=false", hash: "" }),
    ).toBe(false);
  });
});

describe("buildLifoPopoutUrl", () => {
  it("generates URL with ?popout=lifo param", () => {
    const url = buildLifoPopoutUrl({
      baseUrl: "http://localhost:3000/app",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("popout")).toBe("lifo");
  });

  it("includes lifoSession param when sessionId provided", () => {
    const url = buildLifoPopoutUrl({
      baseUrl: "http://localhost:3000/app",
      sessionId: "abc123",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("lifoSession")).toBe("abc123");
  });

  it("uses default /lifo path when no targetPath", () => {
    const url = buildLifoPopoutUrl({
      baseUrl: "http://localhost:3000/app",
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/lifo");
  });

  it("uses provided targetPath", () => {
    const url = buildLifoPopoutUrl({
      baseUrl: "http://localhost:3000/app",
      targetPath: "/custom/path",
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/custom/path");
  });
});

describe("generateLifoSessionId", () => {
  it("returns a 16-char hex string", () => {
    const id = generateLifoSessionId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns unique values on successive calls", () => {
    const a = generateLifoSessionId();
    const b = generateLifoSessionId();
    expect(a).not.toBe(b);
  });
});

describe("getLifoSessionIdFromLocation", () => {
  it("reads from search: ?lifoSession=abc123", () => {
    expect(
      getLifoSessionIdFromLocation({
        search: "?lifoSession=abc123",
        hash: "",
      }),
    ).toBe("abc123");
  });

  it("reads from hash: #/lifo?popout=lifo&lifoSession=abc123", () => {
    expect(
      getLifoSessionIdFromLocation({
        search: "",
        hash: "#/lifo?popout=lifo&lifoSession=abc123",
      }),
    ).toBe("abc123");
  });

  it("returns null when not present", () => {
    expect(getLifoSessionIdFromLocation({ search: "", hash: "" })).toBeNull();
  });

  it("search takes precedence over hash", () => {
    expect(
      getLifoSessionIdFromLocation({
        search: "?lifoSession=fromSearch",
        hash: "#/lifo?lifoSession=fromHash",
      }),
    ).toBe("fromSearch");
  });
});

describe("getLifoSyncChannelName", () => {
  it("returns prefixed name when sessionId given", () => {
    expect(getLifoSyncChannelName("sess42")).toBe(
      `${LIFO_SYNC_CHANNEL_PREFIX}-sess42`,
    );
  });

  it("returns base prefix when sessionId is null", () => {
    expect(getLifoSyncChannelName(null)).toBe(LIFO_SYNC_CHANNEL_PREFIX);
  });
});
