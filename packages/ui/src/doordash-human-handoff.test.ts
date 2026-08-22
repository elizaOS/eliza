/** Tests that DoorDash handoffs route only validated Live View or native provider targets. */

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

  it("prefers native DoorDash when Cloudflare Browser Run is provider-blocked", () => {
    const liveViewUrl = "https://live.browser.run/session?token=secret";
    const nativeUrl = "https://www.doordash.com/consumer/login";
    expect(
      findDoorDashHumanHandoff([
        {
          actionName: "DOORDASH",
          success: true,
          values: {
            provider: "doordash",
            humanInterventionRequired: true,
            humanInterventionKind: "cloudflare-browser-run",
            providerBlocked: true,
            liveViewUrl,
            nativeAppDeepLink: `elizaos://browser?browse=${encodeURIComponent(nativeUrl)}`,
          },
        },
      ]),
    ).toEqual({
      liveViewUrl,
      viewPath: `/browser?browse=${encodeURIComponent(nativeUrl)}`,
    });
  });

  it("falls back to validated Live View when a native fallback is unsafe", () => {
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
            providerBlocked: true,
            liveViewUrl,
            nativeAppDeepLink:
              "elizaos://browser?browse=https%3A%2F%2Fattacker.example%2Flogin",
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
