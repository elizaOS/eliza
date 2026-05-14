import { describe, expect, it } from "vitest";
import {
  applyNetworkPolicy,
  classifyNetwork,
  DEFAULT_NETWORK_POLICY_PREFERENCES,
  evaluateNetworkPolicy,
  inQuietHours,
  type NetworkPolicyPreferences,
} from "./network-policy.js";

const prefsAllOff: NetworkPolicyPreferences = {
  autoUpdateOnWifi: false,
  autoUpdateOnCellular: false,
  autoUpdateOnMetered: false,
  quietHours: [],
};

const prefsWifiOnly: NetworkPolicyPreferences = {
  ...prefsAllOff,
  autoUpdateOnWifi: true,
};

const prefsCellularToo: NetworkPolicyPreferences = {
  ...prefsAllOff,
  autoUpdateOnWifi: true,
  autoUpdateOnCellular: true,
  autoUpdateOnMetered: true,
};

describe("classifyNetwork", () => {
  it("maps the five canonical classes", () => {
    expect(
      classifyNetwork({ connectionType: "wifi", metered: false }),
    ).toBe("wifi-unmetered");
    expect(
      classifyNetwork({ connectionType: "wifi", metered: true }),
    ).toBe("wifi-metered");
    expect(
      classifyNetwork({ connectionType: "ethernet", metered: false }),
    ).toBe("ethernet-unmetered");
    expect(
      classifyNetwork({ connectionType: "ethernet", metered: true }),
    ).toBe("ethernet-metered");
    expect(
      classifyNetwork({ connectionType: "cellular", metered: null }),
    ).toBe("cellular");
  });

  it("returns unknown when the metered flag is missing on wifi/ethernet", () => {
    expect(
      classifyNetwork({ connectionType: "wifi", metered: null }),
    ).toBe("unknown");
    expect(
      classifyNetwork({ connectionType: "ethernet", metered: null }),
    ).toBe("unknown");
  });

  it("offline/none collapses to unknown", () => {
    expect(
      classifyNetwork({ connectionType: "none", metered: null }),
    ).toBe("unknown");
    expect(
      classifyNetwork({ connectionType: "unknown", metered: null }),
    ).toBe("unknown");
  });
});

