import { describe, expect, test } from "bun:test";
import {
  googlePersonalContextConsent,
  isGooglePersonalContextConsent,
  selectedGoogleContextConsent,
} from "./shared-google-consent";

describe("Google personal-context purpose contract", () => {
  test("only disclosed read purpose permits requested-content processing", () => {
    const consent = googlePersonalContextConsent();
    expect(isGooglePersonalContextConsent(consent)).toBe(true);
    expect(consent.backgroundImport).toBe(false);
    for (const wrong of [
      { ...consent, backgroundImport: true },
      { ...consent, version: 2 },
      { ...consent, modelProcessing: "all_history" },
      { ...consent, features: ["gmail.send"] },
    ]) {
      expect(isGooglePersonalContextConsent(wrong)).toBe(false);
    }
  });
  test("legacy grants cannot silently authorize model context", () => {
    for (const prefs of [
      null,
      "{}",
      '{"googleConnected":true}',
      "not json",
      JSON.stringify({ personalGoogleContext: { grantId: "legacy" } }),
    ]) {
      expect(selectedGoogleContextConsent(prefs)).toBeUndefined();
    }
  });
  test("callback grant is selected explicitly without consuming unrelated preferences", () => {
    const consent = googlePersonalContextConsent(),
      grantId = "11111111-1111-4111-8111-111111111111";
    const prefs = { theme: "dark", personalGoogleContext: { ...consent, grantId } };
    expect(selectedGoogleContextConsent(JSON.stringify(prefs))).toEqual({ ...consent, grantId });
    expect(prefs.theme).toBe("dark");
  });
});
