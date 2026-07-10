// @vitest-environment jsdom
//
/**
 * Tests for `useRealtimeVoiceMint` — resolves the realtime mint inputs (agent
 * UUID + consent nonce) from the app's real auth/runtime source. Drives the
 * REAL consent-fetch shaping through an injected fetch; agent-id validation is
 * the real UUID guard.
 */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The persistence + recovery modules pull a native (Capacitor) transport chain
// that isn't resolvable in this worktree's symlinked node_modules. Every test
// here injects `resolveAgentId`, so the real persistence path is never taken;
// mock those modules to keep the suite hermetic (this does NOT stub the code
// under test — the UUID guard + consent-fetch shaping are the real hook code).
vi.mock("../state/persistence", () => ({
  loadPersistedActiveServer: () => null,
}));
vi.mock("../state/agent-session-recovery", () => ({
  resolveDedicatedAgentId: () => null,
}));

import { useRealtimeVoiceMint } from "./useRealtimeVoiceMint";

const UUID = "33333333-3333-3333-3333-333333333333";

describe("useRealtimeVoiceMint", () => {
  it("resolves a valid dedicated agent UUID", () => {
    const { result } = renderHook(() =>
      useRealtimeVoiceMint({
        resolveAgentId: () => UUID,
        fetch: vi.fn(),
      }),
    );
    expect(result.current.agentId).toBe(UUID);
  });

  it("rejects a non-UUID agent id (the mint route 400s on it) → null", () => {
    const { result } = renderHook(() =>
      useRealtimeVoiceMint({
        resolveAgentId: () => "not-a-uuid",
        fetch: vi.fn(),
      }),
    );
    expect(result.current.agentId).toBeNull();
  });

  it("getConsentNonce returns the nonce on a 200 consent response", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ consentNonce: "nonce-abc" }), {
        status: 200,
      }),
    );
    const { result } = renderHook(() =>
      useRealtimeVoiceMint({ resolveAgentId: () => UUID, fetch }),
    );
    let nonce: string | null = "unset";
    await act(async () => {
      nonce = await result.current.getConsentNonce();
    });
    expect(nonce).toBe("nonce-abc");
    // It POSTed the consent route.
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/voice/session/consent",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("getConsentNonce returns null on a 404 (feature off) → batch fallback", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 404 }));
    const { result } = renderHook(() =>
      useRealtimeVoiceMint({ resolveAgentId: () => UUID, fetch }),
    );
    let nonce: string | null = "unset";
    await act(async () => {
      nonce = await result.current.getConsentNonce();
    });
    expect(nonce).toBeNull();
  });

  it("getConsentNonce returns null on a 503 (consent store not configured)", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 503 }));
    const { result } = renderHook(() =>
      useRealtimeVoiceMint({ resolveAgentId: () => UUID, fetch }),
    );
    let nonce: string | null = "unset";
    await act(async () => {
      nonce = await result.current.getConsentNonce();
    });
    expect(nonce).toBeNull();
  });

  it("getConsentNonce returns null (never throws) on a transport failure", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() =>
      useRealtimeVoiceMint({ resolveAgentId: () => UUID, fetch }),
    );
    let nonce: string | null = "unset";
    await act(async () => {
      nonce = await result.current.getConsentNonce();
    });
    expect(nonce).toBeNull();
  });

  it("returns null nonce when the 200 body lacks a usable nonce", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ consentNonce: "" }), { status: 200 }),
      );
    const { result } = renderHook(() =>
      useRealtimeVoiceMint({ resolveAgentId: () => UUID, fetch }),
    );
    let nonce: string | null = "unset";
    await act(async () => {
      nonce = await result.current.getConsentNonce();
    });
    expect(nonce).toBeNull();
  });
});
