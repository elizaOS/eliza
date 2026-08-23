/**
 * Verifies safe sorting behavior in mobile push delivery ledger bounding
 * when timestamps contain invalid or non-numeric values.
 */

import { describe, expect, it } from "vitest";

type MobilePushDeliveryLedgerEntry = {
  notificationId: string;
  sourceId: string;
  kind: string;
  timestamp: string;
  updatedAt: number;
  deliveryStatus: "queued" | "dispatched" | "failed" | "skipped";
};

function boundMobilePushDeliveryLedger(
  ledger: Record<string, MobilePushDeliveryLedgerEntry>,
  limit: number = 3,
): Record<string, MobilePushDeliveryLedgerEntry> {
  return Object.fromEntries(
    Object.entries(ledger)
      .sort(([leftKey, left], [rightKey, right]) => {
        const r =
          typeof right.updatedAt === "number" &&
          Number.isFinite(right.updatedAt)
            ? right.updatedAt
            : 0;
        const l =
          typeof left.updatedAt === "number" && Number.isFinite(left.updatedAt)
            ? left.updatedAt
            : 0;
        return r - l || leftKey.localeCompare(rightKey);
      })
      .slice(0, limit),
  );
}

describe("shared-runtime-conversation mobile push ledger safe sort", () => {
  it("sorts ledger safely when updatedAt contains NaN or non-finite numbers", () => {
    const ledger: Record<string, MobilePushDeliveryLedgerEntry> = {
      "entry-invalid": {
        notificationId: "n-1",
        sourceId: "s-1",
        kind: "message",
        timestamp: "2026-08-01T00:00:00Z",
        updatedAt: NaN,
        deliveryStatus: "queued",
      },
      "entry-recent": {
        notificationId: "n-2",
        sourceId: "s-2",
        kind: "message",
        timestamp: "2026-08-20T00:00:00Z",
        updatedAt: 1786795200000,
        deliveryStatus: "dispatched",
      },
    };

    const bounded = boundMobilePushDeliveryLedger(ledger, 2);
    const keys = Object.keys(bounded);
    expect(keys).toEqual(["entry-recent", "entry-invalid"]);
  });
});
