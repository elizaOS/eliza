/**
 * Unit test for `resolveActivitySignalReliability` / `resolveSourceReliability`
 * — the per-source confidence weights used to rank activity signals.
 */
import { describe, expect, it } from "vitest";
import {
  type LifeOpsMessageReliabilityChannel,
  resolveActivitySignalReliability,
  resolveSourceReliability,
} from "./source-reliability.js";

/**
 * Pins the pure reliability-weighting math (#8795) that feeds
 * `computeAwakeProbability` / circadian inference. Both functions are
 * deterministic `key -> number`, but had zero coverage on develop.
 */
describe("resolveSourceReliability", () => {
  it("manual override is fully trusted", () => {
    expect(resolveSourceReliability({ kind: "manual_override" })).toBe(1.0);
  });

  it("mobile_health fails closed without permission", () => {
    expect(
      resolveSourceReliability({
        kind: "mobile_health",
        permissionGranted: true,
      }),
    ).toBe(0.95);
    expect(
      resolveSourceReliability({
        kind: "mobile_health",
        permissionGranted: false,
      }),
    ).toBe(0);
  });

  it("desktop_power: system/screen are high, session lower", () => {
    expect(
      resolveSourceReliability({ kind: "desktop_power", transition: "system" }),
    ).toBe(0.92);
    expect(
      resolveSourceReliability({ kind: "desktop_power", transition: "screen" }),
    ).toBe(0.92);
    expect(
      resolveSourceReliability({
        kind: "desktop_power",
        transition: "session",
      }),
    ).toBe(0.85);
  });

  it("message_outbound: imessage/eliza_chat trusted higher than the rest", () => {
    const high: LifeOpsMessageReliabilityChannel[] = ["imessage", "eliza_chat"];
    for (const channel of high) {
      expect(
        resolveSourceReliability({ kind: "message_outbound", channel }),
      ).toBe(0.88);
    }
    const rest: LifeOpsMessageReliabilityChannel[] = [
      "gmail",
      "x_dm",
      "discord",
      "telegram",
      "signal",
      "whatsapp",
      "sms",
    ];
    for (const channel of rest) {
      expect(
        resolveSourceReliability({ kind: "message_outbound", channel }),
      ).toBe(0.8);
    }
  });

  it("desktop_idle: iokit_hid trusted over cgevent", () => {
    expect(
      resolveSourceReliability({ kind: "desktop_idle", source: "iokit_hid" }),
    ).toBe(0.8);
    expect(
      resolveSourceReliability({ kind: "desktop_idle", source: "cgevent" }),
    ).toBe(0.75);
  });

  it("device_presence: present trusted over absent", () => {
    expect(
      resolveSourceReliability({ kind: "device_presence", transition: true }),
    ).toBe(0.7);
    expect(
      resolveSourceReliability({ kind: "device_presence", transition: false }),
    ).toBe(0.3);
  });

  it("mobile_device: capacitor trusted over the continuity probe", () => {
    expect(
      resolveSourceReliability({ kind: "mobile_device", source: "capacitor" }),
    ).toBe(0.7);
    expect(
      resolveSourceReliability({
        kind: "mobile_device",
        source: "continuity_probe",
      }),
    ).toBe(0.5);
  });

  it("flat-weight keys carry their documented constants", () => {
    expect(resolveSourceReliability({ kind: "message_inbound" })).toBe(0.15);
    expect(resolveSourceReliability({ kind: "status_activity" })).toBe(0.6);
    expect(resolveSourceReliability({ kind: "browser_focus" })).toBe(0.7);
    expect(resolveSourceReliability({ kind: "charging" })).toBe(0.4);
    expect(resolveSourceReliability({ kind: "screen_time_summary" })).toBe(
      0.55,
    );
    expect(resolveSourceReliability({ kind: "prior_baseline" })).toBe(0.4);
  });
});

describe("resolveActivitySignalReliability", () => {
  it("app_lifecycle with the manual_override platform is fully trusted", () => {
    expect(
      resolveActivitySignalReliability("app_lifecycle", "manual_override"),
    ).toBe(1.0);
  });

  it("maps each source to its default reliability key", () => {
    expect(resolveActivitySignalReliability("app_lifecycle", "ios")).toBe(0.7);
    expect(resolveActivitySignalReliability("page_visibility", "web")).toBe(
      0.7,
    );
    expect(resolveActivitySignalReliability("desktop_power", "macos")).toBe(
      0.92,
    );
    expect(
      resolveActivitySignalReliability("desktop_interaction", "macos"),
    ).toBe(0.8);
    expect(resolveActivitySignalReliability("connector_activity", "web")).toBe(
      0.15,
    );
    expect(resolveActivitySignalReliability("imessage_outbound", "macos")).toBe(
      0.88,
    );
    expect(resolveActivitySignalReliability("mobile_device", "ios")).toBe(0.7);
    expect(resolveActivitySignalReliability("mobile_health", "ios")).toBe(0.95);
  });

  it("derives connector message reliability from direction and channel metadata", () => {
    expect(
      resolveActivitySignalReliability("connector_activity", "telegram", {
        direction: "inbound",
      }),
    ).toBe(0.15);
    expect(
      resolveActivitySignalReliability("connector_activity", "telegram", {
        direction: "outbound_by_owner",
      }),
    ).toBe(0.8);
    expect(
      resolveActivitySignalReliability("connector_activity", "client_chat", {
        direction: "outbound_by_owner",
      }),
    ).toBe(0.88);
  });
});
