/**
 * Tests the durable activity-signal to telemetry-event mapper. These cases pin
 * provenance fields because downstream passive-learning and sleep/wake scoring
 * treat channel, platform, direction, and sender identity as evidence quality.
 */

import type { LifeOpsActivitySignal } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { mapSignalToTelemetryPayload } from "./telemetry-mapping.js";

function signal(
  overrides: Partial<LifeOpsActivitySignal> = {},
): LifeOpsActivitySignal {
  return {
    id: "signal-1",
    agentId: "agent-1",
    source: "connector_activity",
    platform: "telegram",
    state: "active",
    observedAt: "2026-07-06T04:00:00.000Z",
    idleState: null,
    idleTimeSeconds: 0,
    onBattery: null,
    health: null,
    metadata: {},
    createdAt: "2026-07-06T04:00:00.000Z",
    ...overrides,
  };
}

describe("mapSignalToTelemetryPayload", () => {
  it("preserves connector activity provenance instead of fabricating gmail/macos/owner", () => {
    const payload = mapSignalToTelemetryPayload(
      signal({
        platform: "telegram",
        metadata: {
          direction: "inbound",
          externalMessageId: "telegram-message-1",
          senderHash: "sender:abc123",
          conversationHash: "conversation:def456",
        },
      }),
    );

    expect(payload).toEqual({
      family: "message_activity_event",
      platform: "browser_web",
      channel: "telegram",
      direction: "inbound",
      externalMessageId: "telegram-message-1",
      senderHash: "sender:abc123",
      conversationHash: "conversation:def456",
    });
  });

  it("derives device platform from the observed signal platform", () => {
    expect(
      mapSignalToTelemetryPayload(
        signal({ source: "app_lifecycle", platform: "ios" }),
      ),
    ).toMatchObject({ platform: "ios_capacitor" });
    expect(
      mapSignalToTelemetryPayload(
        signal({ source: "app_lifecycle", platform: "macos_electrobun" }),
      ),
    ).toMatchObject({ platform: "macos_electrobun" });
  });
});
