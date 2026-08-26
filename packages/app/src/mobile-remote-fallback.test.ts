/** Exercises strict fallback-origin validation and real browser persistence. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installMobileRemoteFallback,
  resolveMobileRemoteFallbackApiBase,
} from "./mobile-remote-fallback";

const FALLBACK_BASE = "https://fallback.example.test";

const FALLBACK_ENV = {
  VITE_ELIZA_REMOTE_FALLBACK_API_BASE: FALLBACK_BASE,
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("resolveMobileRemoteFallbackApiBase", () => {
  it("normalizes one credential-free root HTTPS origin", () => {
    expect(
      resolveMobileRemoteFallbackApiBase({
        VITE_ELIZA_REMOTE_FALLBACK_API_BASE: "https://fallback.example.test/",
      }),
    ).toBe("https://fallback.example.test");
  });

  it("installs the fallback as a completed remote runtime", () => {
    expect(installMobileRemoteFallback(FALLBACK_ENV)).toBe(true);
    expect(
      JSON.parse(localStorage.getItem("elizaos:active-server") ?? "null"),
    ).toEqual({
      id: "remote:lp3-vps",
      kind: "remote",
      label: "Eliza VPS",
      apiBase: FALLBACK_BASE,
    });
    expect(localStorage.getItem("eliza:mobile-runtime-mode")).toBe(
      "remote-mac",
    );
    expect(localStorage.getItem("eliza:first-run-complete")).toBe("1");
  });

  it("preserves a paired credential only for the exact fallback origin", () => {
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "old-id",
        kind: "remote",
        label: "Old label",
        apiBase: `${FALLBACK_BASE}/`,
        accessToken: "paired-session",
      }),
    );

    installMobileRemoteFallback(FALLBACK_ENV);

    expect(
      JSON.parse(localStorage.getItem("elizaos:active-server") ?? "null"),
    ).toMatchObject({
      id: "remote:lp3-vps",
      apiBase: FALLBACK_BASE,
      accessToken: "paired-session",
    });

    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "attacker",
        kind: "remote",
        label: "Other",
        apiBase: "https://other.example.test",
        accessToken: "must-not-survive",
      }),
    );
    installMobileRemoteFallback(FALLBACK_ENV);
    expect(
      JSON.parse(localStorage.getItem("elizaos:active-server") ?? "null"),
    ).not.toHaveProperty("accessToken");
  });

  it("is disabled when the build variable is absent", () => {
    expect(resolveMobileRemoteFallbackApiBase({})).toBeNull();
  });

  it.each([
    "http://fallback.example.test",
    "https://fallback.example.test:8443",
    "https://user:pass@fallback.example.test",
    "https://fallback.example.test/api",
    "https://fallback.example.test/?target=other",
    "not-a-url",
  ])("rejects a widened or malformed target: %s", (value) => {
    expect(() =>
      resolveMobileRemoteFallbackApiBase({
        VITE_ELIZA_REMOTE_FALLBACK_API_BASE: value,
      }),
    ).toThrow(/root HTTPS origin|valid HTTPS origin/);
  });
});
