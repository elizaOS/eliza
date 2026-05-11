import { describe, expect, it } from "vitest";
import {
  createAndroidAvfMicrodroidBoundaryFromNative,
  createAndroidAvfMicrodroidFeatureProbe,
} from "./android-avf-microdroid-bridge";

describe("Android AVF/Microdroid native bridge", () => {
  it("returns an Android feature probe even when the native bridge is missing", () => {
    expect(createAndroidAvfMicrodroidFeatureProbe({})).toEqual({
      platform: "android",
      androidAvfAvailable: false,
      androidMicrodroidAvailable: false,
      env: { ELIZA_PLATFORM: "android" },
      globals: { AndroidVirtualization: undefined },
    });
  });

  it("maps native virtualization probe JSON into mobile-safe runtime features", () => {
    const featureProbe = createAndroidAvfMicrodroidFeatureProbe({
      ElizaNative: {
        getAndroidVirtualization: () =>
          JSON.stringify({
            available: true,
            microdroidAvailable: true,
            apiLevel: 35,
            capabilities: ["protected-vm"],
          }),
      },
    });

    expect(featureProbe.androidAvfAvailable).toBe(true);
    expect(featureProbe.androidMicrodroidAvailable).toBe(true);
    expect(featureProbe.env).toMatchObject({
      ELIZA_PLATFORM: "android",
      ELIZA_ANDROID_AVF_AVAILABLE: "1",
      ELIZA_ANDROID_MICRODROID_AVAILABLE: "1",
    });
    expect(featureProbe.globals?.AndroidVirtualization).toMatchObject({
      available: true,
      microdroidAvailable: true,
      apiLevel: 35,
    });
  });

  it("treats malformed native probe JSON as unavailable", () => {
    const featureProbe = createAndroidAvfMicrodroidFeatureProbe({
      ElizaNative: {
        getAndroidVirtualization: () => "{not-json",
      },
    });

    expect(featureProbe).toEqual({
      platform: "android",
      androidAvfAvailable: false,
      androidMicrodroidAvailable: false,
      env: { ELIZA_PLATFORM: "android" },
      globals: { AndroidVirtualization: undefined },
    });
  });

  it("creates a request boundary from the native bridge", async () => {
    const boundary = createAndroidAvfMicrodroidBoundaryFromNative({
      ElizaNative: {
        requestAndroidVirtualization: (requestJson) => {
          const request = JSON.parse(requestJson) as { id: string };
          return JSON.stringify({
            id: request.id,
            ok: true,
            result: { accepted: true },
          });
        },
      },
    });

    await expect(
      boundary?.request({
        id: "request-1",
        capability: "app.run",
        operation: "execute",
        args: { code: "export default {}" },
      }),
    ).resolves.toEqual({
      id: "request-1",
      ok: true,
      result: { accepted: true },
    });
  });

  it("returns a structured error for malformed native request responses", async () => {
    const boundary = createAndroidAvfMicrodroidBoundaryFromNative({
      ElizaNative: {
        requestAndroidVirtualization: () => "{not-json",
      },
    });

    await expect(
      boundary?.request({
        id: "request-2",
        capability: "app.run",
        operation: "execute",
        args: { code: "export default {}" },
      }),
    ).resolves.toMatchObject({
      id: "request-2",
      ok: false,
      error: {
        code: "ANDROID_AVF_INVALID_RESPONSE",
        retryable: false,
      },
    });
  });
});
