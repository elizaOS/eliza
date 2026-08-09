/** Tests Discord connection recovery state using deterministic in-memory lifecycle records. */

import { describe, expect, test } from "bun:test";
import {
  type DiscordConnectionLifecycleState,
  reconcileDiscordConnectionReady,
} from "../src/connection-lifecycle";

describe("reconcileDiscordConnectionReady", () => {
  test.each(["connecting", "disconnected", "error"] as const)(
    "restores a %s connection after shard recovery",
    (status) => {
      const originalConnectedAt = new Date("2026-08-01T00:00:00.000Z");
      const recoveredAt = new Date("2026-08-07T04:30:00.000Z");
      const connection: DiscordConnectionLifecycleState = {
        status,
        guildCount: 0,
        connectedAt: originalConnectedAt,
        statusChangedAt: new Date("2026-08-07T04:29:00.000Z"),
        error: "transient gateway failure",
      };

      expect(
        reconcileDiscordConnectionReady(connection, 3, recoveredAt),
      ).toEqual({
        changed: true,
        previousStatus: status,
      });
      expect(connection).toEqual({
        status: "connected",
        guildCount: 3,
        connectedAt: recoveredAt,
        statusChangedAt: undefined,
        error: undefined,
      });
    },
  );

  test("treats duplicate ready and resume events as idempotent", () => {
    const connectedAt = new Date("2026-08-07T04:30:00.000Z");
    const duplicateAt = new Date("2026-08-07T04:31:00.000Z");
    const connection: DiscordConnectionLifecycleState = {
      status: "connected",
      guildCount: 1,
      connectedAt,
    };

    expect(reconcileDiscordConnectionReady(connection, 2, duplicateAt)).toEqual(
      {
        changed: false,
        previousStatus: "connected",
      },
    );
    expect(connection).toEqual({
      status: "connected",
      guildCount: 2,
      connectedAt,
    });
  });
});
