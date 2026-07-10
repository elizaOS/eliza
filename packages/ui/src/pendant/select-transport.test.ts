/**
 * Transport selection: native Android → native BLE, else Web Bluetooth, else
 * unsupported.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock @capacitor/core so we can flip platform per test.
const capacitorState = { native: false, platform: "web" as string };
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => capacitorState.native,
    getPlatform: () => capacitorState.platform,
  },
}));

import { NativeBlePendantTransport } from "./native-ble-transport";
import {
  isNativeAndroid,
  isPendantSupported,
  selectPendantTransport,
} from "./select-transport";
import { WebBluetoothPendantTransport } from "./web-bluetooth-transport";

function setPlatform(native: boolean, platform: string): void {
  capacitorState.native = native;
  capacitorState.platform = platform;
}

function setWebBluetooth(available: boolean): void {
  if (available) {
    (navigator as unknown as { bluetooth: unknown }).bluetooth = {
      requestDevice: () => Promise.resolve({}),
    };
  } else {
    delete (navigator as unknown as { bluetooth?: unknown }).bluetooth;
  }
}

afterEach(() => {
  setPlatform(false, "web");
  setWebBluetooth(false);
  vi.restoreAllMocks();
});

describe("selectPendantTransport", () => {
  it("picks the native BLE transport on native Android", () => {
    setPlatform(true, "android");
    setWebBluetooth(false);
    const t = selectPendantTransport();
    expect(t).toBeInstanceOf(NativeBlePendantTransport);
    expect(t?.kind).toBe("native-ble");
  });

  it("prefers native BLE on Android even if Web Bluetooth is also present", () => {
    setPlatform(true, "android");
    setWebBluetooth(true);
    const t = selectPendantTransport();
    expect(t).toBeInstanceOf(NativeBlePendantTransport);
  });

  it("picks Web Bluetooth in a browser with the API", () => {
    setPlatform(false, "web");
    setWebBluetooth(true);
    const t = selectPendantTransport();
    expect(t).toBeInstanceOf(WebBluetoothPendantTransport);
    expect(t?.kind).toBe("web-bluetooth");
  });

  it("returns null when unsupported (no native, no Web Bluetooth)", () => {
    setPlatform(false, "web");
    setWebBluetooth(false);
    expect(selectPendantTransport()).toBeNull();
  });

  it("does NOT use native BLE on native iOS (only android)", () => {
    setPlatform(true, "ios");
    setWebBluetooth(false);
    // iOS native path is separate; without Web Bluetooth this is unsupported here.
    expect(selectPendantTransport()).toBeNull();
    expect(isNativeAndroid()).toBe(false);
  });
});

describe("isPendantSupported", () => {
  it("is true on native Android", () => {
    setPlatform(true, "android");
    setWebBluetooth(false);
    expect(isPendantSupported()).toBe(true);
  });

  it("is true with Web Bluetooth", () => {
    setPlatform(false, "web");
    setWebBluetooth(true);
    expect(isPendantSupported()).toBe(true);
  });

  it("is false with neither", () => {
    setPlatform(false, "web");
    setWebBluetooth(false);
    expect(isPendantSupported()).toBe(false);
  });
});
