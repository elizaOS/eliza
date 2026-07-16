/**
 * Cloud-api DB heartbeat (#16160): the write upserts the reserved
 * provider_health row and never throws (a missed beat only degrades the
 * daemon's idle-vs-split discrimination); the read returns the row's
 * updated_at or null when the row has never been written.
 */
import { describe, expect, mock, test } from "bun:test";
import * as repoActual from "../../db/repositories/provider-health";

let createOrUpdateImpl: (data: Record<string, unknown>) => Promise<unknown> = async () => ({});
let findByProviderImpl: (provider: string) => Promise<unknown> = async () => undefined;

mock.module("../../db/repositories/provider-health", () => ({
  ...repoActual,
  providerHealthRepository: {
    createOrUpdate: (data: Record<string, unknown>) => createOrUpdateImpl(data),
    findByProvider: (provider: string) => findByProviderImpl(provider),
  },
}));

const { CLOUD_API_DB_HEARTBEAT_PROVIDER, readCloudApiDbHeartbeatAt, writeCloudApiDbHeartbeat } =
  await import("./cloud-api-db-heartbeat");

describe("cloud-api DB heartbeat (#16160)", () => {
  test("write upserts the reserved provider row as healthy", async () => {
    const writes: Record<string, unknown>[] = [];
    createOrUpdateImpl = async (data) => {
      writes.push(data);
      return data;
    };
    await writeCloudApiDbHeartbeat();
    expect(writes).toHaveLength(1);
    expect(writes[0].provider).toBe(CLOUD_API_DB_HEARTBEAT_PROVIDER);
    expect(writes[0].status).toBe("healthy");
    expect(writes[0].last_checked).toBeInstanceOf(Date);
  });

  test("write never throws — a DB failure is logged, not propagated into the cron", async () => {
    createOrUpdateImpl = async () => {
      throw new Error("db down");
    };
    await expect(writeCloudApiDbHeartbeat()).resolves.toBeUndefined();
  });

  test("read returns the row's updated_at, and null when never written", async () => {
    const beat = new Date("2026-07-15T12:00:00Z");
    findByProviderImpl = async (provider) => {
      expect(provider).toBe(CLOUD_API_DB_HEARTBEAT_PROVIDER);
      return { updated_at: beat };
    };
    expect(await readCloudApiDbHeartbeatAt()).toEqual(beat);

    findByProviderImpl = async () => undefined;
    expect(await readCloudApiDbHeartbeatAt()).toBeNull();
  });
});
