/**
 * Static guard for the cloud-pair session adoption in the app entrypoint.
 * Importing `main.tsx` boots the full renderer, so this test pins the storage
 * order in source: durable PWA storage first, legacy same-tab storage second,
 * and migration back into durable storage.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MAIN_SOURCE = readFileSync(
  join(import.meta.dirname, "..", "src", "main.tsx"),
  "utf8",
);

describe("cloud pair session token adoption", () => {
  it("reads the durable token before the legacy session token", () => {
    const resolverStart = MAIN_SOURCE.indexOf(
      "function applyCloudPairSessionToken()",
    );
    const localRead = MAIN_SOURCE.indexOf(
      "window.localStorage.getItem(CLOUD_PAIR_SESSION_TOKEN_KEY)",
      resolverStart,
    );
    const sessionRead = MAIN_SOURCE.indexOf(
      "window.sessionStorage.getItem(CLOUD_PAIR_SESSION_TOKEN_KEY)",
      resolverStart,
    );

    expect(resolverStart).toBeGreaterThanOrEqual(0);
    expect(localRead).toBeGreaterThan(resolverStart);
    expect(sessionRead).toBeGreaterThan(localRead);
  });

  it("migrates a legacy session token into durable storage", () => {
    const resolverStart = MAIN_SOURCE.indexOf(
      "function applyCloudPairSessionToken()",
    );
    const sessionRead = MAIN_SOURCE.indexOf(
      "window.sessionStorage.getItem(CLOUD_PAIR_SESSION_TOKEN_KEY)",
      resolverStart,
    );
    const durableWrite = MAIN_SOURCE.indexOf(
      "window.localStorage.setItem(CLOUD_PAIR_SESSION_TOKEN_KEY, token)",
      sessionRead,
    );

    expect(sessionRead).toBeGreaterThan(resolverStart);
    expect(durableWrite).toBeGreaterThan(sessionRead);
  });
});
