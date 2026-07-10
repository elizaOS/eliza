// @vitest-environment jsdom

/**
 * WebBluetoothPendantTransport GATT bring-up against a fake `navigator.bluetooth`
 * stack. Real EventTarget characteristics carry the notification events, so the
 * DataView-window handling, chooser-cancel normalization, optional codec/battery
 * degrades, and teardown are exercised exactly as the browser drives them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BATTERY_LEVEL_CHAR_UUID,
  BATTERY_SERVICE_UUID,
  OMI_AUDIO_CODEC_CHAR_UUID,
  OMI_AUDIO_DATA_CHAR_UUID,
  OMI_AUDIO_SERVICE_UUID,
  OMI_CODEC,
} from "./omi-protocol";
import { PendantUserCancelledError } from "./pendant-transport";
import {
  isWebBluetoothAvailable,
  WebBluetoothPendantTransport,
} from "./web-bluetooth-transport";

class FakeCharacteristic extends EventTarget {
  value: DataView | undefined;
  startNotifications = vi.fn(async () => this);
  stopNotifications = vi.fn(async () => this);

  constructor(value?: DataView) {
    super();
    this.value = value;
  }

  notify(value: DataView): void {
    this.value = value;
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }

  async readValue(): Promise<DataView> {
    if (!this.value) throw new Error("no value");
    return this.value;
  }
}

function byteView(bytes: number[]): DataView {
  return new DataView(Uint8Array.from(bytes).buffer);
}

interface FakeGattSetup {
  codecChar?: FakeCharacteristic | null;
  batteryService?: boolean;
  deviceName?: string;
  withGatt?: boolean;
}

function installFakeBluetooth(setup: FakeGattSetup = {}) {
  const audioChar = new FakeCharacteristic();
  const codecChar =
    setup.codecChar === undefined
      ? new FakeCharacteristic(byteView([OMI_CODEC.OPUS_16K]))
      : setup.codecChar;
  const batteryChar = new FakeCharacteristic(byteView([87]));

  const audioService = {
    getCharacteristic: vi.fn(async (uuid: string) => {
      if (uuid === OMI_AUDIO_DATA_CHAR_UUID) return audioChar;
      if (uuid === OMI_AUDIO_CODEC_CHAR_UUID && codecChar) return codecChar;
      throw new Error(`no characteristic ${uuid}`);
    }),
  };
  const batteryService = {
    getCharacteristic: vi.fn(async (uuid: string) => {
      if (uuid === BATTERY_LEVEL_CHAR_UUID) return batteryChar;
      throw new Error(`no characteristic ${uuid}`);
    }),
  };
  const server = {
    connected: true,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getPrimaryService: vi.fn(async (uuid: string) => {
      if (uuid === OMI_AUDIO_SERVICE_UUID) return audioService;
      if (uuid === BATTERY_SERVICE_UUID && setup.batteryService !== false) {
        return batteryService;
      }
      throw new Error(`no service ${uuid}`);
    }),
  };
  server.connect.mockImplementation(async () => server);

  const device = new EventTarget() as EventTarget & {
    id: string;
    name?: string;
    gatt?: typeof server;
  };
  device.id = "fake-pendant";
  device.name = setup.deviceName;
  if (setup.withGatt !== false) device.gatt = server;

  const requestDevice = vi.fn(async (_options?: unknown) => device);
  Object.defineProperty(navigator, "bluetooth", {
    configurable: true,
    value: { requestDevice, getAvailability: async () => true },
  });

  return { audioChar, codecChar, batteryChar, server, device, requestDevice };
}

function uninstallFakeBluetooth(): void {
  Object.defineProperty(navigator, "bluetooth", {
    configurable: true,
    value: undefined,
  });
}

describe("WebBluetoothPendantTransport", () => {
  afterEach(() => {
    uninstallFakeBluetooth();
    vi.restoreAllMocks();
  });

  it("reports Web Bluetooth availability from the requestDevice probe", () => {
    expect(isWebBluetoothAvailable()).toBe(false);
    installFakeBluetooth();
    expect(isWebBluetoothAvailable()).toBe(true);
  });

  it("throws a fatal typed error when Web Bluetooth is absent", async () => {
    const transport = new WebBluetoothPendantTransport();
    await expect(transport.requestAndConnect()).rejects.toMatchObject({
      code: "PENDANT_WEB_BLUETOOTH_UNAVAILABLE",
    });
  });

  it("connects: chooser filters by name prefix + audio service, links GATT, resolves the device name", async () => {
    const fake = installFakeBluetooth({ deviceName: "Friend-DK1" });
    const transport = new WebBluetoothPendantTransport();

    const result = await transport.requestAndConnect();

    expect(result.deviceName).toBe("Friend-DK1");
    const options = fake.requestDevice.mock.calls[0]?.[0] as {
      filters: Array<Record<string, unknown>>;
      optionalServices: string[];
    };
    expect(options.filters).toContainEqual({
      services: [OMI_AUDIO_SERVICE_UUID],
    });
    expect(options.filters.some((f) => typeof f.namePrefix === "string")).toBe(
      true,
    );
    expect(options.optionalServices).toContain(BATTERY_SERVICE_UUID);
    expect(fake.server.getPrimaryService).toHaveBeenCalledWith(
      OMI_AUDIO_SERVICE_UUID,
    );
  });

  it("resolves a null device name when the pendant advertises none", async () => {
    installFakeBluetooth();
    const transport = new WebBluetoothPendantTransport();
    await expect(transport.requestAndConnect()).resolves.toEqual({
      deviceName: null,
    });
  });

  it("normalizes a cancelled chooser (NotFoundError) into PendantUserCancelledError", async () => {
    const fake = installFakeBluetooth();
    fake.requestDevice.mockRejectedValue(
      new DOMException("user cancelled", "NotFoundError"),
    );
    const transport = new WebBluetoothPendantTransport();
    await expect(transport.requestAndConnect()).rejects.toBeInstanceOf(
      PendantUserCancelledError,
    );
  });

  it("rethrows non-cancellation chooser failures untouched", async () => {
    const fake = installFakeBluetooth();
    fake.requestDevice.mockRejectedValue(
      new DOMException("adapter off", "NetworkError"),
    );
    const transport = new WebBluetoothPendantTransport();
    await expect(transport.requestAndConnect()).rejects.toMatchObject({
      name: "NetworkError",
    });
  });

  it("fails loud when the chosen device exposes no GATT server", async () => {
    installFakeBluetooth({ withGatt: false });
    const transport = new WebBluetoothPendantTransport();
    await expect(transport.requestAndConnect()).rejects.toMatchObject({
      code: "PENDANT_GATT_SERVER_UNAVAILABLE",
    });
  });

  it("reads the advertised codec and falls back to the DK1 Opus default when the characteristic is missing", async () => {
    installFakeBluetooth({
      codecChar: new FakeCharacteristic(byteView([OMI_CODEC.PCM_8K])),
    });
    const transport = new WebBluetoothPendantTransport();
    await transport.requestAndConnect();
    await expect(transport.readCodec()).resolves.toBe(OMI_CODEC.PCM_8K);

    uninstallFakeBluetooth();
    installFakeBluetooth({ codecChar: null });
    const dk1 = new WebBluetoothPendantTransport();
    await dk1.requestAndConnect();
    await expect(dk1.readCodec()).resolves.toBe(OMI_CODEC.OPUS_16K);
  });

  it("defaults the codec before any connection exists", async () => {
    const transport = new WebBluetoothPendantTransport();
    await expect(transport.readCodec()).resolves.toBe(OMI_CODEC.OPUS_16K);
  });

  it("streams audio notifications respecting the DataView window into its buffer", async () => {
    const fake = installFakeBluetooth();
    const transport = new WebBluetoothPendantTransport();
    await transport.requestAndConnect();

    const frames: Uint8Array[] = [];
    await transport.startAudio((payload) => frames.push(payload));
    expect(fake.audioChar.startNotifications).toHaveBeenCalledTimes(1);

    // A 3-byte window at offset 2 of a larger buffer must yield exactly those
    // 3 bytes — not the whole backing buffer.
    const backing = Uint8Array.from([9, 9, 1, 2, 3, 9]).buffer;
    fake.audioChar.notify(new DataView(backing, 2, 3));

    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0] ?? [])).toEqual([1, 2, 3]);
  });

  it("refuses to start audio before a connection", async () => {
    const transport = new WebBluetoothPendantTransport();
    await expect(transport.startAudio(() => {})).rejects.toMatchObject({
      code: "PENDANT_AUDIO_SERVICE_NOT_CONNECTED",
    });
  });

  it("reads the initial battery level and forwards battery notifications", async () => {
    const fake = installFakeBluetooth();
    const transport = new WebBluetoothPendantTransport();
    await transport.requestAndConnect();

    const levels: number[] = [];
    await expect(
      transport.startBattery((pct) => levels.push(pct)),
    ).resolves.toBe(87);
    fake.batteryChar.notify(byteView([42]));
    expect(levels).toEqual([42]);
  });

  it("degrades to a null battery level when the battery service is absent", async () => {
    installFakeBluetooth({ batteryService: false });
    const transport = new WebBluetoothPendantTransport();
    await transport.requestAndConnect();
    await expect(transport.startBattery(() => {})).resolves.toBeNull();
  });

  it("returns null battery before any connection", async () => {
    const transport = new WebBluetoothPendantTransport();
    await expect(transport.startBattery(() => {})).resolves.toBeNull();
  });

  it("fires the registered disconnect handler on a remote gattserverdisconnected", async () => {
    const fake = installFakeBluetooth();
    const transport = new WebBluetoothPendantTransport();
    await transport.requestAndConnect();

    const onDisconnect = vi.fn();
    transport.onDisconnected(onDisconnect);
    fake.device.dispatchEvent(new Event("gattserverdisconnected"));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("disconnect stops notifications, drops the GATT link, and silences further events", async () => {
    const fake = installFakeBluetooth();
    const transport = new WebBluetoothPendantTransport();
    await transport.requestAndConnect();

    const frames: Uint8Array[] = [];
    const onDisconnect = vi.fn();
    await transport.startAudio((payload) => frames.push(payload));
    transport.onDisconnected(onDisconnect);

    await transport.disconnect();

    expect(fake.audioChar.stopNotifications).toHaveBeenCalledTimes(1);
    expect(fake.server.disconnect).toHaveBeenCalledTimes(1);
    fake.audioChar.notify(byteView([1]));
    fake.device.dispatchEvent(new Event("gattserverdisconnected"));
    expect(frames).toHaveLength(0);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("disconnect survives a stopNotifications failure on an already-lost link", async () => {
    const fake = installFakeBluetooth();
    const transport = new WebBluetoothPendantTransport();
    await transport.requestAndConnect();
    await transport.startAudio(() => {});
    fake.audioChar.stopNotifications.mockRejectedValue(
      new Error("GATT operation failed"),
    );
    fake.server.disconnect.mockImplementation(() => {
      throw new Error("already disconnected");
    });

    await expect(transport.disconnect()).resolves.toBeUndefined();
  });
});
