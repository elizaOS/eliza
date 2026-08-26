/** Exercises strict fallback-origin validation and real browser persistence. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("installs the fallback as a completed remote runtime", async () => {
    await expect(installMobileRemoteFallback(FALLBACK_ENV)).resolves.toBe(true);
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

  it("preserves a paired credential only for the exact fallback origin", async () => {
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

    await installMobileRemoteFallback(FALLBACK_ENV);

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
    await installMobileRemoteFallback(FALLBACK_ENV);
    expect(
      JSON.parse(localStorage.getItem("elizaos:active-server") ?? "null"),
    ).toMatchObject({
      apiBase: FALLBACK_BASE,
      accessToken: "paired-session",
    });
  });

  it("pins the live client to the authoritative target before rendering", async () => {
    const client = {
      setBaseUrl: vi.fn(),
      setToken: vi.fn(),
    };

    await installMobileRemoteFallback(FALLBACK_ENV, client);

    expect(client.setBaseUrl).toHaveBeenCalledWith(FALLBACK_BASE);
    expect(client.setToken).toHaveBeenCalledWith(null);
  });

  it("replaces a stale active Cloud profile instead of copying its token", async () => {
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "cloud:personal:test",
        kind: "cloud",
        label: "Eliza",
        apiBase: "https://api.eliza.app/api/v1/eliza/agents/personal:test",
        accessToken: "cloud-session",
      }),
    );
    localStorage.setItem(
      "elizaos:agent-profiles",
      JSON.stringify({
        version: 1,
        activeProfileId: "cloud-profile",
        profiles: [
          {
            id: "cloud-profile",
            kind: "cloud",
            label: "Eliza",
            apiBase: "https://api.eliza.app/api/v1/eliza/agents/personal:test",
            accessToken: "cloud-session",
            createdAt: "2026-08-26T00:00:00.000Z",
          },
        ],
      }),
    );

    await installMobileRemoteFallback(FALLBACK_ENV);

    const registry = JSON.parse(
      localStorage.getItem("elizaos:agent-profiles") ?? "null",
    );
    expect(registry.profiles).toHaveLength(1);
    expect(registry.profiles[0]).toMatchObject({
      kind: "remote",
      apiBase: FALLBACK_BASE,
    });
    expect(registry.profiles[0]).not.toHaveProperty("accessToken");
    expect(registry.activeProfileId).toBe(registry.profiles[0].id);
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
