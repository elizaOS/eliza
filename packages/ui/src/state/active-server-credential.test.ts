// @vitest-environment jsdom

/**
 * Shared active-server credential persistence over real jsdom localStorage,
 * covering the durable server and profile records without network mocks.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { persistActiveServerCredential } from "./active-server-credential";
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

  it("updates the active remote server and its active profile", () => {
    savePersistedActiveServer(
      createPersistedActiveServer({
        kind: "cloud",
        id: "cloud:test",
        label: "Cloud Test",
        apiBase: "https://runtime.example.test",
      }),
    );

    persistActiveServerCredential("session-token");

    expect(loadPersistedActiveServer()?.accessToken).toBe("session-token");
    expect(getActiveProfile()?.accessToken).toBe("session-token");
  });
});
