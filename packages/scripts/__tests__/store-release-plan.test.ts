/**
 * Proves that one canonical semver maps monotonically and deterministically to
 * every store's version and promotion channel without publisher credentials.
 */

import { describe, expect, test } from "bun:test";
import {
  createStoreReleasePlan,
  parseStoreSemver,
} from "../store-release-plan.mjs";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";

describe("store release plan", () => {
  test("maps a stable release to production channels", () => {
    expect(
      createStoreReleasePlan({
        version: "2.3.4",
        channel: "latest",
        sourceSha: SOURCE_SHA,
      }),
    ).toMatchObject({
      tag: "v2.3.4",
      stable: true,
      android_version_code: "203049000",
      android_track: "production",
      ios_marketing_version: "2.3.4",
      ios_build_number: "203049000",
      apple_lane: "release",
      windows_package_version: "2.3.4.0",
      windows_publish: true,
      snap_channel: "stable",
      extension_version: "2.3.4.60000",
      chrome_publish_target: "default",
      flathub_branch: "stable",
    });
  });

  test("maps beta releases to testing channels and monotonic build numbers", () => {
    const beta0 = createStoreReleasePlan({
      version: "2.3.4-beta.0",
      channel: "beta",
      sourceSha: SOURCE_SHA,
    });
    const beta9 = createStoreReleasePlan({
      version: "2.3.4-beta.9",
      channel: "beta",
      sourceSha: SOURCE_SHA,
    });
    const stable = createStoreReleasePlan({
      version: "2.3.4",
      channel: "latest",
      sourceSha: SOURCE_SHA,
    });

    expect(beta0).toMatchObject({
      android_track: "internal",
      apple_lane: "beta",
      windows_package_version: "2.3.4.0",
      windows_publish: false,
      snap_channel: "beta",
      extension_version: "2.3.4.20000",
      chrome_publish_target: "trustedTesters",
      flathub_branch: "beta",
    });
    expect(Number(beta9.android_version_code)).toBeGreaterThan(
      Number(beta0.android_version_code),
    );
    expect(Number(stable.android_version_code)).toBeGreaterThan(
      Number(beta9.android_version_code),
    );
  });

  test("rejects ambiguous or mismatched release identities", () => {
    expect(() => parseStoreSemver("2.3.4-beta.one")).toThrow();
    expect(() =>
      createStoreReleasePlan({
        version: "2.3.4-beta.0",
        channel: "latest",
        sourceSha: SOURCE_SHA,
      }),
    ).toThrow("does not match");
    expect(() =>
      createStoreReleasePlan({
        version: "2.3.4",
        channel: "latest",
        sourceSha: "deadbeef",
      }),
    ).toThrow("40 lowercase hex");
  });
});
