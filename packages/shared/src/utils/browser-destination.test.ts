/** Exercises the shared omnibox resolver used by the Browser UI and action. */

import { describe, expect, it } from "vitest";
import {
  BrowserAddressInputError,
  buildBrowserSearchUrl,
  resolveBrowserAddressInput,
} from "./browser-destination.js";

describe("browser address resolution", () => {
  it.each([
    ["eliza", "eliza"],
    ["latest elizaOS releases", "latest elizaOS releases"],
    ["  apple laptops  ", "apple laptops"],
  ])("treats %j as a Google search", (input, query) => {
    const resolved = new URL(resolveBrowserAddressInput(input) ?? "");
    expect(resolved.origin + resolved.pathname).toBe(
      "https://www.google.com/search",
    );
    expect(resolved.searchParams.get("igu")).toBe("1");
    expect(resolved.searchParams.get("q")).toBe(query);
  });

  it.each([
    ["example.com", "https://example.com/"],
    ["docs.example.test/path", "https://docs.example.test/path"],
    ["localhost:2138/browser", "http://localhost:2138/browser"],
    ["127.0.0.1:31337/api/health", "http://127.0.0.1:31337/api/health"],
    ["devbox:3000/status", "http://devbox:3000/status"],
    ["//example.com/path", "https://example.com/path"],
    ["https://example.com/a?q=1", "https://example.com/a?q=1"],
    ["about:blank", "about:blank"],
  ])("keeps explicit address %j as a URL", (input, expected) => {
    expect(resolveBrowserAddressInput(input)).toBe(expected);
  });

  it.each(["google.com", "www.google.com", "https://www.google.com/"])(
    "uses Google's embeddable homepage for %j",
    (input) => {
      expect(resolveBrowserAddressInput(input)).toBe(
        "https://www.google.com/webhp?igu=1",
      );
    },
  );

  it("preserves Google search parameters while adding iframe compatibility", () => {
    const resolved = new URL(
      resolveBrowserAddressInput(
        "https://www.google.com/search?q=eliza&safe=active",
      ) ?? "",
    );
    expect(resolved.searchParams.get("q")).toBe("eliza");
    expect(resolved.searchParams.get("safe")).toBe("active");
    expect(resolved.searchParams.get("igu")).toBe("1");
  });

  it("rejects unsupported explicit protocols", () => {
    expect(() => resolveBrowserAddressInput("javascript:alert(1)")).toThrow(
      expect.objectContaining<Partial<BrowserAddressInputError>>({
        code: "unsupported_protocol",
      }),
    );
  });

  it("rejects an empty direct search helper query", () => {
    expect(() => buildBrowserSearchUrl("   ")).toThrow(
      BrowserAddressInputError,
    );
  });
});
