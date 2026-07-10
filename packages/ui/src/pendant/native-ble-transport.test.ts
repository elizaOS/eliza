/**
 * NativeBlePendantTransport protocol plumbing, against a mocked BleClient.
 *
 * Verifies the transport drives the omi UUIDs correctly, windows notification
 * DataViews into Uint8Arrays, falls back to the Opus default when the codec
 * char is unreadable, tolerates a missing battery service, normalizes a
 * cancelled chooser, and cleans up on disconnect.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type BleClientLike,
  NativeBlePendantTransport,
} from "./native-ble-transport";
import {
  BATTERY_LEVEL_CHAR_UUID_128,
  OMI_AUDIO_CODEC_CHAR_UUID,
  OMI_AUDIO_DATA_CHAR_UUID,
  OMI_AUDIO_SERVICE_UUID,
  OMI_CODEC,
} from "./omi-protocol";
import { PendantUserCancelledError } from "./pendant-transport";

/** Build a DataView over the given bytes. */
function dv(bytes: number[]): DataView {
  return new DataView(new Uint8Array(bytes).buffer);
}

interface MockClientOptions {
  deviceName?: string;
  codec?: number | "throw";
  battery?: number | "throw";
  requestThrows?: unknown;
}

function makeMockClient(opts: MockClientOptions = {}): {
  client: BleClientLike;
  audioCallbacks: Array<(v: DataView) => void>;
  batteryCallbacks: Array<(v: DataView) => void>;
  disconnectCalls: string[];
  stopCalls: Array<{ service: string; char: string }>;
} {
  const audioCallbacks: Array<(v: DataView) => void> = [];
  const batteryCallbacks: Array<(v: DataView) => void> = [];
  const disconnectCalls: string[] = [];
  const stopCalls: Array<{ service: string; char: string }> = [];

  const client: BleClientLike = {
    initialize: vi.fn(async () => {}),
    requestDevice: vi.fn(async () => {
      if (opts.requestThrows !== undefined) throw opts.requestThrows;
      return { deviceId: "dev-1", name: opts.deviceName };
    }),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async (id: string) => {
      disconnectCalls.push(id);
    }),
    read: vi.fn(async (_id, service, char) => {
      if (char === OMI_AUDIO_CODEC_CHAR_UUID) {
        if (opts.codec === "throw") throw new Error("codec unreadable");
        return dv([opts.codec ?? OMI_CODEC.OPUS_16K]);
      }
      if (char === BATTERY_LEVEL_CHAR_UUID_128) {
        if (opts.battery === "throw") throw new Error("no battery");
        return dv([opts.battery ?? 88]);
      }
      throw new Error(`unexpected read ${service}/${char}`);
    }),
    startNotifications: vi.fn(async (_id, _service, char, cb) => {
      if (char === OMI_AUDIO_DATA_CHAR_UUID) audioCallbacks.push(cb);
      else if (char === BATTERY_LEVEL_CHAR_UUID_128) batteryCallbacks.push(cb);
    }),
    stopNotifications: vi.fn(async (_id, service, char) => {
      stopCalls.push({ service, char });
    }),
  };

  return {
    client,
    audioCallbacks,
    batteryCallbacks,
    disconnectCalls,
    stopCalls,
  };
}

describe("NativeBlePendantTransport", () => {
  it("initializes with androidNeverForLocation and connects by audio service", async () => {
    const mock = makeMockClient({ deviceName: "Friend-ab12" });
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });

    const res = await t.requestAndConnect();
    expect(res.deviceName).toBe("Friend-ab12");
    expect(mock.client.initialize).toHaveBeenCalledWith({
      androidNeverForLocation: true,
    });
    expect(mock.client.requestDevice).toHaveBeenCalledWith(
      expect.objectContaining({ services: [OMI_AUDIO_SERVICE_UUID] }),
    );
    expect(mock.client.connect).toHaveBeenCalledWith(
      "dev-1",
      expect.any(Function),
    );
  });

  it("reads the codec id from the codec characteristic", async () => {
    const mock = makeMockClient({ codec: OMI_CODEC.OPUS_16K });
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    await t.requestAndConnect();
    expect(await t.readCodec()).toBe(OMI_CODEC.OPUS_16K);
  });

  it("falls back to the Opus default when the codec char is unreadable", async () => {
    const mock = makeMockClient({ codec: "throw" });
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    await t.requestAndConnect();
    expect(await t.readCodec()).toBe(OMI_CODEC.OPUS_16K);
  });

  it("delivers audio notifications windowed to their bytes", async () => {
    const mock = makeMockClient();
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    await t.requestAndConnect();

    const received: Uint8Array[] = [];
    await t.startAudio((payload) => received.push(payload));
    expect(mock.audioCallbacks).toHaveLength(1);

    // Deliver a DataView that is a *window* into a larger buffer — the transport
    // must respect the offset/length, not read the whole buffer.
    const backing = new Uint8Array([0xff, 0xff, 0x00, 0x01, 0x02, 0x03]);
    const windowed = new DataView(backing.buffer, 2, 3); // bytes [0x00,0x01,0x02]
    mock.audioCallbacks[0](windowed);

    expect(received).toHaveLength(1);
    expect(Array.from(received[0])).toEqual([0x00, 0x01, 0x02]);
  });

  it("reads initial battery and streams updates", async () => {
    const mock = makeMockClient({ battery: 73 });
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    await t.requestAndConnect();

    const updates: number[] = [];
    const initial = await t.startBattery((p) => updates.push(p));
    expect(initial).toBe(73);
    expect(mock.batteryCallbacks).toHaveLength(1);

    mock.batteryCallbacks[0](dv([42]));
    expect(updates).toEqual([42]);
  });

  it("returns null battery when the service is absent (never throws)", async () => {
    const mock = makeMockClient({ battery: "throw" });
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    await t.requestAndConnect();
    await expect(t.startBattery(() => {})).resolves.toBeNull();
  });

  it("normalizes a cancelled chooser to PendantUserCancelledError", async () => {
    const mock = makeMockClient({
      requestThrows: new Error("User cancelled the request"),
    });
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    await expect(t.requestAndConnect()).rejects.toBeInstanceOf(
      PendantUserCancelledError,
    );
  });

  it("routes a remote disconnect to the registered handler", async () => {
    const mock = makeMockClient();
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    let disconnected = false;
    t.onDisconnected(() => {
      disconnected = true;
    });
    await t.requestAndConnect();
    // The connect callback (2nd arg) is the remote-disconnect hook.
    const onDisc = (mock.client.connect as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as (id: string) => void;
    onDisc("dev-1");
    expect(disconnected).toBe(true);
  });

  it("stops notifications and disconnects on teardown", async () => {
    const mock = makeMockClient({ battery: 90 });
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    await t.requestAndConnect();
    await t.startAudio(() => {});
    await t.startBattery(() => {});

    await t.disconnect();

    expect(mock.disconnectCalls).toEqual(["dev-1"]);
    const stoppedChars = mock.stopCalls.map((c) => c.char);
    expect(stoppedChars).toContain(OMI_AUDIO_DATA_CHAR_UUID);
    expect(stoppedChars).toContain(BATTERY_LEVEL_CHAR_UUID_128);
  });

  it("disconnect is safe before connect (idempotent, no throw)", async () => {
    const mock = makeMockClient();
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    await expect(t.disconnect()).resolves.toBeUndefined();
  });
});
