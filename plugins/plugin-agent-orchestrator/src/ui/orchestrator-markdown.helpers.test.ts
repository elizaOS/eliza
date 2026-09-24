// Coverage for the markdown URL sanitizer that keeps unsafe-scheme links out of
// the rendered chat AST. This is a security boundary (javascript:/data: links
// in agent-authored markdown must never become live hrefs), so the allowlist is
// pinned here.

import { describe, expect, it } from "vitest";
import { sanitizeMarkdownUrl } from "./orchestrator-markdown.helpers";

describe("sanitizeMarkdownUrl", () => {
  it("returns null for empty / whitespace / undefined", () => {
    expect(sanitizeMarkdownUrl(undefined)).toBeNull();
    expect(sanitizeMarkdownUrl("")).toBeNull();
    expect(sanitizeMarkdownUrl("   ")).toBeNull();
  });

  it("allows relative and anchor forms (but not protocol-relative //)", () => {
    expect(sanitizeMarkdownUrl("/abs/path")).toBe("/abs/path");
    expect(sanitizeMarkdownUrl("./rel")).toBe("./rel");
    expect(sanitizeMarkdownUrl("../up")).toBe("../up");
    expect(sanitizeMarkdownUrl("#anchor")).toBe("#anchor");
    expect(sanitizeMarkdownUrl("//evil.com")).toBeNull();
  });

  it("allows only http/https/mailto absolute URLs (trimmed)", () => {
    expect(sanitizeMarkdownUrl("https://ok.com/x")).toBe("https://ok.com/x");
    expect(sanitizeMarkdownUrl("  http://ok.com  ")).toBe("http://ok.com");
    expect(sanitizeMarkdownUrl("mailto:a@b.com")).toBe("mailto:a@b.com");
  });

  it("rejects unsafe schemes (javascript / data / ftp)", () => {
    expect(sanitizeMarkdownUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeMarkdownUrl("data:text/html,<script>")).toBeNull();
    expect(sanitizeMarkdownUrl("ftp://host/file")).toBeNull();
  });
});
