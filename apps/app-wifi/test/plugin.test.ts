/**
 * Plugin smoke test — verifies the WiFi runtime plugin shape and metadata.
 *
 * Intentionally avoids importing the React UI or registering the overlay
 * app (those require a Capacitor environment). The plugin module only
 * depends on `@elizaos/agent`, `@elizaos/core`, and the capacitor-wifi TS
 * shim.
 */

import { describe, expect, it } from "vitest";
import { appWifiPlugin } from "../src/plugin.ts";

describe("appWifiPlugin", () => {
  it("declares the canonical app name", () => {
    expect(appWifiPlugin.name).toBe("@elizaos/app-wifi");
  });

  it("exposes the SCAN_WIFI action", () => {
    const names = (appWifiPlugin.actions ?? []).map((a) => a.name);
    expect(names).toContain("SCAN_WIFI");
  });

  it("declares optional limit and maxAge parameters on SCAN_WIFI", () => {
    const scan = (appWifiPlugin.actions ?? []).find(
      (a) => a.name === "SCAN_WIFI",
    );
    const limitParam = scan?.parameters?.find((p) => p.name === "limit");
    const maxAgeParam = scan?.parameters?.find((p) => p.name === "maxAge");
    expect(limitParam?.required).toBe(false);
    expect(maxAgeParam?.required).toBe(false);
  });
});
