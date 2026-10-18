import type { LoginProviders } from "@elizaos/auth";
import { describe, expect, it } from "vitest";
import { selectStewardLoginMethods } from "./steward-login-methods";

const discovered: LoginProviders = {
  passkey: true,
  email: true,
  sms: true,
  siwe: true,
  siws: true,
  google: true,
  discord: true,
  github: true,
  twitter: true,
  telegram: true,
  oauth: ["google", "discord", "apple"],
  captcha: {
    enabled: true,
    provider: "turnstile",
    siteKey: "public-site-key",
    requiredFor: ["email_otp", "sms_otp"],
  },
};

describe("selected login presentation", () => {
  it("leaves the full Cloud discovery object unchanged by default", () => {
    expect(selectStewardLoginMethods(discovered)).toBe(discovered);
    expect(
      selectStewardLoginMethods(null, ["google", "email", "sms"]),
    ).toBeNull();
  });

  it("restricts display without mutating shared capabilities or losing captcha requirements", () => {
    const snapshot = JSON.stringify(discovered);
    const selected = selectStewardLoginMethods(discovered, [
      "google",
      "email",
      "sms",
    ]);
    expect(selected).toMatchObject({
      email: true,
      sms: true,
      google: true,
      passkey: false,
      siwe: false,
      siws: false,
      discord: false,
      github: false,
      twitter: false,
      telegram: false,
      oauth: ["google"],
    });
    expect(selected?.captcha).toBe(discovered.captcha);
    expect(JSON.stringify(discovered)).toBe(snapshot);
  });

  it("never enables a selected method absent from server discovery", () => {
    const selected = selectStewardLoginMethods(
      {
        ...discovered,
        email: false,
        sms: false,
        google: false,
        oauth: ["discord"],
      },
      ["google", "email", "sms"],
    );
    expect(selected).toMatchObject({
      email: false,
      sms: false,
      google: false,
      oauth: [],
    });
  });

  it("can present only Google while preserving its discovered OAuth capability", () => {
    const selected = selectStewardLoginMethods(
      { ...discovered, google: false },
      ["google"],
    );
    expect(selected).toMatchObject({
      email: false,
      sms: false,
      google: false,
      oauth: ["google"],
    });
  });
});
