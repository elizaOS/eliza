import { describe, expect, it } from "vitest";
import { resolveAppUpdatePolicy } from "./update-policy";

describe("resolveAppUpdatePolicy", () => {
  it("allows forced GitHub auto-update only for direct desktop builds", () => {
    expect(
      resolveAppUpdatePolicy({
        platform: "desktop",
        native: true,
        buildVariant: "direct",
        elizaOS: false,
      }),
    ).toMatchObject({
      channel: "desktop-direct",
      authority: "github",
      canAutoUpdate: true,
      canManualCheck: true,
    });

    expect(
      resolveAppUpdatePolicy({
        platform: "desktop",
        native: true,
        buildVariant: "store",
        elizaOS: false,
      }),
    ).toMatchObject({
      channel: "desktop-store",
      authority: "store",
      canAutoUpdate: false,
      canManualCheck: false,
    });
  });

  it("keeps App Store and Play builds store-managed", () => {
    expect(
      resolveAppUpdatePolicy({
        platform: "ios",
        native: true,
        buildVariant: "store",
        elizaOS: false,
      }),
    ).toMatchObject({
      channel: "ios-app-store",
      authority: "store",
      canAutoUpdate: false,
    });

    expect(
      resolveAppUpdatePolicy({
        platform: "android",
        native: true,
        buildVariant: "store",
        elizaOS: false,
      }),
    ).toMatchObject({
      channel: "android-google-play",
      authority: "store",
      canAutoUpdate: false,
    });
  });

  it("distinguishes Android sideload from AOSP system distribution", () => {
    expect(
      resolveAppUpdatePolicy({
        platform: "android",
        native: true,
        buildVariant: "direct",
        elizaOS: false,
      }),
    ).toMatchObject({
      channel: "android-sideload",
      authority: "github",
      canAutoUpdate: false,
    });

    expect(
      resolveAppUpdatePolicy({
        platform: "android",
        native: true,
        buildVariant: "direct",
        elizaOS: true,
      }),
    ).toMatchObject({
      channel: "android-aosp",
      authority: "aosp-image",
      canAutoUpdate: false,
    });
  });

  it("never claims iOS sideload builds can install OTA binaries", () => {
    expect(
      resolveAppUpdatePolicy({
        platform: "ios",
        native: true,
        buildVariant: "direct",
        elizaOS: false,
      }),
    ).toMatchObject({
      channel: "ios-sideload",
      authority: "github",
      canAutoUpdate: false,
      canManualCheck: false,
    });
  });
});
