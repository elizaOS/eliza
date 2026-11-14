import type { AospBuild } from "../backend/types";

export const FIXTURE_BUILDS: AospBuild[] = [
  {
    id: "fixture-android-grizzly",
    label: "Fixture Android build",
    version: "0.0.0-test",
    channel: "beta",
    targetDevice: "grizzly",
    targetId: "pixel11pro-grizzly",
    architecture: "arm64-v8a",
    publishedAt: "2026-01-01T00:00:00.000Z",
    manifestUrl: "https://example.invalid/android/manifest.json",
    sizeBytes: 8 * 1024 ** 3,
  },
  {
    id: "fixture-android-grizzly-nightly",
    label: "Fixture Android nightly build for Pixel 11 Pro",
    version: "0.0.0-test",
    channel: "beta",
    targetDevice: "grizzly",
    targetId: "pixel11pro-grizzly",
    architecture: "arm64-v8a",
    publishedAt: "2026-01-01T00:00:00.000Z",
    manifestUrl: "https://example.invalid/android/grizzly/manifest.json",
    sizeBytes: 8 * 1024 ** 3,
  },
];

export const TEST_BUILDS = FIXTURE_BUILDS;
