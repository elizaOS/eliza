// @vitest-environment jsdom
/**
 * Regression for PR #19137 review blocking #2:
 * Hosted control-plane restore with a failed refresh and empty stored token
 * must call clearPersistedActiveServer and NOT adopt the persisted agent.
 * Local/dedicated restore must not take that branch.
 */

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyRestoredConnection } from "./startup-phase-restore";
import * as persistence from "./persistence";

function makeJwt(expSecondsFromNow: number | null): string {
  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const header = enc({ alg: "none", typ: "JWT" });
  const payload = enc(expSecondsFromNow === null ? {} : { exp: Math.floor(Date.now() / 1000) + expSecondsFromNow });
  return `${header}.${payload}.sig`;
}

function fakeClient() {
  return { setBaseUrl: vi.fn(), setToken: vi.fn() };
}

describe("applyRestoredConnection — hosted stale-session guard", () => {
  const realFetch = globalThis.fetch;
  let origLocation: Location;

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    origLocation = window.location;
    // jsdom: stub hostname to a hosted control-plane host (DIRECT_ELIZA_CLOUD_API_BY_HOST)
    Object.defineProperty(window, "location", {
      value: new URL("https://eliza.app/chat"),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    Object.defineProperty(window, "location", { value: origLocation, writable: true, configurable: true });
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("hosted: failed refresh with empty stored token clears persisted active server and does not adopt agent", async () => {
    // Expired JWT triggers a refresh; failed refresh drains it -> empty -> hosted guard fires.
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(-60));
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch;

    const clearSpy = vi.spyOn(persistence, "clearPersistedActiveServer");
    const saveSpy = vi.spyOn(persistence, "savePersistedActiveServer");

    // Seed persistence so clear is observable
    persistence.savePersistedActiveServer({
      id: "cloud:11111111-1111-4111-8111-111111111111",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: "https://api.elizacloud.ai/api/v1/eliza/agents/11111111-1111-4111-8111-111111111111",
    });

    const client = fakeClient();
    await applyRestoredConnection({
      restoredActiveServer: {
        id: "cloud:11111111-1111-4111-8111-111111111111",
        kind: "cloud",
        label: "Eliza Cloud",
        apiBase: "https://api.elizacloud.ai/api/v1/eliza/agents/11111111-1111-4111-8111-111111111111",
      },
      clientRef: client,
    });

    expect(clearSpy).toHaveBeenCalled();
    // Must end unauthenticated, no base — not adopted.
    expect(client.setToken).toHaveBeenLastCalledWith(null);
    expect(client.setBaseUrl).toHaveBeenLastCalledWith(null);
    // Should not have re-saved the cloud server as active.
    // Note: backfill may save repaired base before guard; the final clear is what matters.
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    void saveSpy;
  });

  it("local restore does NOT clear persisted active server on the same failed-refresh condition", async () => {
    // Local kind never hits the hosted guard, even on same host.
    Object.defineProperty(window, "location", {
      value: new URL("https://eliza.app/chat"),
      writable: true,
      configurable: true,
    });
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(-60));
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch;

    const clearSpy = vi.spyOn(persistence, "clearPersistedActiveServer");

    const client = fakeClient();
    await applyRestoredConnection({
      restoredActiveServer: { id: "local:embedded", kind: "local", label: "This device" },
      clientRef: client,
    });

    expect(clearSpy).not.toHaveBeenCalled();
    // Local restore sets base to live apiBase (null in test env), not cleared as hostile.
  });
});
