/**
 * Verifies safe sorting in Discord triage, DM channel registry, and outbound deduplication when timestamps contain NaN.
 */

import { describe, expect, it, vi } from "vitest";
import { DmChannelRegistry } from "../dm-channel-registry.js";
import {
  beginDiscordOutboundDelivery,
  type DiscordOutboundDeliveryState,
} from "../messages.js";
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
        logger: { warn: vi.fn() },
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

  it("safely prunes settled outbound deliveries when settledAt contains NaN", () => {
    const state = new Map<string, DiscordOutboundDeliveryState>();

    // Fill state past 512 (cap) with settled entries, including NaN settledAt
    for (let i = 0; i < 520; i++) {
      const settledAt = i === 0 ? NaN : 100000 + i;
      state.set(`key-${i}`, {
        status: "settled",
        settledAt,
        receipt: { messageId: `msg-${i}`, channelId: "ch-1" },
      });
    }

    const res = beginDiscordOutboundDelivery({
      channelId: "ch-test",
      text: "hello world",
      state,
      now: 100000,
      windowMs: 1000000,
    });

    expect(res.kind).toBe("deliver");
    expect(state.size).toBeLessThanOrEqual(513);
  });
});
