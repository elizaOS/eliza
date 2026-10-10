/** Pins the bracketed-IPv6 classification of the address-bar parser.
 * Bare literals ([::1]) are URLs like the with-port form ([::1]:8080);
 * bracketed tokens without a colon ([1], [abc]) stay search queries so
 * they are not turned into invalid-url rejections. */
import { describe, expect, it } from "vitest";

import { parseBrowserAddressInput } from "./address-input";

const OPTS = { defaultProtocol: "https:" as const };

describe("parseBrowserAddressInput bracketed IPv6", () => {
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
  ])("keeps %s as a search query", (input, query) => {
    expect(parseBrowserAddressInput(input, OPTS)).toEqual({
      kind: "search",
      query,
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
  });
});
