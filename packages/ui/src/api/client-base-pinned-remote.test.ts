/** Proves a dedicated remote build cannot drift its live client to Cloud. */
// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost/"}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savePersistedActiveServer } from "../state/persistence";
import { ElizaClient } from "./client-base";

const PINNED_BASE = "https://fallback.example.test";

vi.mock("../state/runtime-url-trust", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/runtime-url-trust")>()),
  getBuildConfiguredRemoteApiBaseUrl: () => "https://fallback.example.test",
}));

function persistPinnedCredential(token: string): void {
  savePersistedActiveServer({
    id: "remote:lp3-vps",
    kind: "remote",
    label: "Eliza VPS",
    apiBase: PINNED_BASE,
    accessToken: token,
  });
}

describe("ElizaClient build-pinned remote target", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("starts on the pinned target and ignores an unrelated constructor token", () => {
    const client = new ElizaClient(
      "https://api.eliza.app/api/v1/eliza/agents/personal:test",
      "cloud-session",
    );

    expect(client.getBaseUrl()).toBe(PINNED_BASE);
    expect(client.getRestAuthToken()).toBeNull();
  });

  it("rejects a Cloud base and the credential that follows it", () => {
    persistPinnedCredential("vps-session");
    const client = new ElizaClient(PINNED_BASE, "vps-session");
    const authorityRevisions: number[] = [];
    client.onAuthorityChange(() => {
      authorityRevisions.push(client.getAuthorityRevision());
    });

    client.setBaseUrl(
      "https://api.eliza.app/api/v1/eliza/agents/personal:test",
      { persist: false },
    );
    client.setToken("cloud-session");

    expect(client.getBaseUrl()).toBe(PINNED_BASE);
    expect(client.getRestAuthToken()).toBe("vps-session");
    expect(authorityRevisions).toEqual([]);
  });

  it("rejects an atomic Cloud repoint without opening a connection", () => {
    const sockets: string[] = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor(url: string) {
          sockets.push(url);
        }
      },
    );
    persistPinnedCredential("vps-session");
    const client = new ElizaClient(PINNED_BASE, "vps-session");

    client.repointBaseUrl(
      "https://api.eliza.app/api/v1/eliza/agents/personal:test",
      "cloud-session",
    );

    expect(client.getBaseUrl()).toBe(PINNED_BASE);
    expect(client.getRestAuthToken()).toBe("vps-session");
    expect(sockets).toEqual([]);
  });

  it("rejects a delayed Cloud credential even after the pinned base is reaffirmed", () => {
    persistPinnedCredential("vps-session");
    const client = new ElizaClient(PINNED_BASE, "vps-session");

    client.setBaseUrl(
      "https://api.eliza.app/api/v1/eliza/agents/personal:test",
      { persist: false },
    );
    client.setBaseUrl(PINNED_BASE, { persist: false });
    client.setToken("cloud-session");

    expect(client.getBaseUrl()).toBe(PINNED_BASE);
    expect(client.getRestAuthToken()).toBe("vps-session");
  });

  it("accepts a newly paired bearer after exact-origin persistence", () => {
    persistPinnedCredential("old-vps-session");
    const client = new ElizaClient(PINNED_BASE, "old-vps-session");
    const authorityRevisions: number[] = [];
    client.onAuthorityChange(() => {
      authorityRevisions.push(client.getAuthorityRevision());
    });

    persistPinnedCredential("new-vps-session");
    client.setToken("new-vps-session");

    expect(client.getRestAuthToken()).toBe("new-vps-session");
    expect(authorityRevisions).toEqual([1]);
  });
});
