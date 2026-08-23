/** Verifies realtime voice-session routing and credential isolation. */
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const readStoredStewardToken = vi.fn();
const readCsrfTokenFromCookie = vi.fn();
const requestViaAgentTransport = vi.fn();
const fetchWithCsrf = vi.fn();
const fetchSameOriginWithCsrf = vi.fn();
const loadPersistedActiveServer = vi.fn();
const configuredCloudVoiceOrigin = vi.fn();
const isRealtimeVoiceForceEnabled = vi.fn();

vi.mock("@elizaos/shared/steward-session-client", () => ({
  readStoredStewardToken: () => readStoredStewardToken(),
}));
vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: (...args: unknown[]) => fetchWithCsrf(...args),
  fetchSameOriginWithCsrf: (...args: unknown[]) =>
    fetchSameOriginWithCsrf(...args),
  readCsrfTokenFromCookie: () => readCsrfTokenFromCookie(),
  requestViaAgentTransport: (...args: unknown[]) =>
    requestViaAgentTransport(...args),
}));
vi.mock("../state/persistence", () => ({
  loadPersistedActiveServer: () => loadPersistedActiveServer(),
}));
vi.mock("./shared-runtime-voice", () => ({
  configuredCloudVoiceOrigin: () => configuredCloudVoiceOrigin(),
}));
vi.mock("./realtime-voice-config", () => ({
  isRealtimeVoiceForceEnabled: () => isRealtimeVoiceForceEnabled(),
}));

import { fetchVoiceSession } from "./voice-session-fetch";

describe("fetchVoiceSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configuredCloudVoiceOrigin.mockReturnValue("https://staging.elizacloud.ai");
    requestViaAgentTransport.mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    fetchWithCsrf.mockResolvedValue(new Response(null, { status: 204 }));
    fetchSameOriginWithCsrf.mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    isRealtimeVoiceForceEnabled.mockReturnValue(false);
  });

  it("routes cloud consent to the control plane with the Steward credential", async () => {
    loadPersistedActiveServer.mockReturnValue({ kind: "cloud" });
    readStoredStewardToken.mockReturnValue("steward-token");
    readCsrfTokenFromCookie.mockReturnValue("csrf-token");

    await fetchVoiceSession("/api/v1/voice/session/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(fetchWithCsrf).not.toHaveBeenCalled();
    expect(requestViaAgentTransport).toHaveBeenCalledOnce();
    const [url, init] = requestViaAgentTransport.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://staging.elizacloud.ai/api/v1/voice/session/consent",
    );
    expect(init.credentials).toBe("include");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer steward-token");
    expect(headers.get("x-eliza-csrf")).toBe("csrf-token");
  });

  it("never substitutes the dedicated-agent bearer when Steward is absent", async () => {
    loadPersistedActiveServer.mockReturnValue({ kind: "cloud" });
    readStoredStewardToken.mockReturnValue(null);
    readCsrfTokenFromCookie.mockReturnValue(null);

    await fetchVoiceSession("/api/v1/voice/session", { method: "POST" });

    expect(requestViaAgentTransport).toHaveBeenCalledOnce();
    const [, init] = requestViaAgentTransport.mock.calls[0] as [
      string,
      RequestInit,
    ];
    const headers = new Headers(init.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(fetchWithCsrf).not.toHaveBeenCalled();
  });

  it("preserves an explicit Authorization header", async () => {
    loadPersistedActiveServer.mockReturnValue({ kind: "cloud" });
    readStoredStewardToken.mockReturnValue("steward-token");

    await fetchVoiceSession("/api/v1/voice/session", {
      method: "POST",
      headers: { Authorization: "Bearer explicit" },
    });

    const [, init] = requestViaAgentTransport.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer explicit",
    );
  });

  it("keeps forced local voice traffic on the renderer-owned proxy", async () => {
    loadPersistedActiveServer.mockReturnValue({ kind: "remote" });
    isRealtimeVoiceForceEnabled.mockReturnValue(true);

    await fetchVoiceSession("/api/v1/voice/session/consent", {
      method: "POST",
    });

    expect(fetchSameOriginWithCsrf).toHaveBeenCalledWith(
      "/api/v1/voice/session/consent",
      { method: "POST" },
    );
    expect(fetchWithCsrf).not.toHaveBeenCalled();
    expect(requestViaAgentTransport).not.toHaveBeenCalled();
  });

  it("keeps unforced self-hosted voice traffic on the selected runtime", async () => {
    loadPersistedActiveServer.mockReturnValue({ kind: "remote" });

    await fetchVoiceSession("/api/v1/voice/session/consent", {
      method: "POST",
    });

    expect(fetchWithCsrf).toHaveBeenCalledWith(
      "/api/v1/voice/session/consent",
      { method: "POST" },
    );
    expect(fetchSameOriginWithCsrf).not.toHaveBeenCalled();
  });

  it("rejects an absolute cloud target before attaching credentials", async () => {
    loadPersistedActiveServer.mockReturnValue({ kind: "cloud" });
    readStoredStewardToken.mockReturnValue("steward-token");

    await expect(
      fetchVoiceSession("https://attacker.example/voice", { method: "POST" }),
    ).rejects.toThrow("relative API path");
    expect(requestViaAgentTransport).not.toHaveBeenCalled();
  });
});
