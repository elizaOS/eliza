import { describe, expect, it } from "vitest";

import type { Prober } from "../contracts.ts";
import { IS_DARWIN, platformUnsupportedState } from "./_bridge.ts";
import { ALL_PROBERS, PROBERS_BY_ID } from "./index.ts";

const EXPECTED_IDS = [
  "accessibility",
  "automation",
  "calendar",
  "camera",
  "contacts",
  "full-disk",
  "health",
  "location",
  "microphone",
  "notes",
  "notifications",
  "reminders",
  "screen-recording",
  "screentime",
  "shell",
  "website-blocking",
] as const;

describe("permission probers", () => {
  it("registers exactly one prober per PermissionId", () => {
    expect(ALL_PROBERS.length).toBe(EXPECTED_IDS.length);
    const ids = new Set(ALL_PROBERS.map((p) => p.id));
    for (const id of EXPECTED_IDS) {
      expect(ids.has(id)).toBe(true);
    }
    expect(ids.size).toBe(EXPECTED_IDS.length);
  });

  it("PROBERS_BY_ID indexes every prober", () => {
    for (const id of EXPECTED_IDS) {
      expect(PROBERS_BY_ID.get(id)).toBeDefined();
    }
  });

  it("each prober exposes a stable id, check(), and request()", () => {
    for (const prober of ALL_PROBERS) {
      expect(typeof prober.id).toBe("string");
      expect(typeof prober.check).toBe("function");
      expect(typeof prober.request).toBe("function");
    }
  });

  it("check() returns a PermissionState shape with required fields", async () => {
    // Pick the prober least likely to hit anything platform-specific.
    const shell = PROBERS_BY_ID.get("shell") as Prober;
    const state = await shell.check();
    expect(state.id).toBe("shell");
    expect(typeof state.status).toBe("string");
    expect(typeof state.lastChecked).toBe("number");
    expect(typeof state.canRequest).toBe("boolean");
    expect(["darwin", "win32", "linux"]).toContain(state.platform);
  });

  it("platformUnsupportedState produces the contract shape", () => {
    const state = platformUnsupportedState("notes");
    expect(state.id).toBe("notes");
    expect(state.status).toBe("not-applicable");
    expect(state.restrictedReason).toBe("platform_unsupported");
    expect(state.canRequest).toBe(false);
  });

  it("non-darwin: macOS-only probers short-circuit to not-applicable", async () => {
    if (IS_DARWIN) return; // skip on macOS
    const macOnly: Array<(typeof EXPECTED_IDS)[number]> = [
      "accessibility",
      "automation",
      "calendar",
      "contacts",
      "full-disk",
      "health",
      "notes",
      "reminders",
      "screen-recording",
      "screentime",
    ];
    for (const id of macOnly) {
      const prober = PROBERS_BY_ID.get(id) as Prober;
      const state = await prober.check();
      expect(state.status).toBe("not-applicable");
      expect(state.restrictedReason).toBe("platform_unsupported");
    }
  });

  it("darwin: health and screentime report restricted/entitlement_required in unsigned dev", async () => {
    if (!IS_DARWIN) return; // skip off macOS
    // In unsigned dev there is no embedded provisioning profile, so the
    // entitlement check returns false. If this test is ever run inside a
    // signed bundle the assertion needs to be relaxed.
    const health = PROBERS_BY_ID.get("health") as Prober;
    const screentime = PROBERS_BY_ID.get("screentime") as Prober;
    const healthState = await health.check();
    const screentimeState = await screentime.check();
    // Either restricted (unsigned dev) or not-determined (signed with entitlement).
    expect(["restricted", "not-determined"]).toContain(healthState.status);
    expect(["restricted", "not-determined"]).toContain(screentimeState.status);
    if (healthState.status === "restricted") {
      expect(healthState.restrictedReason).toBe("entitlement_required");
    }
    if (screentimeState.status === "restricted") {
      expect(screentimeState.restrictedReason).toBe("entitlement_required");
    }
  });
});
