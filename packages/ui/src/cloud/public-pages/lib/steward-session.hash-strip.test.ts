/** Verifies stripLegacyTokenHashFromAddressBar through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Legacy `#token=` / `#refreshToken=` hash links must never plant a session
 * (the same login-CSRF rule that removed the `?token=` query path) — the login
 * surface strips the credential params from the address bar without consuming
 * them. These tests pin that the strip removes exactly the credential params,
 * preserves unrelated hash params, and leaves history untouched when no
 * credential is present.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeStewardCodeFromQuery,
  consumeStewardOAuthStateFromCallback,
  stripLegacyTokenHashFromAddressBar,
} from "./steward-session";

const realLocation = window.location;

function setUrl({
  search = "",
  hash = "",
}: {
  search?: string;
  hash?: string;
}): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...realLocation, pathname: "/login", search, hash },
  });
}

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: realLocation,
  });
  delete (window as Window & { __stewardOAuthHash?: string })
    .__stewardOAuthHash;
  vi.restoreAllMocks();
});

describe("stripLegacyTokenHashFromAddressBar", () => {
  it("strips #token= and #refreshToken= from the hash and returns true", () => {
    setUrl({ hash: "#token=jwt.value.here&refreshToken=r" });
    const replaceSpy = vi.spyOn(window.history, "replaceState");

    expect(stripLegacyTokenHashFromAddressBar()).toBe(true);
    expect(replaceSpy).toHaveBeenCalledWith(null, "", "/login");
  });

  it("preserves unrelated hash params while dropping the credentials", () => {
    setUrl({ hash: "#foo=bar&token=jwt.value.here" });
    const replaceSpy = vi.spyOn(window.history, "replaceState");

    expect(stripLegacyTokenHashFromAddressBar()).toBe(true);
    expect(replaceSpy).toHaveBeenCalledWith(null, "", "/login#foo=bar");
  });

  it("keeps the query string intact while stripping the hash credential", () => {
    setUrl({ search: "?returnTo=%2Fcloud", hash: "#token=jwt.value.here" });
    const replaceSpy = vi.spyOn(window.history, "replaceState");

    expect(stripLegacyTokenHashFromAddressBar()).toBe(true);
    expect(replaceSpy).toHaveBeenCalledWith(
      null,
      "",
      "/login?returnTo=%2Fcloud",
    );
  });

  it("returns false and leaves history alone when the hash carries no credential", () => {
    setUrl({ hash: "#code=abc123" });
    const replaceSpy = vi.spyOn(window.history, "replaceState");

    expect(stripLegacyTokenHashFromAddressBar()).toBe(false);
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("returns false for an empty hash fragment", () => {
    setUrl({ hash: "#" });
    expect(stripLegacyTokenHashFromAddressBar()).toBe(false);
  });

  it("clears a snapshotted __stewardOAuthHash when it carried credentials", () => {
    setUrl({ hash: "" });
    const stewardWindow = window as Window & { __stewardOAuthHash?: string };
    stewardWindow.__stewardOAuthHash = "#token=jwt.value.here";
    const replaceSpy = vi.spyOn(window.history, "replaceState");

    expect(stripLegacyTokenHashFromAddressBar()).toBe(true);
    expect(stewardWindow.__stewardOAuthHash).toBeUndefined();
    // The snapshot stands in for an already-rewritten address bar: no second
    // history write against the live location.
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});

describe("OAuth fragment callback consumption", () => {
  it("consumes Steward's #code + #state callback without losing the state echo", () => {
    setUrl({ hash: "#code=nonce-code&state=app-state" });
    const replaceSpy = vi.spyOn(window.history, "replaceState");

    expect(consumeStewardCodeFromQuery()).toBe("nonce-code");
    expect(replaceSpy).toHaveBeenLastCalledWith(
      null,
      "",
      "/login#state=app-state",
    );
    expect(consumeStewardOAuthStateFromCallback()).toBe("app-state");
    expect(replaceSpy).toHaveBeenLastCalledWith(null, "", "/login");
  });

  it("preserves a snapshotted fragment state until the code consumer hands it off", () => {
    setUrl({ hash: "" });
    const stewardWindow = window as Window & {
      __stewardOAuthHash?: string;
    };
    stewardWindow.__stewardOAuthHash = "#code=nonce-code&state=app-state";

    expect(consumeStewardCodeFromQuery()).toBe("nonce-code");
    expect(stewardWindow.__stewardOAuthHash).toBe("#state=app-state");
    expect(consumeStewardOAuthStateFromCallback()).toBe("app-state");
    expect(stewardWindow.__stewardOAuthHash).toBeUndefined();
  });
});
