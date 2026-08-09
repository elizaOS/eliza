/**
 * Verifies control-plane routing for the realtime voice-session routes
 * (consent/mint/probe): managed Eliza Cloud agent bases resolve to the
 * environment's control-plane Worker origin; every other base keeps the
 * unchanged relative same-origin path. This is the regression lock for
 * LOGIN-FLOW-AUDIT 2026-08-09 cliff #3 (fresh dedicated pairing POSTed consent
 * to the agent subdomain → 404 ×3 → "could not confirm microphone consent").
 */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

// The real csrf-client pulls the native (Capacitor) transport chain, which is
// not resolvable in this worktree's symlinked node_modules. The fetch tests
// only assert WHAT realtimeVoiceSessionFetch passes down to it, so a spy
// module is the honest boundary (URL derivation — the code under test — stays
// real).
const fetchWithCsrf = vi.fn(
  async (_url: string, _init?: RequestInit) => new Response("{}"),
);
vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: (url: string, init?: RequestInit) => fetchWithCsrf(url, init),
}));

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";

import {
  realtimeVoiceControlPlaneOrigin,
  realtimeVoiceSessionFetch,
  resolveRealtimeVoiceSessionUrl,
} from "./realtime-voice-control-plane";

const CONSENT_PATH = "/api/v1/voice/session/consent";

afterEach(() => {
  fetchWithCsrf.mockClear();
  window.localStorage.clear();
});

describe("realtimeVoiceControlPlaneOrigin", () => {
  it("maps a dedicated staging agent base to the staging API host", () => {
    expect(
      realtimeVoiceControlPlaneOrigin(
        "https://ef2fa8ee-1111-4222-8333-444455556666.staging.elizacloud.ai",
      ),
    ).toBe("https://api-staging.elizacloud.ai");
  });

  it("maps a dedicated production agent base to the production API host", () => {
    expect(
      realtimeVoiceControlPlaneOrigin(
        "https://ef2fa8ee-1111-4222-8333-444455556666.elizacloud.ai",
      ),
    ).toBe("https://api.elizacloud.ai");
  });

  it("maps a shared-tier REST adapter base to its worker origin", () => {
    expect(
      realtimeVoiceControlPlaneOrigin(
        "https://api-staging.elizacloud.ai/api/v1/eliza/agents/abc-123",
      ),
    ).toBe("https://api-staging.elizacloud.ai");
  });

  it("returns null for control-plane apex bases (same-origin already correct)", () => {
    expect(
      realtimeVoiceControlPlaneOrigin("https://api.elizacloud.ai"),
    ).toBeNull();
    expect(
      realtimeVoiceControlPlaneOrigin("https://staging.elizacloud.ai"),
    ).toBeNull();
  });

  it("returns null for self-hosted / standalone bases", () => {
    expect(
      realtimeVoiceControlPlaneOrigin("https://sol-dev.shad0w.xyz"),
    ).toBeNull();
    expect(realtimeVoiceControlPlaneOrigin("http://localhost:3000")).toBeNull();
  });

  it("returns null for blank and malformed bases", () => {
    expect(realtimeVoiceControlPlaneOrigin("")).toBeNull();
    expect(realtimeVoiceControlPlaneOrigin(null)).toBeNull();
    expect(realtimeVoiceControlPlaneOrigin(undefined)).toBeNull();
    expect(realtimeVoiceControlPlaneOrigin("not a url")).toBeNull();
  });
});

describe("resolveRealtimeVoiceSessionUrl", () => {
  it("absolutizes the consent path onto the control plane for a dedicated staging base", () => {
    expect(
      resolveRealtimeVoiceSessionUrl(
        CONSENT_PATH,
        "https://ef2fa8ee-1111-4222-8333-444455556666.staging.elizacloud.ai",
      ),
    ).toBe(`https://api-staging.elizacloud.ai${CONSENT_PATH}`);
  });

  it("absolutizes the mint path onto the control plane for a shared base", () => {
    expect(
      resolveRealtimeVoiceSessionUrl(
        "/api/v1/voice/session",
        "https://api.elizacloud.ai/api/v1/eliza/agents/abc",
      ),
    ).toBe("https://api.elizacloud.ai/api/v1/voice/session");
  });

  it("leaves the relative path unchanged for non-managed bases", () => {
    expect(
      resolveRealtimeVoiceSessionUrl(
        CONSENT_PATH,
        "https://sol-dev.shad0w.xyz",
      ),
    ).toBe(CONSENT_PATH);
    expect(resolveRealtimeVoiceSessionUrl(CONSENT_PATH, null)).toBe(
      CONSENT_PATH,
    );
  });
});

describe("realtimeVoiceSessionFetch", () => {
  it("attaches the Steward session bearer on cross-origin control-plane calls", async () => {
    window.localStorage.setItem(STEWARD_TOKEN_KEY, "steward-jwt-token");
    await realtimeVoiceSessionFetch(
      `https://api-staging.elizacloud.ai${CONSENT_PATH}`,
      { method: "POST" },
    );
    expect(fetchWithCsrf).toHaveBeenCalledTimes(1);
    const [url, init] = fetchWithCsrf.mock.calls[0];
    expect(url).toBe(`https://api-staging.elizacloud.ai${CONSENT_PATH}`);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer steward-jwt-token",
    );
  });

  it("never overwrites an explicit Authorization header", async () => {
    window.localStorage.setItem(STEWARD_TOKEN_KEY, "steward-jwt-token");
    await realtimeVoiceSessionFetch(
      `https://api.elizacloud.ai${CONSENT_PATH}`,
      { method: "POST", headers: { Authorization: "Bearer explicit" } },
    );
    const [, init] = fetchWithCsrf.mock.calls[0];
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer explicit",
    );
  });

  it("passes relative same-origin paths through untouched (no forced bearer)", async () => {
    window.localStorage.setItem(STEWARD_TOKEN_KEY, "steward-jwt-token");
    const init: RequestInit = { method: "POST" };
    await realtimeVoiceSessionFetch(CONSENT_PATH, init);
    const [url, passedInit] = fetchWithCsrf.mock.calls[0];
    expect(url).toBe(CONSENT_PATH);
    expect(passedInit).toBe(init);
  });

  it("falls back to the plain CSRF fetch when no Steward session exists", async () => {
    await realtimeVoiceSessionFetch(
      `https://api.elizacloud.ai${CONSENT_PATH}`,
      { method: "POST" },
    );
    const [, init] = fetchWithCsrf.mock.calls[0];
    expect(new Headers(init?.headers).get("Authorization")).toBeNull();
  });
});
