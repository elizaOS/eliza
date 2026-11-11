/** Pins search, URL and refusal boundaries of the shared address-bar parser.
 * Bare literals ([::1]) are URLs like the with-port form ([::1]:8080);
 * bracketed tokens without a colon ([1], [abc]) stay search queries so
 * they are not turned into invalid-url rejections. */
import { describe, expect, it } from "vitest";

import { parseBrowserAddressInput } from "./address-input";

const OPTS = { defaultProtocol: "https:" as const };

describe("parseBrowserAddressInput", () => {
  it.each([
    ["[::1]", "https://[::1]/"],
    ["[::1]/", "https://[::1]/"],
    ["[2001:db8::1]/p?q=1#f", "https://[2001:db8::1]/p?q=1#f"],
    ["[::1]:8080", "https://[::1]:8080/"],
  ])("classifies %s as a URL", (input, href) => {
    expect(parseBrowserAddressInput(input, OPTS)).toEqual({
      kind: "url",
      href,
    });
  });

  it.each([
    ["[1]", "[1]"],
    ["[2024]", "[2024]"],
    ["[abc]", "[abc]"],
    ["[50%]", "[50%]"],
    ["[::1]junk", "[::1]junk"],
    ["[1:30]", "[1:30]"],
    ["[a:b]", "[a:b]"],
  ])("keeps %s as a search query", (input, query) => {
    expect(parseBrowserAddressInput(input, OPTS)).toEqual({
      kind: "search",
      query,
    });
  });

  it("keeps prose that only looks scheme-shaped as a search query", () => {
    for (const input of [
      "re: dinner",
      "weather: paris",
      "time: 1:30 pm",
      "Fwd: the deck",
    ]) {
      expect(parseBrowserAddressInput(input, OPTS)).toEqual({
        kind: "search",
        query: input,
      });
    }
  });

  it.each([
    "site:example.com cats",
    "site:example.com",
    "define:x",
    "define:123",
    "filetype:pdf photoelectric effect",
    "before:2026",
    "after:2025-01-01 astronomy",
    "SITE:example.com café",
  ])("keeps the search operator in %s as query text", (query) => {
    expect(parseBrowserAddressInput(query, OPTS)).toEqual({
      kind: "search",
      query,
    });
  });

  it.each([
    "site://example.com",
    "define://word",
    "javascript:alert(1)",
    "data:text/html,example",
    "file:///etc/passwd",
    "intent://example",
    "unknown:payload",
  ])("keeps explicit unsupported protocol %s rejected", (input) => {
    expect(parseBrowserAddressInput(input, OPTS)).toEqual({
      kind: "rejected",
      reason: "unsupported-protocol",
    });
  });

  it.each([
    "https://user:secret@example.com",
    "site:https://user:secret@example.com cats",
    "define:user:secret@example.com",
  ])("refuses credential-shaped input %s", (input) => {
    expect(parseBrowserAddressInput(input, OPTS).kind).toBe("rejected");
  });

  it.each([
    "site:example.com\\path",
    "site:example.com\ncats",
    "define:word\u0000",
  ])(
    "refuses ambiguous separators before operator classification in %s",
    (input) => {
      expect(parseBrowserAddressInput(input, OPTS)).toEqual({
        kind: "rejected",
        reason: "invalid-input",
      });
    },
  );

  it("still rejects a token that is a scheme with a body", () => {
    expect(parseBrowserAddressInput("javascript:alert(1)", OPTS)).toEqual({
      kind: "rejected",
      reason: "unsupported-protocol",
    });
    expect(parseBrowserAddressInput("mailto:a@b.com", OPTS)).toEqual({
      kind: "rejected",
      reason: "unsupported-protocol",
    });
    // A scheme name with no body stays a malformed address, not a search.
    expect(parseBrowserAddressInput("https:", OPTS)).toEqual({
      kind: "rejected",
      reason: "invalid-url",
    });
  });

  it("keeps other control inputs unchanged", () => {
    expect(parseBrowserAddressInput("hello world", OPTS)).toEqual({
      kind: "search",
      query: "hello world",
    });
    expect(parseBrowserAddressInput("example.com", OPTS)).toEqual({
      kind: "url",
      href: "https://example.com/",
    });
    expect(parseBrowserAddressInput("localhost:3000", OPTS)).toEqual({
      kind: "url",
      href: "https://localhost:3000/",
    });
    expect(parseBrowserAddressInput("nas:8080", OPTS)).toEqual({
      kind: "url",
      href: "https://nas:8080/",
    });
  });
});
