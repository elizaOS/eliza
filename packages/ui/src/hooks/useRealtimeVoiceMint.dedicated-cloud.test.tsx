/**
 * Exercises the default realtime-consent path from a persisted dedicated Cloud
 * pairing through the configured control-plane transport boundary.
 */
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DEDICATED_AGENT_ID = "ef2fa8ee-1111-4222-8333-444455556666";
const DEDICATED_BASE = `https://${DEDICATED_AGENT_ID}.staging.elizacloud.ai`;
const CONTROL_PLANE_ORIGIN = "https://staging.elizacloud.ai";

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
vi.mock("../voice/shared-runtime-voice", () => ({
  configuredCloudVoiceOrigin: () => CONTROL_PLANE_ORIGIN,
}));

import { useRealtimeVoiceMint } from "./useRealtimeVoiceMint";

describe("useRealtimeVoiceMint on a dedicated Cloud pairing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
