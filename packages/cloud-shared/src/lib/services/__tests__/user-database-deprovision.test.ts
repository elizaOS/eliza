/**
 * #8342 — a deleted app with an ISOLATED tenant DB must release it. The DROP
 * needs `pg`, which the cloud-api Worker can't load, so the Worker-side
 * cleanupDatabase ENQUEUES a daemon job instead of silently no-opping. These
 * tests pin that enqueue seam: it fires only when there is an isolated URI, an
 * enqueuer is wired, and an owning org is known.
 */

import { describe, expect, mock, test } from "bun:test";

const findStateByAppIdForWrite = mock();
mock.module("../../../db/repositories/app-databases", () => ({
  appDatabasesRepository: { findStateByAppIdForWrite },
}));

import { UserDatabaseService } from "../user-database";

type Enqueued = {
  appId: string;
  dbUri: string;
  organizationId: string;
  userId?: string;
};

function makeService(): { svc: UserDatabaseService; enqueued: Enqueued[] } {
  const enqueued: Enqueued[] = [];
  const svc = new UserDatabaseService(); // no pg backend == the Worker singleton
  svc.setDeprovisionEnqueuer(async (p) => {
    enqueued.push(p as Enqueued);
  });
  return { svc, enqueued };
}

describe("cleanupDatabase — isolated tenant DB teardown enqueue", () => {
  test("enqueues a deprovision job carrying the ENCRYPTED uri (survives cascade-delete)", async () => {
    findStateByAppIdForWrite.mockResolvedValue({
      user_database_uri: "enc:v1:ciphertext",
    });
    const { svc, enqueued } = makeService();
    await svc.cleanupDatabase("app-1", { organizationId: "org-1", userId: "u-1" });
    expect(enqueued).toEqual([
      { appId: "app-1", dbUri: "enc:v1:ciphertext", organizationId: "org-1", userId: "u-1" },
    ]);
  });

  test("no enqueue when the app has no isolated DB", async () => {
    findStateByAppIdForWrite.mockResolvedValue({
      user_database_uri: null,
    });
    const { svc, enqueued } = makeService();
    await svc.cleanupDatabase("app-2", { organizationId: "org-1" });
    expect(enqueued).toEqual([]);
  });

  test("no enqueue when the owning org is unknown (can't form the job row)", async () => {
    findStateByAppIdForWrite.mockResolvedValue({
      user_database_uri: "enc:v1:ciphertext",
    });
    const { svc, enqueued } = makeService();
    await svc.cleanupDatabase("app-3"); // no opts
    expect(enqueued).toEqual([]);
  });

  test("no-ops cleanly when there is no database row at all", async () => {
    findStateByAppIdForWrite.mockResolvedValue(null);
    const { svc, enqueued } = makeService();
    await svc.cleanupDatabase("app-4", { organizationId: "org-1" });
    expect(enqueued).toEqual([]);
  });
});
