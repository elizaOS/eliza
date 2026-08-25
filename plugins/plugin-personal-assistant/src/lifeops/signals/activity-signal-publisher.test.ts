import { describe, expect, it, vi } from "vitest";
import { publishActivitySignalToBus } from "./activity-signal-publisher";

function makeBus() {
  return { publish: vi.fn() };
}

function makeRegistry(get: (source: string) => unknown) {
  return { get };
}

const signal = {
  id: "signal-1",
  source: "chat:123",
  observedAt: "2026-08-25T00:00:00.000Z",
  platform: "telegram",
};

describe("publishActivitySignalToBus", () => {
  it("publishes a mapped message-activity signal and reports published: 1", () => {
    const bus = makeBus();
    const registry = makeRegistry(() => ({
      family: "message_activity_event",
      telemetryMapper: (s: typeof signal) => ({
        family: "message_activity_event",
        source: s.source,
      }),
    }));
    const result = publishActivitySignalToBus(
      bus as never,
      signal as never,
      registry as never,
    );
    expect(result).toEqual({ published: 1, unmapped: 0 });
    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect(bus.publish).toHaveBeenCalledWith({
      family: "message_activity_event",
      occurredAt: signal.observedAt,
      payload: { family: "message_activity_event", source: signal.source },
      metadata: {
        source: "lifeops-activity-signal",
        signalId: signal.id,
        signalSource: signal.source,
        signalPlatform: signal.platform,
      },
    });
  });

  it("reports unmapped when the registry has no mapping for the source", () => {
    const bus = makeBus();
    const registry = makeRegistry(() => null);
    const result = publishActivitySignalToBus(
      bus as never,
      signal as never,
      registry as never,
    );
    expect(result).toEqual({ published: 0, unmapped: 1 });
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it("does not publish signals mapped to a non-message family", () => {
    const bus = makeBus();
    const registry = makeRegistry(() => ({
      family: "health_metric",
      telemetryMapper: (s: typeof signal) => ({
        family: "health_metric",
        source: s.source,
      }),
    }));
    const result = publishActivitySignalToBus(
      bus as never,
      signal as never,
      registry as never,
    );
    expect(result).toEqual({ published: 0, unmapped: 1 });
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it("carries the mapped payload through to the bus envelope", () => {
    const bus = makeBus();
    const payload = { family: "message_activity_event", value: 7 };
    const registry = makeRegistry(() => ({
      family: "message_activity_event",
      telemetryMapper: () => payload,
    }));
    publishActivitySignalToBus(
      bus as never,
      signal as never,
      registry as never,
    );
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ payload, family: "message_activity_event" }),
    );
  });
});
