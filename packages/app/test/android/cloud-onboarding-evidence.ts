/**
 * Defines the inline Android Cloud-onboarding stills required by the device
 * evidence contract. The Playwright capture and attachment metadata share one
 * descriptor so a filename or MIME-type edit cannot silently produce PNGs.
 */
import path from "node:path";

export const ANDROID_CLOUD_ONBOARDING_STILL_NAMES = [
  "sign-in-greeting",
  "home-landing",
  "reply-liveness",
] as const;

export type AndroidCloudOnboardingStillName =
  (typeof ANDROID_CLOUD_ONBOARDING_STILL_NAMES)[number];

export function buildAndroidCloudOnboardingJpegArtifact(
  artifactDir: string,
  name: AndroidCloudOnboardingStillName,
) {
  const artifactPath = path.join(artifactDir, `${name}.jpg`);
  return {
    screenshot: {
      path: artifactPath,
      fullPage: true,
      type: "jpeg" as const,
    },
    attachment: {
      path: artifactPath,
      contentType: "image/jpeg" as const,
    },
  };
}
