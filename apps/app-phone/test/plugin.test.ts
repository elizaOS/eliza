/**
 * Plugin smoke test — verifies the Phone runtime plugin shape and metadata.
 *
 * This intentionally avoids importing the React UI or registering the overlay
 * app (those require a Capacitor environment). The plugin module only depends
 * on shared role helpers, `@elizaos/core`, and the capacitor-phone TS shim.
 */

import { describe, expect, it } from "vitest";
import { appPhonePlugin } from "../src/plugin.ts";

describe("appPhonePlugin", () => {
  it("declares the canonical app name", () => {
    expect(appPhonePlugin.name).toBe("@elizaos/app-phone");
  });

  it("exposes PLACE_CALL and READ_CALL_LOG actions", () => {
    const names = (appPhonePlugin.actions ?? []).map((a) => a.name);
    expect(names).toContain("PLACE_CALL");
    expect(names).toContain("READ_CALL_LOG");
  });

  it("requires a phoneNumber parameter on PLACE_CALL", () => {
    const placeCall = (appPhonePlugin.actions ?? []).find(
      (a) => a.name === "PLACE_CALL",
    );
    const phoneNumberParam = placeCall?.parameters?.find(
      (p) => p.name === "phoneNumber",
    );
    expect(phoneNumberParam?.required).toBe(true);
  });
});
