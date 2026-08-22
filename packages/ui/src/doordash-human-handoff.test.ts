/** Tests that only authentic Cloudflare Live View action results can navigate the app Browser. */

import { describe, expect, it } from "vitest";
import { findDoorDashHumanHandoff } from "./doordash-human-handoff";

describe("DoorDash human handoff", () => {
  it("routes a successful DoorDash Live View into the Browser surface", () => {
    const liveViewUrl = "https://live.browser.run/session?token=secret";
    expect(
      findDoorDashHumanHandoff([
        {
          actionName: "DOORDASH",
          success: true,
          values: {
            provider: "doordash",
            humanInterventionRequired: true,
            humanInterventionKind: "cloudflare-browser-run",
            liveViewUrl,
          },
        },
      ]),
    ).toEqual({
      liveViewUrl,
      viewPath: `/browser?browse=${encodeURIComponent(liveViewUrl)}`,
    });
  });

  it.each([
    "http://live.browser.run/session",
    "https://live.browser.run.attacker.example/session",
    "javascript:alert(1)",
    "not-a-url",
  ])("rejects an unsafe Live View URL: %s", (liveViewUrl) => {
    expect(
      findDoorDashHumanHandoff([
        {
          actionName: "DOORDASH",
          success: true,
          values: {
            provider: "doordash",
            humanInterventionRequired: true,
            humanInterventionKind: "cloudflare-browser-run",
            liveViewUrl,
          },
        },
      ]),
    ).toBeNull();
  });
});
