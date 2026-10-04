import { describe, expect, it } from "vitest";
import { parseBrowserAddressInput } from "./address-input";

const parse = (input: string) =>
  parseBrowserAddressInput(input, { defaultProtocol: "https:" });

describe("browser address input", () => {
  it.each([
    [" example.org/path?q=yes#part ", "https://example.org/path?q=yes#part"],
    ["example.org:8443/path", "https://example.org:8443/path"],
    ["//example.org/path", "https://example.org/path"],
    ["http://example.org", "http://example.org/"],
    ["https://EXAMPLE.ORG", "https://example.org/"],
    ["https://[::1]:8443/", "https://[::1]:8443/"],
    ["bücher.de", "https://xn--bcher-kva.de/"],
  ])("classifies %s without changing explicit protocols", (input, href) => {
    expect(parse(input)).toEqual({ kind: "url", href });
  });
  it("requires the host to select the inferred protocol", () => {
    expect(
      parseBrowserAddressInput("//example.org", { defaultProtocol: "http:" }),
    ).toEqual({ kind: "url", href: "http://example.org/" });
  });
  it.each([
    "Google",
    "constructor",
    "local power company",
    "word/path",
    "one two.org",
  ])("leaves aliases and search routing to the host: %s", (query) => {
    expect(parse(`  ${query}  `)).toEqual({ kind: "search", query });
  });
  it.each([
    ["", "empty"],
    ["  ", "empty"],
    ["exa\nmple.org", "invalid-input"],
    ["https://example.org\\@evil.org", "invalid-input"],
    ["word\u0000suffix", "invalid-input"],
    ["word\u007fsuffix", "invalid-input"],
    ["user@example.org", "credentials"],
    ["someone@localhost", "credentials"],
    ["https://user:secret@example.org", "credentials"],
    ["javascript:alert(1)", "unsupported-protocol"],
    ["data:text/html,hi", "unsupported-protocol"],
    ["file:///tmp/a", "unsupported-protocol"],
    ["ftp://example.org", "unsupported-protocol"],
    ["https://", "invalid-url"],
    ["example.org:99999", "invalid-url"],
  ])("rejects %s rather than turning it into a search", (input, reason) => {
    expect(parse(input)).toEqual({ kind: "rejected", reason });
  });
});
