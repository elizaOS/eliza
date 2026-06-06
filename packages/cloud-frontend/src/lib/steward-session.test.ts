import { beforeEach, describe, expect, test } from "vitest";
import { consumeStewardCodeFromQuery } from "./steward-session";

function setUrl(url: string) {
  window.history.replaceState(null, "", url);
}

describe("consumeStewardCodeFromQuery", () => {
  beforeEach(() => {
    setUrl("/login");
  });

  test("reads the code from the `?code=` query carrier and strips it", () => {
    setUrl("/login?code=QUERY_NONCE&foo=bar");
    expect(consumeStewardCodeFromQuery()).toBe("QUERY_NONCE");
    // code removed, unrelated query params preserved
    expect(window.location.search).toBe("?foo=bar");
  });

  test("reads the code from the `#code=` fragment carrier and strips it", () => {
    setUrl("/login#code=FRAGMENT_NONCE");
    expect(consumeStewardCodeFromQuery()).toBe("FRAGMENT_NONCE");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/login");
  });

  test("reads `#code=` even when other fragment params are present, keeping them", () => {
    setUrl("/login?keep=1#code=FRAGMENT_NONCE&state=xyz");
    expect(consumeStewardCodeFromQuery()).toBe("FRAGMENT_NONCE");
    // non-OAuth query + remaining fragment params survive
    expect(window.location.search).toBe("?keep=1");
    expect(window.location.hash).toBe("#state=xyz");
  });

  test("prefers the query carrier when both are present", () => {
    setUrl("/login?code=QUERY_NONCE#code=FRAGMENT_NONCE");
    expect(consumeStewardCodeFromQuery()).toBe("QUERY_NONCE");
  });

  test("returns null when no code is present (token fragment is not a code)", () => {
    setUrl("/login#token=abc");
    expect(consumeStewardCodeFromQuery()).toBeNull();
    // leaves the token fragment untouched for consumeStewardTokensFromHash
    expect(window.location.hash).toBe("#token=abc");
  });

  test("returns null on a bare URL", () => {
    setUrl("/login");
    expect(consumeStewardCodeFromQuery()).toBeNull();
  });
});
