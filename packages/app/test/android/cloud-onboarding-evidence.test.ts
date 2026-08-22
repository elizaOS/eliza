/**
 * Locks the Android Cloud-onboarding evidence descriptors to the issue's JPG
 * contract without executing the credential- and emulator-gated live lane.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ANDROID_CLOUD_ONBOARDING_STILL_NAMES,
  buildAndroidCloudLoginCompletionRequest,
  buildAndroidCloudOnboardingJpegArtifact,
  extractAndroidCloudLoginHandoff,
  isTrustedAndroidCloudResponseUrl,
} from "./cloud-onboarding-evidence";

describe("Android Cloud-onboarding still evidence", () => {
  it("emits greeting, authenticated home, and live-reply captures as JPEG artifacts", () => {
    expect(ANDROID_CLOUD_ONBOARDING_STILL_NAMES).toEqual([
      "sign-in-greeting",
      "home-landing",
      "reply-liveness",
    ]);

    for (const name of ANDROID_CLOUD_ONBOARDING_STILL_NAMES) {
      const artifact = buildAndroidCloudOnboardingJpegArtifact(
        "/evidence/android/tap",
        name,
      );
      expect(path.basename(artifact.screenshot.path)).toBe(`${name}.jpg`);
      expect(artifact.screenshot).toMatchObject({
        fullPage: true,
        type: "jpeg",
      });
      expect(artifact.attachment).toEqual({
        path: artifact.screenshot.path,
        contentType: "image/jpeg",
      });
    }
  });

  it("extracts production and staging browser handoffs from Capacitor logcat", () => {
    const production = extractAndroidCloudLoginHandoff(
      'pluginId: Browser, url: "https:\\/\\/cloud.eliza.app\\/auth\\/cli-login?session=123e4567-e89b-42d3-a456-426614174000"',
    );
    expect(production).toEqual({
      browserUrl:
        "https://cloud.eliza.app/auth/cli-login?session=123e4567-e89b-42d3-a456-426614174000",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      apiBase: "https://api.eliza.app",
    });

    expect(
      extractAndroidCloudLoginHandoff(
        "https://cloud-staging.eliza.app/auth/cli-login?session=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      )?.apiBase,
    ).toBe("https://api-staging.eliza.app");
    expect(
      extractAndroidCloudLoginHandoff(
        "https://attacker.example/auth/cli-login?session=123e4567-e89b-42d3-a456-426614174000",
      ),
    ).toBeNull();
  });

  it("builds an authenticated completion request and rejects a missing secret", () => {
    const handoff = extractAndroidCloudLoginHandoff(
      "https://cloud.eliza.app/auth/cli-login?session=123e4567-e89b-42d3-a456-426614174000",
    );
    if (!handoff) throw new Error("Expected a valid test handoff");
    expect(
      buildAndroidCloudLoginCompletionRequest(handoff, " test-token "),
    ).toEqual({
      url: "https://api.eliza.app/api/auth/cli-session/123e4567-e89b-42d3-a456-426614174000/complete",
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    });
    expect(() =>
      buildAndroidCloudLoginCompletionRequest(handoff, "  "),
    ).toThrow(/ELIZA_CLOUD_AUTH_TOKEN/);
  });

  it("accepts shared and dedicated response authorities without trusting lookalikes", () => {
    for (const url of [
      "https://api.eliza.app/api/v1/eliza/personal",
      "https://api-staging.eliza.app/api/v1/eliza/personal",
      "https://123e4567-e89b-42d3-a456-426614174000.cloud.eliza.app/api/conversations/1/messages",
      "https://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.cloud-staging.eliza.app/api/conversations/1/messages",
    ]) {
      expect(isTrustedAndroidCloudResponseUrl(url)).toBe(true);
    }
    for (const url of [
      "https://not-a-uuid.cloud.eliza.app/api/conversations/1/messages",
      "https://123e4567-e89b-42d3-a456-426614174000.cloud.eliza.app.attacker.example/api/conversations/1/messages",
      "http://api.eliza.app/api/v1/eliza/personal",
      "https://api.eliza.app:8443/api/v1/eliza/personal",
      "https://user@api.eliza.app/api/v1/eliza/personal",
    ]) {
      expect(isTrustedAndroidCloudResponseUrl(url)).toBe(false);
    }
  });
});
