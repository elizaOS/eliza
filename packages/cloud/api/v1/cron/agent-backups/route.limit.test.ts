/** Agent-backup cron tunables reject non-canonical positive integers. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const enqueueScheduledBackups = mock(async () => ({
  candidates: 0,
  enqueued: 0,
}));
const reEnqueueFailedDeletions = mock(async () => ({
  candidates: 0,
  enqueued: 0,
}));

mock.module("@/lib/auth/cron", () => ({
  verifyCronSecret: () => null,
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueScheduledBackups,
    reEnqueueFailedDeletions,
  },
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
  enqueueScheduledBackups.mockClear();
  reEnqueueFailedDeletions.mockClear();
});

describe("agent-backups cron query integers", () => {
  test("omitted tunables still run the sweep", async () => {
    const response = await hit();
    expect(response.status).toBe(200);
    expect(enqueueScheduledBackups).toHaveBeenCalledTimes(1);
  });

  test("max=1e2 is 400 before enqueueScheduledBackups", async () => {
    const response = await hit("?max=1e2");
    expect(response.status).toBe(400);
    expect(enqueueScheduledBackups).not.toHaveBeenCalled();
  });

  test("intervalMs=007 is 400 before enqueueScheduledBackups", async () => {
    const response = await hit("?intervalMs=007");
    expect(response.status).toBe(400);
    expect(enqueueScheduledBackups).not.toHaveBeenCalled();
  });

  test("max=0x10 is 400 before enqueueScheduledBackups", async () => {
    const response = await hit("?max=0x10");
    expect(response.status).toBe(400);
    expect(enqueueScheduledBackups).not.toHaveBeenCalled();
  });

  test("canonical max=3 still reaches the sweep", async () => {
    const response = await hit("?max=3");
    expect(response.status).toBe(200);
    expect(enqueueScheduledBackups).toHaveBeenCalledWith(
      expect.objectContaining({ maxAgents: 3 }),
    );
  });
});
