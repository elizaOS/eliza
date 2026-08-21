/** Verifies persistActiveServerCredential through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Shared active-server credential persistence over real jsdom localStorage,
 * covering the durable server and profile records without network mocks.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  persistActiveServerCredential,
  scrubRejectedActiveServerCredential,
} from "./active-server-credential";
import { getActiveProfile } from "./agent-profiles";
import {
  createPersistedActiveServer,
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";

describe("persistActiveServerCredential", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("updates the active remote server and its active profile", async () => {
    savePersistedActiveServer(
      createPersistedActiveServer({
        kind: "cloud",
        id: "cloud:test",
        label: "Cloud Test",
        apiBase: "https://runtime.example.test",
      }),
    );

    await persistActiveServerCredential("session-token");

    expect(loadPersistedActiveServer()?.accessToken).toBe("session-token");
    expect(getActiveProfile()?.accessToken).toBe("session-token");
  });

  it("scrubs a rejected active credential without dropping the target", async () => {
    savePersistedActiveServer(
      createPersistedActiveServer({
        kind: "remote",
        apiBase: "https://runtime.example.test",
        accessToken: "stale-token",
      }),
    );
    await persistActiveServerCredential("stale-token");

    scrubRejectedActiveServerCredential("stale-token");

    expect(loadPersistedActiveServer()).toMatchObject({
      kind: "remote",
      apiBase: "https://runtime.example.test",
    });
    expect(loadPersistedActiveServer()?.accessToken).toBeUndefined();
    expect(getActiveProfile()?.accessToken).toBeUndefined();
  });
});
