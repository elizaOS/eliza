/** Covers readCsrfTokenFromCookie against a real jsdom cookie jar; deterministic unit harness, no module mocks. */
// @vitest-environment jsdom

/**
 * The unit under test performs one synchronous read of the raw
 * `document.cookie` string, so each case seeds that jar directly and asserts
 * on the decoded token (or its deliberate absence).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readCsrfTokenFromCookie } from "./csrf-cookie";
import { CSRF_COOKIE_NAME } from "./sessions";

function setCookie(pair: string) {
  // biome-ignore lint/suspicious/noDocumentCookie: seeding the sync cookie jar the code under test reads.
  document.cookie = pair;
}

function clearCookies() {
  for (const name of [
    CSRF_COOKIE_NAME,
    "other",
    `prefixed_${CSRF_COOKIE_NAME}`,
    "ELIZA_CSRF",
  ]) {
    setCookie(`${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`);
  }
}

describe("readCsrfTokenFromCookie", () => {
  beforeEach(() => {
    clearCookies();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearCookies();
  });

  it("decodes the URL-encoded token from the readable companion cookie", () => {
    setCookie("other=value");
    setCookie(`${CSRF_COOKIE_NAME}=token%3Dwith%3Bencoded%20parts`);

    expect(readCsrfTokenFromCookie()).toBe("token=with;encoded parts");
  });

  it("returns null when only unrelated cookies exist", () => {
    setCookie("other=value");

    expect(readCsrfTokenFromCookie()).toBeNull();
  });

  it("returns null when the cookie jar is completely empty", () => {
    expect(readCsrfTokenFromCookie()).toBeNull();
  });

  it("returns null when there is no browser document at all", () => {
    vi.stubGlobal("document", undefined);

    expect(readCsrfTokenFromCookie()).toBeNull();
  });

  it("matches the cookie name case-sensitively", () => {
    setCookie(`ELIZA_CSRF=${CSRF_COOKIE_NAME}-in-different-case`);

    expect(readCsrfTokenFromCookie()).toBeNull();
  });

  it("ignores cookies whose names merely contain the CSRF name as a suffix", () => {
    setCookie(`prefixed_${CSRF_COOKIE_NAME}=noise`);

    expect(readCsrfTokenFromCookie()).toBeNull();
  });

  it("finds the real token among lookalike neighbours before it", () => {
    setCookie(`prefixed_${CSRF_COOKIE_NAME}=noise`);
    setCookie(`${CSRF_COOKIE_NAME}=real`);

    expect(readCsrfTokenFromCookie()).toBe("real");
  });

  it("finds the real token among lookalike neighbours after it", () => {
    setCookie(`${CSRF_COOKIE_NAME}=real`);
    setCookie(`prefixed_${CSRF_COOKIE_NAME}=noise`);

    expect(readCsrfTokenFromCookie()).toBe("real");
  });

  it("trims the separator whitespace the jar places between cookie parts", () => {
    setCookie("other=value");
    setCookie(`${CSRF_COOKIE_NAME}=trimmed-token`);

    // The jar serialises multiple cookies with "; ", so the CSRF part arrives
    // space-prefixed and only trimming makes the prefix match.
    expect(document.cookie).toContain("; ");
    expect(readCsrfTokenFromCookie()).toBe("trimmed-token");
  });

  it("returns the decoded empty string when the cookie value is empty", () => {
    setCookie(`${CSRF_COOKIE_NAME}=`);
    setCookie("other=value");

    expect(readCsrfTokenFromCookie()).toBe("");
  });

  it("treats a malformed percent-escape as an absent token instead of throwing", () => {
    setCookie(`${CSRF_COOKIE_NAME}=%E0%A4%A`);
    expect(() => decodeURIComponent("%E0%A4%A")).toThrow();
    setCookie("other=value");

    expect(readCsrfTokenFromCookie()).toBeNull();
  });
});
