// @vitest-environment jsdom

/**
 * Post-login destination resolution: explicit returnTo always wins; the
 * default is host-dependent — the apex console (elizacloud.ai) lands on
 * /dashboard (the agent app never boots there), every other host keeps the
 * /join drop-into-chat flow. Protocol-relative values are rejected.
 */

import { afterEach, describe, expect, it } from "vitest";
import { defaultLoginReturnTo, resolveLoginReturnTo } from "./login-return-to";

const realLocation = window.location;
function setHostname(hostname: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...realLocation, hostname },
  });
}

function params(returnTo?: string) {
  return new URLSearchParams(returnTo ? { returnTo } : {});
}

describe("login return-to resolution", () => {
  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    });
  });

  it("defaults to the /dashboard console on an apex control-plane host", () => {
    setHostname("elizacloud.ai");
    expect(defaultLoginReturnTo()).toBe("/dashboard");
    expect(resolveLoginReturnTo(params())).toBe("/dashboard");
  });

  it("defaults to the /join drop-into-chat flow on app hosts", () => {
    setHostname("app.elizacloud.ai");
    expect(defaultLoginReturnTo()).toBe("/join");
    setHostname("localhost");
    expect(resolveLoginReturnTo(params())).toBe("/join");
  });

  it("lets an explicit returnTo win on every host", () => {
    setHostname("elizacloud.ai");
    expect(resolveLoginReturnTo(params("/dashboard/billing"))).toBe(
      "/dashboard/billing",
    );
    setHostname("app.elizacloud.ai");
    expect(resolveLoginReturnTo(params("/settings"))).toBe("/settings");
  });

  it("rejects protocol-relative and external values", () => {
    setHostname("elizacloud.ai");
    expect(resolveLoginReturnTo(params("//evil.example"))).toBe("/dashboard");
    expect(resolveLoginReturnTo(params("https://evil.example"))).toBe(
      "/dashboard",
    );
  });
});
