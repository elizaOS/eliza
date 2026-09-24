import type { AospBuild } from "../backend/types";

export const FIXTURE_BUILDS: AospBuild[] = [
  {
    id: "fixture-android-tegu",
    label: "Fixture Android build",
    version: "0.0.0-test",
    channel: "beta",
    targetDevice: "tegu",
    targetId: "pixel9a-tegu",
    architecture: "arm64-v8a",
    publishedAt: "2026-01-01T00:00:00.000Z",
    manifestUrl: "https://example.invalid/android/manifest.json",
    sizeBytes: 8 * 1024 ** 3,
  },
  {
    id: "fixture-android-tegu-nightly",
    label: "Fixture Android nightly build for Pixel 9a",
    version: "0.0.0-test",
    channel: "beta",
    targetDevice: "tegu",
    targetId: "pixel9a-tegu",
    architecture: "arm64-v8a",
    publishedAt: "2026-01-01T00:00:00.000Z",
    manifestUrl: "https://example.invalid/android/tegu/manifest.json",
    sizeBytes: 8 * 1024 ** 3,
  },
];

export const TEST_BUILDS = FIXTURE_BUILDS;
