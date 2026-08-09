/**
 * Regression lock for LOGIN-FLOW-AUDIT 2026-08-09 cliff #3: on a DEDICATED
 * cloud pairing (active server = `https://<agentId>.staging.elizacloud.ai`)
 * the DEFAULT consent fetch must target the control-plane Worker — the
 * consent route does not exist in the agent container, so a relative
 * same-origin path 404s and the first voice tap dies with "Cartesia voice
 * could not confirm microphone consent".
 *
 * These tests drive the hook's REAL default fetch path (no injected `fetch`)
 * with the real persisted-server resolution mocked to the dedicated pairing
 * state, and assert on the URL that reaches the shared CSRF fetch boundary.
 * On a build without control-plane routing the consent POST arrives as the
 * relative path (which `fetchWithCsrf` then resolves against the AGENT base)
 * — exactly the live 404 — so this fails before the fix and passes after.
 */
// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const DEDICATED_AGENT_ID = "ef2fa8ee-1111-4222-8333-444455556666";
const DEDICATED_BASE = `https://${DEDICATED_AGENT_ID}.staging.elizacloud.ai`;

// The real csrf-client pulls the native (Capacitor) transport chain that is
// not resolvable in this worktree; the assertion boundary here is the URL the
// production code hands it, so a spy module is the honest seam.
const fetchWithCsrf = vi.fn(
  async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ consentNonce: "nonce-live" }), {
      status: 200,
    }),
);
vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: (url: string, init?: RequestInit) => fetchWithCsrf(url, init),
}));

// Real persisted-pairing state for the dedicated path: the active server is
// the per-agent staging subdomain and the dedicated agent id resolves.
vi.mock("../state/persistence", () => ({
  loadPersistedActiveServer: () => ({
    id: `cloud:${DEDICATED_AGENT_ID}`,
    kind: "cloud",
    label: "Eliza",
    apiBase: DEDICATED_BASE,
  }),
}));
vi.mock("../state/agent-session-recovery", () => ({
  resolveDedicatedAgentId: () => DEDICATED_AGENT_ID,
}));

// The URL resolver reads the ACTIVE api base global; pin it to the dedicated
// agent base exactly as the paired app does.
vi.mock("../utils/eliza-globals", () => ({
  getElizaApiBase: () => DEDICATED_BASE,
}));

import { useRealtimeVoiceMint } from "./useRealtimeVoiceMint";

afterEach(() => {
  fetchWithCsrf.mockClear();
  window.localStorage.clear();
});

describe("useRealtimeVoiceMint on a dedicated cloud pairing (default fetch)", () => {
  it("POSTs consent to the control-plane Worker, never the agent subdomain", async () => {
    const { result } = renderHook(() => useRealtimeVoiceMint());
    expect(result.current.agentId).toBe(DEDICATED_AGENT_ID);

    const nonce = await result.current.getConsentNonce();
    expect(nonce).toBe("nonce-live");

    expect(fetchWithCsrf).toHaveBeenCalledTimes(1);
    const [url] = fetchWithCsrf.mock.calls[0];
    // The staging dedicated base must map to the staging control-plane API
    // host. A relative path here is the 404 bug: fetchWithCsrf resolves it
    // against the agent base, where the route does not exist.
    expect(url).toBe(
      "https://api-staging.elizacloud.ai/api/v1/voice/session/consent",
    );
  });

  it("carries the Steward session bearer on the cross-origin consent call", async () => {
    window.localStorage.setItem("steward_session_token", "steward-jwt");
    const { result } = renderHook(() => useRealtimeVoiceMint());
    await result.current.getConsentNonce();

    const [, init] = fetchWithCsrf.mock.calls[0];
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer steward-jwt",
    );
  });
});
