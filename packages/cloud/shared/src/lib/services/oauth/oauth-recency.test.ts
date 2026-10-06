/**
 * A last-used time of epoch 0 is a real timestamp. `getTime() ||` treated it
 * as missing and ranked the connection by when it was linked.
 */

import { expect, test } from "bun:test";
import { getMostRecentActiveConnection, sortConnectionsByRecency } from "./oauth-service";
import type { OAuthConnection } from "./types";

function connection(id: string, linkedAt: string, lastUsedAt?: string): OAuthConnection {
  return {
    id,
    platform: "google",
    platformUserId: id,
    status: "active",
    scopes: [],
    linkedAt: new Date(linkedAt),
    ...(lastUsedAt === undefined ? {} : { lastUsedAt: new Date(lastUsedAt) }),
    tokenExpired: false,
    source: "platform_credentials",
  };
}

test("keeps an epoch last-used time ahead of a later link date", () => {
  const epochUsed = connection("epoch", "2026-08-01T00:00:00.000Z", "1970-01-01T00:00:00.000Z");
  const usedIn2024 = connection("recent", "2020-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");

  expect(sortConnectionsByRecency([epochUsed, usedIn2024]).map((row) => row.id)).toEqual([
    "recent",
    "epoch",
  ]);
  expect(getMostRecentActiveConnection([epochUsed, usedIn2024])?.id).toBe("recent");
});
