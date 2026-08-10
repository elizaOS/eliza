/** Verifies credential-first runtime profile installation on the live client. */
// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { applyAgentProfileConnection } from "./agent-profile-connection";
import type { AgentProfile } from "./agent-profile-types";

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    apiBase: "https://11111111-1111-4111-8111-111111111111.elizacloud.ai",
    id: "cloud:11111111-1111-4111-8111-111111111111",
    kind: "cloud",
    label: "Cloud agent",
    createdAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("applyAgentProfileConnection", () => {
  it("clears an inherited bearer before selecting a tokenless target", () => {
    const calls: string[] = [];
    const setBaseUrl = vi.fn((value: string | null) =>
      calls.push(`base:${value ?? "null"}`),
    );
    const setToken = vi.fn((value: string | null) =>
      calls.push(`token:${value ?? "null"}`),
    );

    applyAgentProfileConnection(profile(), { setBaseUrl, setToken });

    expect(calls).toEqual([
      "token:null",
      "base:https://11111111-1111-4111-8111-111111111111.elizacloud.ai",
    ]);
  });

  it("installs the selected bearer before changing the target", () => {
    const calls: string[] = [];
    const setBaseUrl = vi.fn((value: string | null) =>
      calls.push(`base:${value ?? "null"}`),
    );
    const setToken = vi.fn((value: string | null) =>
      calls.push(`token:${value ?? "null"}`),
    );

    applyAgentProfileConnection(profile({ accessToken: "paired-token" }), {
      setBaseUrl,
      setToken,
    });

    expect(calls).toEqual([
      "token:null",
      "base:https://11111111-1111-4111-8111-111111111111.elizacloud.ai",
      "token:paired-token",
    ]);
  });

  it("clears both inherited bearer and base for a same-origin profile", () => {
    const setBaseUrl = vi.fn();
    const setToken = vi.fn();

    applyAgentProfileConnection(
      profile({ apiBase: "", id: "local", kind: "local", label: "Local" }),
      { setBaseUrl, setToken },
    );

    expect(setToken).toHaveBeenCalledTimes(1);
    expect(setToken).toHaveBeenCalledWith(null);
    expect(setBaseUrl).toHaveBeenCalledWith(window.location.origin);
  });
});
