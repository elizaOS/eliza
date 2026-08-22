/**
 * Verifies the production vision configuration parser and screen timer reject
 * unsafe capture intervals while preserving documented defaults and aliases.
 */

import type { ElizaError, IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VisionService } from "./service";
import type { VisionConfig } from "./types";

function makeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  return Object.assign(Object.create(null) as IAgentRuntime, {
    agentId: "agent",
    character: {},
    getSetting: vi.fn((key: string) => settings[key]),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
  });
}

function parsedCaptureInterval(settings: Record<string, string>): number {
  const service = new VisionService(makeRuntime(settings));
  const config = Reflect.get(service, "visionConfig") as VisionConfig;
  if (config.screenCaptureInterval === undefined) {
    throw new Error(
      "screenCaptureInterval must be resolved during construction",
    );
  }
  return config.screenCaptureInterval;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("VisionService screen capture interval configuration", () => {
  it("uses the default only when both setting names are absent or blank", () => {
    expect(parsedCaptureInterval({})).toBe(2000);
    expect(
      parsedCaptureInterval({
        SCREEN_CAPTURE_INTERVAL: "   ",
        VISION_SCREEN_CAPTURE_INTERVAL: "\t",
      }),
    ).toBe(2000);
  });

  it.each([
    ["minimum", "100", 100],
    ["maximum", "60000", 60_000],
    ["valid exponent", "1e2", 100],
    ["fractional", "1500.5", 1500.5],
  ])("accepts the schema %s boundary/value", (_label, raw, expected) => {
    expect(parsedCaptureInterval({ SCREEN_CAPTURE_INTERVAL: raw })).toBe(
      expected,
    );
  });

  it.each([
    ["below minimum", "99"],
    ["above maximum", "60001"],
    ["zero", "0"],
    ["negative", "-5"],
    ["positive infinity", "Infinity"],
    ["negative infinity", "-Infinity"],
    ["overflowing exponent", "1e309"],
    ["not a number", "not-a-number"],
  ])("rejects an explicit %s value", (_label, raw) => {
    expect(() =>
      parsedCaptureInterval({ SCREEN_CAPTURE_INTERVAL: raw }),
    ).toThrowError(
      expect.objectContaining<Partial<ElizaError>>({
        code: "VISION_SCREEN_CAPTURE_INTERVAL_INVALID",
        severity: "fatal",
      }),
    );
  });

  it("falls through a whitespace-only primary value to the legacy alias", () => {
    expect(
      parsedCaptureInterval({
        SCREEN_CAPTURE_INTERVAL: "  ",
        VISION_SCREEN_CAPTURE_INTERVAL: "750",
      }),
    ).toBe(750);
  });

  it("does not hide an invalid primary value behind a valid legacy alias", () => {
    expect(() =>
      parsedCaptureInterval({
        SCREEN_CAPTURE_INTERVAL: "Infinity",
        VISION_SCREEN_CAPTURE_INTERVAL: "750",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ElizaError>>({
        code: "VISION_SCREEN_CAPTURE_INTERVAL_INVALID",
        context: expect.objectContaining({ key: "SCREEN_CAPTURE_INTERVAL" }),
      }),
    );
  });

  it.each([
    ["minimum", "100", 100],
    ["maximum", "60000", 60_000],
  ])("arms the screen timer at the exact %s", (_label, raw, expected) => {
    vi.useFakeTimers();
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const service = new VisionService(
      makeRuntime({ SCREEN_CAPTURE_INTERVAL: raw }),
    );
    const startScreenProcessing = Reflect.get(
      service,
      "startScreenProcessing",
    ) as () => void;

    startScreenProcessing.call(service);

    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), expected);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not arm any timer when explicit configuration is invalid", () => {
    vi.useFakeTimers();
    const intervalSpy = vi.spyOn(globalThis, "setInterval");

    expect(
      () =>
        new VisionService(makeRuntime({ SCREEN_CAPTURE_INTERVAL: "60001" })),
    ).toThrowError(
      expect.objectContaining<Partial<ElizaError>>({
        code: "VISION_SCREEN_CAPTURE_INTERVAL_INVALID",
      }),
    );
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
