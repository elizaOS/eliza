/** Proves a build-pinned remote target cannot be replaced in persistence. */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPersistedActiveServer,
  clearPersistedActiveServerDurably,
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";

const PINNED_BASE = "https://fallback.example.test";

vi.mock("./runtime-url-trust", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-url-trust")>()),
  getBuildConfiguredRemoteApiBaseUrl: () => "https://fallback.example.test",
}));

describe("build-pinned remote active server", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("keeps the exact remote record when Cloud tries to replace it", () => {
    expect(
      savePersistedActiveServer({
        id: "remote:lp3-vps",
        kind: "remote",
        label: "Eliza VPS",
        apiBase: PINNED_BASE,
        accessToken: "vps-session",
      }),
    ).toBe(true);

    expect(
      savePersistedActiveServer({
        id: "cloud:personal:test",
        kind: "cloud",
        label: "Eliza",
        apiBase: "https://api.eliza.app/api/v1/eliza/agents/personal:test",
        accessToken: "cloud-session",
      }),
    ).toBe(false);

    expect(loadPersistedActiveServer()).toEqual({
      id: "remote:lp3-vps",
      kind: "remote",
      label: "Eliza VPS",
      apiBase: PINNED_BASE,
      accessToken: "vps-session",
    });
  });

  it("rejects other remote origins as well as Cloud", () => {
    expect(
      savePersistedActiveServer({
        id: "remote:other",
        kind: "remote",
        label: "Other",
        apiBase: "https://other.example.test",
        accessToken: "other-session",
      }),
    ).toBe(false);
    expect(loadPersistedActiveServer()).toBeNull();
  });

  it("keeps a tokenless pinned target when ordinary clear is requested", () => {
    savePersistedActiveServer({
      id: "remote:lp3-vps",
      kind: "remote",
      label: "Eliza VPS",
      apiBase: PINNED_BASE,
      accessToken: "vps-session",
    });

    clearPersistedActiveServer();

    expect(loadPersistedActiveServer()).toMatchObject({
      kind: "remote",
      apiBase: PINNED_BASE,
    });
    expect(loadPersistedActiveServer()?.accessToken).toBeUndefined();
  });

  it("keeps the same tokenless target through the durable clear path", async () => {
    savePersistedActiveServer({
      id: "remote:lp3-vps",
      kind: "remote",
      label: "Eliza VPS",
      apiBase: PINNED_BASE,
      accessToken: "vps-session",
    });

    await clearPersistedActiveServerDurably();

    expect(loadPersistedActiveServer()).toMatchObject({
      kind: "remote",
      apiBase: PINNED_BASE,
    });
    expect(loadPersistedActiveServer()?.accessToken).toBeUndefined();
  });
});
