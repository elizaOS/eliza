/** Proves a runtime-published Android target hardens an already-created client. */
// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost/"}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import {
  clearPersistedActiveServer,
  savePersistedActiveServer,
} from "../state/persistence";
import { installBuildConfiguredRemoteApiBaseUrl } from "../state/runtime-url-trust";
import { ElizaClient } from "./client-base";

const PINNED_BASE = "https://fallback.example.test";
const CLOUD_BASE = "https://api.eliza.app/api/v1/eliza/agents/personal:test";
const RUNTIME_PIN_KEY = "__ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__";

type RuntimePinGlobal = typeof globalThis & {
  __ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__?: unknown;
};

function clearRuntimePin(): void {
  Reflect.deleteProperty(globalThis as RuntimePinGlobal, RUNTIME_PIN_KEY);
}

describe("ElizaClient late build-pinned remote target", () => {
  beforeEach(() => {
    clearRuntimePin();
    setBootConfig({ branding: {} });
    localStorage.clear();
    clearPersistedActiveServer();
  });

  afterEach(() => {
    clearRuntimePin();
    localStorage.clear();
    clearPersistedActiveServer();
    vi.restoreAllMocks();
  });

  it("fails closed when the pin is published after client construction", async () => {
    const client = new ElizaClient(CLOUD_BASE, "cloud-session");
    const requests: Array<{ authorization: string | null; url: string }> = [];
    const webSocket = vi.fn();
    vi.stubGlobal("WebSocket", webSocket);
    client.setRequestTransport({
      async request(url, init) {
        requests.push({
          authorization: new Headers(init.headers).get("authorization"),
          url,
        });
        return Response.json({ ok: true });
      },
    });
    const baseChanges: string[] = [];
    const authorityChanges: Array<[string, number]> = [];
    client.onBaseUrlChange((baseUrl) => baseChanges.push(baseUrl));
    client.onAuthorityChange(() => {
      authorityChanges.push([
        client.getBaseUrl(),
        client.getAuthorityRevision(),
      ]);
    });

    expect(client.getBaseUrl()).toBe(CLOUD_BASE);
    expect(client.getRestAuthToken()).toBe("cloud-session");

    installBuildConfiguredRemoteApiBaseUrl(PINNED_BASE);

    // Publishing the immutable target immediately clamps request authority,
    // even before the bootstrap flow finishes persisting its paired bearer.
    expect(client.getBaseUrl()).toBe(PINNED_BASE);
    expect(client.getRestAuthToken()).toBeNull();

    await client.rawRequest("/api/ping");
    expect(requests).toEqual([
      { authorization: null, url: `${PINNED_BASE}/api/ping` },
    ]);

    client.setBaseUrl(CLOUD_BASE, { persist: false });
    client.setToken("cloud-session");
    client.repointBaseUrl(CLOUD_BASE, "cloud-session");

    expect(baseChanges).toEqual([]);
    expect(authorityChanges).toEqual([]);
    expect(webSocket).not.toHaveBeenCalled();

    savePersistedActiveServer({
      id: "remote:lp3-vps",
      kind: "remote",
      label: "Eliza VPS",
      apiBase: PINNED_BASE,
      accessToken: "vps-session",
    });
    client.setBaseUrl(PINNED_BASE, { persist: false });
    client.setToken("vps-session");

    expect(client.getBaseUrl()).toBe(PINNED_BASE);
    expect(client.getRestAuthToken()).toBe("vps-session");
    expect(baseChanges).toEqual([PINNED_BASE]);
    expect(authorityChanges).toEqual([
      [PINNED_BASE, 0],
      [PINNED_BASE, 1],
    ]);

    await client.rawRequest("/api/ping");
    expect(requests.at(-1)).toEqual({
      authorization: "Bearer vps-session",
      url: `${PINNED_BASE}/api/ping`,
    });

    client.setBaseUrl(CLOUD_BASE, { persist: false });
    client.setToken("cloud-session");
    client.repointBaseUrl(CLOUD_BASE, "cloud-session");

    expect(client.getBaseUrl()).toBe(PINNED_BASE);
    expect(client.getRestAuthToken()).toBe("vps-session");
    expect(baseChanges).toEqual([PINNED_BASE]);
    expect(authorityChanges).toEqual([
      [PINNED_BASE, 0],
      [PINNED_BASE, 1],
    ]);
    expect(webSocket).not.toHaveBeenCalled();
  });
});
