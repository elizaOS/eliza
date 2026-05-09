// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  createPersistedActiveServer,
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";
import { canRestoreActiveServer } from "./startup-phase-restore";

describe("Cloud active server persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("does not persist the Eliza Cloud control plane as a runtime API base", () => {
    const server = createPersistedActiveServer({
      kind: "cloud",
      apiBase: "https://api.elizacloud.ai/",
      accessToken: "cloud-token",
    });

    expect(server.apiBase).toBeUndefined();
    expect(server.accessToken).toBe("cloud-token");

    savePersistedActiveServer(server);

    expect(loadPersistedActiveServer()).toEqual(
      expect.objectContaining({
        kind: "cloud",
        label: "Eliza Cloud",
        accessToken: "cloud-token",
      }),
    );
    expect(loadPersistedActiveServer()?.apiBase).toBeUndefined();
  });

  it("normalizes legacy saved Cloud control-plane records", () => {
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "cloud:https://api.elizacloud.ai",
        kind: "cloud",
        label: "Eliza Cloud",
        apiBase: "https://api.elizacloud.ai",
        accessToken: "cloud-token",
      }),
    );

    const restored = loadPersistedActiveServer();

    expect(restored).toEqual(
      expect.objectContaining({
        kind: "cloud",
        accessToken: "cloud-token",
      }),
    );
    expect(restored?.apiBase).toBeUndefined();
  });

  it("does not restore Cloud sessions without a runtime bridge URL", () => {
    expect(
      canRestoreActiveServer({
        server: {
          id: "cloud:https://api.elizacloud.ai",
          kind: "cloud",
          label: "Eliza Cloud",
          accessToken: "cloud-token",
        },
        clientApiAvailable: true,
        forceLocal: false,
        isDesktop: false,
      }),
    ).toBe(false);
  });
});
