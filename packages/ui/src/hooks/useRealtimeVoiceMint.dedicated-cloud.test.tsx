/**
 * Exercises the default realtime-consent path from a persisted dedicated Cloud
 * pairing through the configured control-plane transport boundary.
 */
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DEDICATED_AGENT_ID = "ef2fa8ee-1111-4222-8333-444455556666";
const DEDICATED_BASE = `https://${DEDICATED_AGENT_ID}.staging.elizacloud.ai`;
const PERSONAL_SHARED_AGENT_ID = "1e2fa8ee-1111-4222-8333-444455556667";
const PERSONAL_SHARED_BASE = `https://staging.elizacloud.ai/api/v1/eliza/agents/${PERSONAL_SHARED_AGENT_ID}`;
const CONTROL_PLANE_ORIGIN = "https://staging.elizacloud.ai";

const loadPersistedActiveServer = vi.fn();
const readStoredStewardToken = vi.fn();
const readCsrfTokenFromCookie = vi.fn();
const requestViaAgentTransport = vi.fn();
const fetchWithCsrf = vi.fn();

vi.mock("@elizaos/shared/steward-session-client", () => ({
  readStoredStewardToken: () => readStoredStewardToken(),
}));
vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: (...args: unknown[]) => fetchWithCsrf(...args),
  readCsrfTokenFromCookie: () => readCsrfTokenFromCookie(),
  requestViaAgentTransport: (...args: unknown[]) =>
    requestViaAgentTransport(...args),
}));
vi.mock("../state/persistence", () => ({
  loadPersistedActiveServer: () => loadPersistedActiveServer(),
}));
vi.mock("../voice/shared-runtime-voice", () => ({
  configuredCloudVoiceOrigin: () => CONTROL_PLANE_ORIGIN,
}));

import { useRealtimeVoiceMint } from "./useRealtimeVoiceMint";

describe("useRealtimeVoiceMint on a dedicated Cloud pairing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadPersistedActiveServer.mockReturnValue({
      id: `cloud:${DEDICATED_AGENT_ID}`,
      kind: "cloud",
      label: "Eliza",
      apiBase: DEDICATED_BASE,
    });
    readStoredStewardToken.mockReturnValue("steward-token");
    readCsrfTokenFromCookie.mockReturnValue("csrf-token");
    requestViaAgentTransport.mockResolvedValue(
      new Response(JSON.stringify({ consentNonce: "nonce-live" }), {
        status: 200,
      }),
    );
  });

  it("uses the configured control-plane transport on the real default hook path", async () => {
    const { result } = renderHook(() => useRealtimeVoiceMint());
    expect(result.current.agentId).toBe(DEDICATED_AGENT_ID);

    let nonce: string | null = null;
    await act(async () => {
      nonce = await result.current.getConsentNonce();
    });

    expect(nonce).toBe("nonce-live");
    expect(fetchWithCsrf).not.toHaveBeenCalled();
    expect(requestViaAgentTransport).toHaveBeenCalledOnce();
    const [url, init] = requestViaAgentTransport.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${CONTROL_PLANE_ORIGIN}/api/v1/voice/session/consent`);
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer steward-token",
    );
  });

  it("resolves the rowless personal Shared profile through the same default voice path", async () => {
    loadPersistedActiveServer.mockReturnValue({
      id: `cloud:${PERSONAL_SHARED_AGENT_ID}`,
      kind: "cloud",
      label: "Eliza",
      apiBase: PERSONAL_SHARED_BASE,
    });

    const { result } = renderHook(() => useRealtimeVoiceMint());
    expect(result.current.agentId).toBe(PERSONAL_SHARED_AGENT_ID);

    await act(async () => {
      expect(await result.current.getConsentNonce()).toBe("nonce-live");
    });

    expect(requestViaAgentTransport).toHaveBeenCalledOnce();
    expect(requestViaAgentTransport.mock.calls[0]?.[0]).toBe(
      `${CONTROL_PLANE_ORIGIN}/api/v1/voice/session/consent`,
    );
  });
});
