/** Verifies login return-to resolution through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Post-login destination resolution: explicit returnTo always wins; every
 * host defaults to the /join drop-into-chat flow. Apex /join performs a
 * trusted handoff to the paired app host. Protocol-relative values are rejected.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  consumePendingOAuthReturnTo,
  defaultLoginReturnTo,
  resolveLoginReturnTo,
  storePendingOAuthReturnTo,
} from "./login-return-to";

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
    window.sessionStorage.clear();
    window.localStorage.clear();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    });
  });

  it("defaults apex login to the /join drop-into-chat flow", () => {
    setHostname("elizacloud.ai");
    expect(defaultLoginReturnTo()).toBe("/join");
    expect(resolveLoginReturnTo(params())).toBe("/join");
  });

  it("defaults app-host login to the /join drop-into-chat flow", () => {
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
    expect(resolveLoginReturnTo(params("//evil.example"))).toBe("/join");
    expect(resolveLoginReturnTo(params("https://evil.example"))).toBe("/join");
  });

  it("restores /get-started in another same-origin tab after login", () => {
    storePendingOAuthReturnTo(params("/get-started"));

    // sessionStorage is tab-scoped; localStorage is the hand-through used by
    // OAuth popups and email magic links opened in a new tab.
    window.sessionStorage.clear();
    expect(resolveLoginReturnTo(params(), consumePendingOAuthReturnTo())).toBe(
      "/get-started",
    );
    expect(consumePendingOAuthReturnTo()).toBeNull();
  });

  it("never persists an external login destination", () => {
    storePendingOAuthReturnTo(params("https://evil.example/get-started"));
    expect(consumePendingOAuthReturnTo()).toBeNull();
  });
});
