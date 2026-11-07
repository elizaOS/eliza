import { expect, test } from "bun:test";
import {
  backupRetentionInventory,
  observeBackupSchedules,
} from "./pitr-backup-inventory";
import type { privatePitrApi } from "./pitr-private-api";

const now = Date.parse("2026-10-20T04:00:00Z");
const row = {
  id: "private-id",
  name: "private-name",
  externalId: "private-external",
  createdAt: "2026-10-19T04:00:00Z",
  expiresAt: "2026-10-21T04:00:00Z",
  scheduleId: "private-schedule",
  usedMB: 12,
  referencedMB: 20,
  volumeInstanceSizeMB: 100,
};
test("bounded inventory exposes receipts and dates, distinguishes expiry and protects all newest ties", () => {
  const result = backupRetentionInventory(
    [
      row,
      {
        ...row,
        id: "other",
        scheduleId: null,
        expiresAt: "2026-10-19T05:00:00Z",
      },
      { ...row, id: "old", createdAt: "2026-10-18T00:00:00Z", expiresAt: null },
    ],
    now,
  );
  expect(result.available).toBe(true);
  if (!result.available) return;
  expect(result.backups?.filter((x) => x.preserveAsMostRecent).length).toBe(2);
  expect(result.backups?.map((x) => x.expiryState).sort()).toEqual([
    "expired",
    "no_scheduled_expiry",
    "retained",
  ]);
  expect(
    result.backups?.filter((x) => x.classification === "manual").length,
  ).toBe(1);
  expect(result.deletionAuthorized).toBe(false);
  expect(result.restoreProven).toBe(false);
  const serialized = JSON.stringify(result);
  for (const v of [row.id, row.name, row.externalId, row.scheduleId])
    expect(serialized).not.toContain(v);
});
test("excessive or ambiguous identities refuse detailed inventory", () => {
  expect(
    backupRetentionInventory(
      Array.from({ length: 16 }, (_, i) => ({ ...row, id: String(i) })),
      now,
    ).available,
  ).toBe(false);
  expect(backupRetentionInventory([row, row], now).available).toBe(false);
  expect(backupRetentionInventory([{ ...row, id: "" }], now).available).toBe(
    false,
  );
});
test("invalid dates/sizes and future creation never claim newest valid backup", () => {
  const r = backupRetentionInventory(
    [
      {
        ...row,
        createdAt: "private invalid date",
        expiresAt: "secret invalid",
        usedMB: Infinity,
        referencedMB: -1,
        volumeInstanceSizeMB: 2 ** 32,
      },
      { ...row, id: "future", createdAt: "2027-01-01T00:00:00Z" },
    ],
    now,
  );
  expect(r.available).toBe(true);
  if (!r.available) return;
  expect(r.backups?.every((b) => !b.preserveAsMostRecent)).toBe(true);
  expect(r.backups?.find((b) => b.createdAt === null)).toMatchObject({
    expiresAt: null,
    expiryState: "unknown",
    usedMB: null,
    referencedMB: null,
    volumeCapacityMB: null,
  });
  expect(JSON.stringify(r)).not.toContain("secret");
});
test("schedule metadata is finite, no IDs/cron/names; optional errors sanitized", async () => {
  const api = (async (name: string) => {
    expect(name).toBe("backupSchedules");
    return {
      data: {
        volumeInstanceBackupScheduleList: [
          {
            kind: "DAILY",
            createdAt: row.createdAt,
            retentionSeconds: 518400,
            id: "private",
            cron: "private",
            name: "private",
          },
        ],
      },
    };
  }) as typeof privatePitrApi;
  const r = await observeBackupSchedules(api, "bound-id");
  expect(r).toEqual({
    available: true,
    schedules: [
      {
        kind: "DAILY",
        createdAt: "2026-10-19T04:00:00.000Z",
        retentionSeconds: 518400,
      },
    ],
  });
  expect(JSON.stringify(r)).not.toContain("private");
  const fail = (async () => {
    throw Error("private provider data");
  }) as typeof privatePitrApi;
  expect(await observeBackupSchedules(fail, "bound-id")).toEqual({
    available: false,
    reason: "schedule_observation_unavailable",
  });
});
