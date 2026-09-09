/** Exercises the real shared-agent auth gate, refresh transport and session store with synthetic HTTP responses. */
// @vitest-environment jsdom

import {
  hasStewardAuthedCookie,
  registerStewardTokenPersistence,
  STEWARD_TOKEN_KEY,
} from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../state/persistence";
import { authMe } from "./auth-client";

const agentId = "11111111-1111-4111-8111-111111111111";
const base = `https://api.eliza.app/api/v1/eliza/agents/${agentId}`;

function jwt(seconds: number): string {
  return `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds }))}.test`;
}

function selectAgent(id = agentId): void {
  const apiBase = `https://api.eliza.app/api/v1/eliza/agents/${id}`;
  savePersistedActiveServer({
    id: `cloud:${id}`,
    kind: "cloud",
    label: "Test Cloud",
    apiBase,
  });
  setBootConfig({ branding: {}, apiBase });
}

describe("shared-agent auth recovery authority", () => {
  beforeEach(() => {
    localStorage.clear();
    selectAgent();
  });
  afterEach(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: synthetic marker for the real browser cookie reader.
    document.cookie = "steward-authed=; Max-Age=0; Path=/";
    localStorage.clear();
    setBootConfig({ branding: {} });
    vi.unstubAllGlobals();
  });

  it.each([
    ["session", 200],
    ["session", 401],
    ["selection", 200],
    ["selection", 401],
    ["pagehide", 200],
    ["pagehide", 401],
  ] as const)(
    "preserves current state after %s supersedes a pending %s refresh",
    async (change, status) => {
      const stale = jwt(-60);
      localStorage.setItem(STEWARD_TOKEN_KEY, stale);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fetchMock = vi.fn(async () => {
        await held;
        return Response.json(status === 200 ? { token: jwt(1800) } : {}, {
          status,
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const result = authMe();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      let expectedToken = stale;
      if (change === "session") {
        expectedToken = jwt(3600);
        localStorage.setItem(STEWARD_TOKEN_KEY, expectedToken);
      } else if (change === "selection") {
        selectAgent("22222222-2222-4222-8222-222222222222");
      } else {
        window.dispatchEvent(new Event("pagehide"));
      }
      const expectedServer = loadPersistedActiveServer();
      release();
      expect(await result).toEqual({
        ok: false,
        status: 503,
        reason: "cloud_unavailable",
      });
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(expectedToken);
      expect(loadPersistedActiveServer()).toEqual(expectedServer);
    },
  );

  it("recovers the current expired session and preserves its agent", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, jwt(-60));
    const fresh = jwt(3600);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ token: fresh })),
    );
    expect((await authMe()).ok).toBe(true);
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(fresh);
    expect(loadPersistedActiveServer()?.apiBase).toBe(base);
  });

  it("clears only a still-current terminally expired session and binding", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, jwt(-60));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}, { status: 401 })),
    );
    expect(await authMe()).toMatchObject({
      ok: false,
      status: 401,
      reason: "remote_auth_required",
    });
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    expect(loadPersistedActiveServer()).toBeNull();
  });

  it.each([
    ["expired", "pagehide"],
    ["cookie", "pagehide"],
    ["expired", "selection"],
    ["cookie", "selection"],
  ])(
    "does not publish %s recovery after %s during persistence",
    async (source, change) => {
      const previous = source === "expired" ? jwt(-60) : null;
      if (previous) localStorage.setItem(STEWARD_TOKEN_KEY, previous);
      else {
        // biome-ignore lint/suspicious/noDocumentCookie: synthetic marker, not an actual HttpOnly login cookie.
        document.cookie = "steward-authed=1; Path=/";
        expect(hasStewardAuthedCookie()).toBe(true);
      }
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = false;
      const publish = vi.fn();
      const unregister = registerStewardTokenPersistence(
        async (token, validate, scope) => {
          entered = true;
          await held;
          validate();
          scope.commit(() => {
            publish();
            localStorage.setItem(STEWARD_TOKEN_KEY, token);
          });
        },
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ token: jwt(3600) })),
      );
      const result = authMe();
      try {
        await vi.waitFor(() => expect(entered).toBe(true));
        if (change === "pagehide") window.dispatchEvent(new Event("pagehide"));
        else selectAgent("22222222-2222-4222-8222-222222222222");
        const selected = loadPersistedActiveServer();
        release();
        expect(await result).toEqual({
          ok: false,
          status: 503,
          reason: "cloud_unavailable",
        });
        expect(publish).not.toHaveBeenCalled();
        expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(previous);
        expect(loadPersistedActiveServer()).toEqual(selected);
      } finally {
        release();
        await result;
        unregister();
      }
    },
  );
});
