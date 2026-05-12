import { describe, expect, it } from "vitest";
import {
  ANDROID_AVF_MICRODROID_REQUEST_CONTRACT_VERSION,
  createAndroidAvfMicrodroidBoundaryFromNative,
  createAndroidAvfMicrodroidFeatureProbe,
} from "./android-avf-microdroid-bridge";

describe("Android AVF/Microdroid native bridge", () => {
  it("returns an Android feature probe even when the native bridge is missing", () => {
    expect(createAndroidAvfMicrodroidFeatureProbe({})).toEqual({
      platform: "android",
      androidAvfAvailable: false,
      androidMicrodroidAvailable: false,
      androidAvfPayloadAvailable: false,
      androidAvfCapabilityState: "framework-unavailable",
      env: {
        ELIZA_PLATFORM: "android",
        ELIZA_ANDROID_AVF_MICRODROID_STATE: "framework-unavailable",
      },
      globals: { AndroidVirtualization: undefined },
    });
  });

  it("maps native virtualization probe JSON into mobile-safe runtime features", () => {
    const featureProbe = createAndroidAvfMicrodroidFeatureProbe({
      ElizaNative: {
        getAndroidVirtualization: () =>
          JSON.stringify({
            state: "payload-missing",
            available: false,
            avfAvailable: true,
            microdroidAvailable: true,
            payloadAvailable: false,
            apiLevel: 35,
            capabilities: ["protected-vm"],
          }),
      },
    });

    expect(featureProbe.androidAvfAvailable).toBe(true);
    expect(featureProbe.androidMicrodroidAvailable).toBe(true);
    expect(featureProbe.androidAvfPayloadAvailable).toBe(false);
    expect(featureProbe.androidAvfCapabilityState).toBe("payload-missing");
    expect(featureProbe.env).toMatchObject({
      ELIZA_PLATFORM: "android",
      ELIZA_ANDROID_AVF_AVAILABLE: "1",
      ELIZA_ANDROID_MICRODROID_AVAILABLE: "1",
      ELIZA_ANDROID_AVF_MICRODROID_STATE: "payload-missing",
    });
    expect(featureProbe.globals?.AndroidVirtualization).toMatchObject({
      state: "payload-missing",
      available: false,
      avfAvailable: true,
      microdroidAvailable: true,
      apiLevel: 35,
    });
  });

  it("marks Android AVF/Microdroid ready only when a payload boundary is reported", () => {
    const featureProbe = createAndroidAvfMicrodroidFeatureProbe({
      ElizaNative: {
        getAndroidVirtualization: () =>
          JSON.stringify({
            state: "ready",
            available: true,
            avfAvailable: true,
            microdroidAvailable: true,
            payloadAvailable: true,
            requestContractVersion:
              ANDROID_AVF_MICRODROID_REQUEST_CONTRACT_VERSION,
          }),
      },
    });

    expect(featureProbe.androidAvfCapabilityState).toBe("ready");
    expect(featureProbe.androidAvfPayloadAvailable).toBe(true);
    expect(featureProbe.env).toMatchObject({
      ELIZA_ANDROID_MICRODROID_PAYLOAD_READY: "1",
      ELIZA_ANDROID_AVF_MICRODROID_STATE: "ready",
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
      androidAvfPayloadAvailable: false,
      androidAvfCapabilityState: "framework-unavailable",
      env: {
        ELIZA_PLATFORM: "android",
        ELIZA_ANDROID_AVF_MICRODROID_STATE: "framework-unavailable",
      },
      globals: { AndroidVirtualization: undefined },
    });
  });

  it("creates a request boundary from the native bridge", async () => {
    const boundary = createAndroidAvfMicrodroidBoundaryFromNative({
      ElizaNative: {
        getAndroidVirtualization: () =>
          JSON.stringify({
            state: "ready",
            available: true,
            avfAvailable: true,
            microdroidAvailable: true,
            payloadAvailable: true,
          }),
        requestAndroidVirtualization: (requestJson) => {
          const request = JSON.parse(requestJson) as {
            id: string;
            contractVersion: number;
          };
          expect(request.contractVersion).toBe(
            ANDROID_AVF_MICRODROID_REQUEST_CONTRACT_VERSION,
          );
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

  it("fails closed locally when the native probe reports no Microdroid payload", async () => {
    let called = false;
    const boundary = createAndroidAvfMicrodroidBoundaryFromNative({
      ElizaNative: {
        getAndroidVirtualization: () =>
          JSON.stringify({
            state: "payload-missing",
            available: false,
            avfAvailable: true,
            microdroidAvailable: true,
            payloadAvailable: false,
          }),
        requestAndroidVirtualization: () => {
          called = true;
          return null;
        },
      },
    });

    await expect(
      boundary?.request({
        id: "request-payload-missing",
        capability: "app.run",
        operation: "execute",
        args: { code: "export default {}" },
      }),
    ).resolves.toMatchObject({
      id: "request-payload-missing",
      ok: false,
      error: {
        code: "ANDROID_AVF_MICRODROID_PAYLOAD_MISSING",
        retryable: false,
      },
    });
    expect(called).toBe(false);
  });

  it("returns a structured error for malformed native request responses", async () => {
    const boundary = createAndroidAvfMicrodroidBoundaryFromNative({
      ElizaNative: {
        getAndroidVirtualization: () =>
          JSON.stringify({
            state: "ready",
            available: true,
            avfAvailable: true,
            microdroidAvailable: true,
            payloadAvailable: true,
          }),
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