describe("applyNetworkPolicy", () => {
  const noon = new Date("2026-05-14T12:00:00Z");

  it("ethernet-unmetered always auto", () => {
    const d = applyNetworkPolicy("ethernet-unmetered", prefsAllOff, 1, {
      now: noon,
    });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe("auto");
  });

  it("wifi-unmetered respects autoUpdateOnWifi", () => {
    expect(
      applyNetworkPolicy("wifi-unmetered", prefsAllOff, 1, { now: noon }).allow,
    ).toBe(false);
    expect(
      applyNetworkPolicy("wifi-unmetered", prefsWifiOnly, 1, { now: noon }).allow,
    ).toBe(true);
  });

  it("cellular asks unless explicitly opted in", () => {
    const ask = applyNetworkPolicy("cellular", prefsWifiOnly, 1, { now: noon });
    expect(ask.allow).toBe(false);
    expect(ask.reason).toBe("cellular-ask");

    const auto = applyNetworkPolicy("cellular", prefsCellularToo, 1, {
      now: noon,
    });
    expect(auto.allow).toBe(true);
    expect(auto.reason).toBe("auto");
  });

  it("metered links ask unless autoUpdateOnMetered", () => {
    const wifiMetered = applyNetworkPolicy("wifi-metered", prefsWifiOnly, 1, {
      now: noon,
    });
    expect(wifiMetered.allow).toBe(false);
    expect(wifiMetered.reason).toBe("metered-ask");

    const withMetered = applyNetworkPolicy(
      "wifi-metered",
      prefsCellularToo,
      1,
      { now: noon },
    );
    expect(withMetered.allow).toBe(true);
  });

  it("unknown defaults to ask", () => {
    const d = applyNetworkPolicy("unknown", prefsCellularToo, 1, { now: noon });
    expect(d.allow).toBe(false);
  });

  it("headless override always denies (explicit milady models update only)", () => {
    const d = applyNetworkPolicy("ethernet-unmetered", prefsCellularToo, 1, {
      now: noon,
      isHeadless: true,
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("headless-explicit-only");
  });

  it("quiet hours downgrade auto to ask", () => {
    const prefs: NetworkPolicyPreferences = {
      ...prefsWifiOnly,
      quietHours: [{ start: "22:00", end: "08:00" }],
    };
    const inWindow = new Date("2026-05-14T23:30:00");
    const outWindow = new Date("2026-05-14T12:00:00");
    expect(
      applyNetworkPolicy("wifi-unmetered", prefs, 1, { now: inWindow }).allow,
    ).toBe(false);
    expect(
      applyNetworkPolicy("wifi-unmetered", prefs, 1, { now: outWindow }).allow,
    ).toBe(true);
  });

  it("preserves estimatedBytes in the decision", () => {
    const d = applyNetworkPolicy("cellular", prefsAllOff, 1_400_000_000, {
      now: noon,
    });
    expect(d.estimatedBytes).toBe(1_400_000_000);
  });
});

describe("inQuietHours", () => {
  it("matches inside a same-day window", () => {
    expect(
      inQuietHours(
        [{ start: "09:00", end: "17:00" }],
        new Date("2026-05-14T12:00:00"),
      ),
    ).toBe(true);
    expect(
      inQuietHours(
        [{ start: "09:00", end: "17:00" }],
        new Date("2026-05-14T08:00:00"),
      ),
    ).toBe(false);
  });

  it("matches across midnight", () => {
    expect(
      inQuietHours(
        [{ start: "22:00", end: "08:00" }],
        new Date("2026-05-14T23:00:00"),
      ),
    ).toBe(true);
    expect(
      inQuietHours(
        [{ start: "22:00", end: "08:00" }],
        new Date("2026-05-14T03:00:00"),
      ),
    ).toBe(true);
    expect(
      inQuietHours(
        [{ start: "22:00", end: "08:00" }],
        new Date("2026-05-14T12:00:00"),
      ),
    ).toBe(false);
  });

  it("rejects malformed clock strings without throwing", () => {
    expect(
      inQuietHours(
        [{ start: "not-a-time", end: "08:00" }],
        new Date("2026-05-14T23:00:00"),
      ),
    ).toBe(false);
  });

  it("zero-width window never matches", () => {
    expect(
      inQuietHours(
        [{ start: "08:00", end: "08:00" }],
        new Date("2026-05-14T08:00:00"),
      ),
    ).toBe(false);
  });
});

describe("evaluateNetworkPolicy composition", () => {
  it("wifi+unmetered+wifi-pref ⇒ auto", () => {
    const d = evaluateNetworkPolicy(
      { connectionType: "wifi", metered: false },
      prefsWifiOnly,
      100,
    );
    expect(d.allow).toBe(true);
    expect(d.reason).toBe("auto");
  });

  it("cellular ignores wifi-pref ⇒ ask", () => {
    const d = evaluateNetworkPolicy(
      { connectionType: "cellular", metered: null },
      prefsWifiOnly,
      100,
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("cellular-ask");
  });
});

describe("DEFAULT_NETWORK_POLICY_PREFERENCES", () => {
  it("auto on wifi, off on cellular/metered, 22-08 quiet hours", () => {
    expect(DEFAULT_NETWORK_POLICY_PREFERENCES.autoUpdateOnWifi).toBe(true);
    expect(DEFAULT_NETWORK_POLICY_PREFERENCES.autoUpdateOnCellular).toBe(false);
    expect(DEFAULT_NETWORK_POLICY_PREFERENCES.autoUpdateOnMetered).toBe(false);
    expect(DEFAULT_NETWORK_POLICY_PREFERENCES.quietHours).toEqual([
      { start: "22:00", end: "08:00" },
    ]);
  });
});
