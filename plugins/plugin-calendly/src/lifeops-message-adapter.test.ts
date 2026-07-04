/**
 * Unit tests for CalendlyAdapter: mapping scheduled events into MessageRefs
 * (tolerating malformed start times), delegating to a connected CalendlyService,
 * and the env-credential fallback — with a mocked service, no live Calendly.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendlyAdapter } from "./lifeops-message-adapter.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.CALENDLY_ACCESS_TOKEN;
  delete process.env.ELIZA_CALENDLY_TOKEN;
  delete process.env.ELIZA_E2E_CALENDLY_ACCESS_TOKEN;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

function runtimeWithCalendlyService(service: unknown): IAgentRuntime {
  return {
    agentId: "agent-1",
    getService: vi.fn((serviceType: string) =>
      serviceType === "calendly" ? service : null,
    ),
  } as unknown as IAgentRuntime;
}

describe("CalendlyAdapter", () => {
  it("maps delegated scheduled events and tolerates malformed start times", async () => {
    const now = Date.parse("2026-05-31T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const listScheduledEvents = vi.fn(async () => [
      {
        uri: "https://api.calendly.com/scheduled_events/event-1",
        name: "Planning call",
        startTime: "not-a-date",
        endTime: "2026-06-01T17:30:00.000Z",
        status: "active",
        invitees: [{ email: "guest@example.com", name: "Guest User" }],
      },
    ]);
    const runtime = runtimeWithCalendlyService({
      isConnected: vi.fn(() => true),
      listScheduledEvents,
    });

    const messages = await new CalendlyAdapter().listMessages(runtime, {
      sinceMs: Date.parse("2026-06-01T00:00:00.000Z"),
      limit: 3,
    });

    expect(listScheduledEvents).toHaveBeenCalledWith(
      {
        minStartTime: "2026-06-01T00:00:00.000Z",
        limit: 3,
        status: "active",
      },
      "default",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "calendly:https://api.calendly.com/scheduled_events/event-1",
      source: "calendly",
      subject: "Planning call",
      from: {
        identifier: "guest@example.com",
        displayName: "Guest User",
      },
      receivedAtMs: now,
      metadata: {
        status: "active",
        invitees: [{ email: "guest@example.com", name: "Guest User" }],
      },
    });
  });

  it("returns unavailable cleanly when the runtime service is disconnected", async () => {
    const runtime = runtimeWithCalendlyService({
      isConnected: vi.fn(() => false),
      listScheduledEvents: vi.fn(async () => {
        throw new Error("should not be called");
      }),
    });

    await expect(
      new CalendlyAdapter().listMessages(runtime, { limit: 10 }),
    ).resolves.toEqual([]);
  });
});
