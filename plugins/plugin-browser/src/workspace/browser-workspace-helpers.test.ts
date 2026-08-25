/**
 * Browser workspace helper tests for URL, tab, and command utility behavior.
 */

import { describe, expect, it } from "vitest";
import {
  assertBrowserWorkspaceUrl,
  inferBrowserWorkspaceTitle,
  isConnectorBrowserWorkspacePartition,
  normalizeBrowserWorkspaceText,
  normalizeEnvValue,
  parseBrowserWorkspaceNumberLike,
  resolveBrowserWorkspaceCommandPartition,
  resolveConnectorBrowserWorkspacePartition,
} from "./browser-workspace-helpers";

/**
 * Tests for the browser-workspace input helpers (#10333 / #8801). These coerce
 * untrusted command arguments (numbers, text) the browser bridge acts on, and
 * were untested.
 */
describe("parseBrowserWorkspaceNumberLike", () => {
  it("passes a finite number through", () => {
    expect(parseBrowserWorkspaceNumberLike(42)).toBe(42);
    expect(parseBrowserWorkspaceNumberLike(0)).toBe(0);
    expect(parseBrowserWorkspaceNumberLike(-3.5)).toBe(-3.5);
  });

  it("parses a numeric string (trimmed) and a leading-number string", () => {
    expect(parseBrowserWorkspaceNumberLike("  12.5 ")).toBe(12.5);
    expect(parseBrowserWorkspaceNumberLike("100")).toBe(100);
    expect(parseBrowserWorkspaceNumberLike("12px")).toBe(12); // parseFloat semantics
  });

  it("returns undefined for non-finite, non-numeric, or non-string/number input", () => {
    expect(parseBrowserWorkspaceNumberLike(Number.NaN)).toBeUndefined();
    expect(
      parseBrowserWorkspaceNumberLike(Number.POSITIVE_INFINITY),
    ).toBeUndefined();
    expect(parseBrowserWorkspaceNumberLike("abc")).toBeUndefined();
    expect(parseBrowserWorkspaceNumberLike("")).toBeUndefined();
    expect(parseBrowserWorkspaceNumberLike(null)).toBeUndefined();
    expect(parseBrowserWorkspaceNumberLike({})).toBeUndefined();
  });
});

describe("normalizeBrowserWorkspaceText", () => {
  it("collapses whitespace runs to single spaces and trims", () => {
    expect(normalizeBrowserWorkspaceText("  hello   world \n\t ")).toBe(
      "hello world",
    );
  });

  it("stringifies null/undefined to empty and coerces non-strings", () => {
    expect(normalizeBrowserWorkspaceText(null)).toBe("");
    expect(normalizeBrowserWorkspaceText(undefined)).toBe("");
    expect(normalizeBrowserWorkspaceText(42)).toBe("42");
  });
});

describe("normalizeEnvValue", () => {
  it("trims and returns null for empty/undefined/non-string", () => {
    expect(normalizeEnvValue(undefined)).toBe(null);
    expect(normalizeEnvValue("")).toBe(null);
    expect(normalizeEnvValue("   ")).toBe(null);
  });

  it("returns trimmed string for non-empty input", () => {
    expect(normalizeEnvValue("  hello  ")).toBe("hello");
    expect(normalizeEnvValue("x")).toBe("x");
  });
});

describe("assertBrowserWorkspaceUrl", () => {
  it("accepts http/https and about:blank", () => {
    expect(assertBrowserWorkspaceUrl("https://example.com")).toBe(
      "https://example.com/",
    );
    expect(assertBrowserWorkspaceUrl("http://example.com/path")).toBe(
      "http://example.com/path",
    );
    expect(assertBrowserWorkspaceUrl("about:blank")).toBe("about:blank");
    expect(assertBrowserWorkspaceUrl("  about:blank  ")).toBe("about:blank");
  });

  it("rejects non-http protocols and invalid URLs", () => {
    expect(() => assertBrowserWorkspaceUrl("ftp://example.com")).toThrow();
    expect(() => assertBrowserWorkspaceUrl("javascript:alert(1)")).toThrow();
    expect(() => assertBrowserWorkspaceUrl("not a url")).toThrow();
    expect(() => assertBrowserWorkspaceUrl("")).toThrow();
  });
});

describe("inferBrowserWorkspaceTitle", () => {
  it("strips www and returns hostname or fallbacks", () => {
    expect(inferBrowserWorkspaceTitle("about:blank")).toBe("New Tab");
    expect(inferBrowserWorkspaceTitle("https://www.example.com/path")).toBe(
      "example.com",
    );
    expect(inferBrowserWorkspaceTitle("https://example.com")).toBe(
      "example.com",
    );
    expect(inferBrowserWorkspaceTitle("not a url")).toBe("Eliza Browser");
  });
});

describe("resolveConnectorBrowserWorkspacePartition", () => {
  it("builds a connector partition with normalized segments and hash", () => {
    const partition = resolveConnectorBrowserWorkspacePartition(
      "Telegram",
      "Acct 123",
    );
    expect(partition.startsWith("persist:connector-")).toBe(true);
    expect(partition).toContain("telegram");
    expect(partition).toContain("acct-123");
  });

  it("is deterministic for same inputs", () => {
    expect(resolveConnectorBrowserWorkspacePartition("discord", "user1")).toBe(
      resolveConnectorBrowserWorkspacePartition("discord", "user1"),
    );
  });
});

describe("isConnectorBrowserWorkspacePartition", () => {
  it("detects connector partitions case-insensitively", () => {
    expect(
      isConnectorBrowserWorkspacePartition("persist:connector-telegram-x"),
    ).toBe(true);
    expect(isConnectorBrowserWorkspacePartition("PERSIST:CONNECTOR-X")).toBe(
      true,
    );
    expect(isConnectorBrowserWorkspacePartition("persist:eliza-browser")).toBe(
      false,
    );
    expect(isConnectorBrowserWorkspacePartition(null)).toBe(false);
  });
});

describe("resolveBrowserWorkspaceCommandPartition", () => {
  it("prefers explicit partition, then connector-derived, then fallback", () => {
    expect(
      resolveBrowserWorkspaceCommandPartition(
        { partition: "  custom  " } as never,
        "fallback",
      ),
    ).toBe("custom");
    expect(
      resolveBrowserWorkspaceCommandPartition(
        { connectorProvider: "telegram", connectorAccountId: "acct1" } as never,
        "fallback",
      ),
    ).toContain("persist:connector-");
    expect(
      resolveBrowserWorkspaceCommandPartition({} as never, "fallback"),
    ).toBe("fallback");
  });
});
