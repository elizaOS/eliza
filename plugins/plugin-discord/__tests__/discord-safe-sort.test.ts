/**
 * Verifies safe sorting in Discord triage, DM channel registry, and outbound deduplication when timestamps contain NaN.
 */

import { describe, expect, it } from "vitest";
import { DmChannelRegistry } from "../dm-channel-registry.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("discord safe sort", () => {
  it("safely lists recent DM channels when lastSeenAt contains NaN or non-finite numbers", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-dm-test-"));
    const filePath = path.join(tmpDir, "dm-channels.json");

    try {
      const timestamps = [1000, NaN, 2000];
      let i = 0;
      const registry = new DmChannelRegistry({
        filePath,
        maxEntries: 10,
        now: () => timestamps[i++],
      });

      registry.record("ch-1", "user-1");
      registry.record("ch-nan", "user-nan");
      registry.record("ch-2", "user-2");

      const recent = registry.listRecent();
      expect(recent).toHaveLength(3);
      expect(recent[0].channelId).toBe("ch-2");
      expect(recent[1].channelId).toBe("ch-1");
      expect(recent[2].channelId).toBe("ch-nan");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("safely sorts outbound deliveries when settledAt contains NaN", () => {
    const entries: [string, { status: "settled"; settledAt: number }][] = [
      ["k2", { status: "settled", settledAt: 2000 }],
      ["knan", { status: "settled", settledAt: NaN }],
      ["k1", { status: "settled", settledAt: 1000 }],
    ];

    entries.sort(
      (left, right) =>
        (Number.isFinite(left[1].settledAt) ? left[1].settledAt : 0) -
        (Number.isFinite(right[1].settledAt) ? right[1].settledAt : 0),
    );

    expect(entries[0][0]).toBe("knan");
    expect(entries[1][0]).toBe("k1");
    expect(entries[2][0]).toBe("k2");
  });
});
