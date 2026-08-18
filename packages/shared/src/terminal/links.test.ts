/**
 * Tests for OSC-8 terminal hyperlinks and docs link formatting.
 */
import { describe, expect, it } from "vitest";
import { formatDocsLink, formatTerminalLink } from "./links.ts";

describe("formatTerminalLink", () => {
  it("formats OSC-8 hyperlink sequence when force is enabled", () => {
    const result = formatTerminalLink(
      "Eliza Documentation",
      "https://docs.eliza.ai",
      {
        force: true,
      },
    );
    expect(result).toBe(
      "\u001b]8;;https://docs.eliza.ai\u0007Eliza Documentation\u001b]8;;\u0007",
    );
  });

  it("returns fallback format when force is disabled and not in TTY", () => {
    const result = formatTerminalLink("Eliza", "https://eliza.ai", {
      force: false,
    });
    expect(result).toBe("Eliza (https://eliza.ai)");
  });

  it("uses custom fallback option when provided and not in TTY", () => {
    const result = formatTerminalLink("Eliza", "https://eliza.ai", {
      force: false,
      fallback: "custom fallback text",
    });
    expect(result).toBe("custom fallback text");
  });

  it("strips ESC characters from label and url to prevent ANSI injection", () => {
    const maliciousLabel = "Click\u001b[31m Here";
    const maliciousUrl = "https://evil.com/\u001b[0m";
    const result = formatTerminalLink(maliciousLabel, maliciousUrl, {
      force: true,
    });
    expect(result).not.toContain("\u001b[31m");
    expect(result).not.toContain("\u001b[0m");
    expect(result).toBe(
      "\u001b]8;;https://evil.com/[0m\u0007Click[31m Here\u001b]8;;\u0007",
    );
  });

  it("handles non-string inputs safely without throwing", () => {
    const result = formatTerminalLink(
      null as unknown as string,
      undefined as unknown as string,
      { force: false },
    );
    expect(result).toBe(" ()");
  });
});

describe("formatDocsLink", () => {
  it("resolves relative paths with and without leading slash to docs.eliza.ai", () => {
    const withSlash = formatDocsLink("/cli/start", undefined, { force: false });
    expect(withSlash).toBe("https://docs.eliza.ai/cli/start");

    const withoutSlash = formatDocsLink("cli/start", "Start CLI", {
      force: false,
    });
    expect(withoutSlash).toBe("Start CLI (https://docs.eliza.ai/cli/start)");
  });

  it("preserves external HTTP/HTTPS URLs", () => {
    const external = formatDocsLink(
      "https://github.com/elizaOS/eliza",
      "GitHub Repo",
      { force: false },
    );
    expect(external).toBe("GitHub Repo (https://github.com/elizaOS/eliza)");
  });

  it("handles nullish or non-string paths safely", () => {
    const result = formatDocsLink(null as unknown as string, undefined, {
      force: false,
    });
    expect(result).toBe("https://docs.eliza.ai/");
  });
});
