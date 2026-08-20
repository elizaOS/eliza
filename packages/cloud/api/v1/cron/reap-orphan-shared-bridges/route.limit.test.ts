/** Orphan-bridge cron tunables reject non-canonical positive integers. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const reapOrphanedSharedBridges = mock(async () => ({
  candidates: 0,
  reaped: 0,
}));

mock.module("@/lib/auth/cron", () => ({
  verifyCronSecret: () => null,
}));

mock.module("@/lib/services/orphan-shared-bridge-reaper", () => ({
  reapOrphanedSharedBridges,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const { default: app } = await import("./route");

function hit(query = "") {
  return app.fetch(
    new Request(`https://api.example.test/${query}`, { method: "POST" }),
    { CRON_SECRET: "cron-secret" },
  );
}

beforeEach(() => {
  reapOrphanedSharedBridges.mockClear();
});

describe("reap-orphan-shared-bridges cron query integers", () => {
  test("omitted tunables still run the sweep", async () => {
    const response = await hit();
    expect(response.status).toBe(200);
    expect(reapOrphanedSharedBridges).toHaveBeenCalledTimes(1);
  });

  test("max=1e2 is 400 before reapOrphanedSharedBridges", async () => {
    const response = await hit("?max=1e2");
    expect(response.status).toBe(400);
    expect(reapOrphanedSharedBridges).not.toHaveBeenCalled();
  });

  test("minAgeMs=007 is 400 before reapOrphanedSharedBridges", async () => {
    const response = await hit("?minAgeMs=007");
    expect(response.status).toBe(400);
    expect(reapOrphanedSharedBridges).not.toHaveBeenCalled();
  });

  test("max=0x10 is 400 before reapOrphanedSharedBridges", async () => {
    const response = await hit("?max=0x10");
    expect(response.status).toBe(400);
    expect(reapOrphanedSharedBridges).not.toHaveBeenCalled();
  });

  test("canonical max=3 still reaches the sweep", async () => {
    const response = await hit("?max=3");
    expect(response.status).toBe(200);
    expect(reapOrphanedSharedBridges).toHaveBeenCalledWith(
      expect.objectContaining({ max: 3 }),
    );
  });
});
