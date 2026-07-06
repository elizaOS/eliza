/**
 * Drives the real passive-signal-source extension path: the in-memory
 * `SignalSourceRegistry`, the built-in registration, the registry-dispatched
 * `buildTelemetryEventFromSignal`, and the ingestion allow-list. The load-bearing
 * assertion is that a *contributed* source (not one of the built-in eight)
 * flows all the way to a persisted telemetry row and past ingestion with a
 * single `registry.register` call — which the pre-registry closed switch +
 * closed union could not do. Deterministic (no live model / DB); the mapper and
 * reliability are plain functions.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  LIFEOPS_ACTIVITY_SIGNAL_SOURCES,
  type LifeOpsActivitySignal,
} from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createSignalSourceRegistry,
  type SignalSourceContribution,
} from "./registries/signal-source-registry.js";
import { normalizeActivitySignalSource } from "./service-helpers-reminder.js";
import {
  buildTelemetryEventFromSignal,
  registerBuiltinSignalSources,
} from "./telemetry-mapping.js";

function signal(
  overrides: Partial<LifeOpsActivitySignal> = {},
): LifeOpsActivitySignal {
  return {
    id: "signal-1",
    agentId: "agent-1",
    source: "desktop_interaction",
    platform: "macos_desktop",
    state: "active",
    observedAt: "2026-07-06T04:00:00.000Z",
    idleState: null,
    idleTimeSeconds: 3,
    onBattery: null,
    health: null,
    metadata: {},
    createdAt: "2026-07-06T04:00:00.000Z",
    ...overrides,
  };
}

function fakeRuntime(): {
  runtime: IAgentRuntime;
  reportError: ReturnType<typeof vi.fn>;
} {
  const reportError = vi.fn();
  return { runtime: { reportError } as unknown as IAgentRuntime, reportError };
}

/** A plugin-contributed passive source: a browser-activity focus window. */
const browserActivityContribution: SignalSourceContribution = {
  source: "browser_activity",
  description: "Browser tab focus/blur window (contributed by plugin-browser).",
  contributor: "plugin-browser",
  telemetryMapper: (s) =>
    s.state === "active"
      ? {
          family: "browser_focus_window",
          platform: "browser_web",
          startAt: s.observedAt,
          endAt: s.observedAt,
          domain: typeof s.metadata.host === "string" ? s.metadata.host : "",
          tabId: s.id,
          focusedSeconds: 0,
        }
      : null,
  reliability: () => 0.65,
};

describe("SignalSourceRegistry", () => {
  it("registers, looks up, and guards duplicates / empty sources", () => {
    const registry = createSignalSourceRegistry();
    registry.register(browserActivityContribution);

    expect(registry.has("browser_activity")).toBe(true);
    expect(registry.get("browser_activity")?.contributor).toBe(
      "plugin-browser",
    );
    expect(registry.get("view_usage")).toBeNull();
    expect(registry.sources()).toEqual(["browser_activity"]);

    expect(() => registry.register(browserActivityContribution)).toThrow(
      /already registered/,
    );
    expect(() =>
      registry.register({
        ...browserActivityContribution,
        source: "",
      }),
    ).toThrow(/source is required/);
  });

  it("registers all eight built-ins with mapper + reliability", () => {
    const registry = createSignalSourceRegistry();
    registerBuiltinSignalSources(registry);

    expect(registry.sources().sort()).toEqual(
      [...LIFEOPS_ACTIVITY_SIGNAL_SOURCES].sort(),
    );
    for (const source of LIFEOPS_ACTIVITY_SIGNAL_SOURCES) {
      const contribution = registry.get(source);
      expect(contribution).not.toBeNull();
      expect(contribution?.contributor).toBe("app-lifeops");
    }
  });
});

describe("buildTelemetryEventFromSignal (registry-dispatched)", () => {
  it("maps a built-in source through its registered mapper + reliability", () => {
    const registry = createSignalSourceRegistry();
    registerBuiltinSignalSources(registry);
    const { runtime, reportError } = fakeRuntime();

    const event = buildTelemetryEventFromSignal(
      signal({ source: "desktop_interaction", idleTimeSeconds: 3 }),
      "2026-07-06T04:00:01.000Z",
      registry,
      runtime,
    );

    expect(event).not.toBeNull();
    expect(event?.family).toBe("desktop_idle_sample");
    // desktop_idle via iokit_hid weight (source-reliability table).
    expect(event?.sourceReliability).toBe(0.8);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("maps a CONTRIBUTED source to a telemetry row — the extension the closed switch could not", () => {
    const registry = createSignalSourceRegistry();
    registerBuiltinSignalSources(registry);
    registry.register(browserActivityContribution);
    const { runtime, reportError } = fakeRuntime();

    const event = buildTelemetryEventFromSignal(
      signal({
        source: "browser_activity",
        state: "active",
        metadata: { host: "example.com" },
      }),
      "2026-07-06T04:00:01.000Z",
      registry,
      runtime,
    );

    expect(event).not.toBeNull();
    expect(event?.family).toBe("browser_focus_window");
    expect(event?.sourceReliability).toBe(0.65);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports (not silently drops) an unregistered source", () => {
    const registry = createSignalSourceRegistry();
    registerBuiltinSignalSources(registry);
    const { runtime, reportError } = fakeRuntime();

    const event = buildTelemetryEventFromSignal(
      signal({ source: "totally_unknown_source" }),
      "2026-07-06T04:00:01.000Z",
      registry,
      runtime,
    );

    expect(event).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
    const [scope, error] = reportError.mock.calls[0];
    expect(scope).toBe("lifeops.telemetry-mapping");
    expect((error as { code?: string }).code).toBe(
      "LIFEOPS_UNREGISTERED_SIGNAL_SOURCE",
    );
  });

  it("returns null quietly when a registered mapper yields no row for this instance", () => {
    const registry = createSignalSourceRegistry();
    registerBuiltinSignalSources(registry);
    const { runtime, reportError } = fakeRuntime();

    // mobile_health with no health payload legitimately maps to null.
    const event = buildTelemetryEventFromSignal(
      signal({ source: "mobile_health", health: null }),
      "2026-07-06T04:00:01.000Z",
      registry,
      runtime,
    );

    expect(event).toBeNull();
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("normalizeActivitySignalSource (registry allow-list)", () => {
  it("accepts a contributed source that is in the registered allow-list", () => {
    const registry = createSignalSourceRegistry();
    registerBuiltinSignalSources(registry);
    registry.register(browserActivityContribution);

    expect(
      normalizeActivitySignalSource(
        "browser_activity",
        "source",
        registry.sources(),
      ),
    ).toBe("browser_activity");
  });

  it("rejects a source outside the registered allow-list", () => {
    const registry = createSignalSourceRegistry();
    registerBuiltinSignalSources(registry);

    expect(() =>
      normalizeActivitySignalSource(
        "browser_activity",
        "source",
        registry.sources(),
      ),
    ).toThrow();
  });

  it("still validates built-ins and aliases without a registry", () => {
    expect(normalizeActivitySignalSource("app_lifecycle", "source")).toBe(
      "app_lifecycle",
    );
    expect(normalizeActivitySignalSource("mobile-health", "source")).toBe(
      "mobile_health",
    );
    expect(() => normalizeActivitySignalSource("ouija", "source")).toThrow();
  });
});
