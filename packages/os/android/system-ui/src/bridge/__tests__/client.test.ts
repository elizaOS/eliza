import { describe, expect, it, vi } from "vitest";
import type {
  AudioState,
  BatteryState,
  CellState,
  SystemTime,
  WifiState,
} from "../../types";
import {
  ANDROID_BRIDGE_CHANNELS,
  type ConnectivityState,
  type LockscreenState,
} from "../bridge-contract";
import { createAndroidBridgeClient } from "../client";
import type { BridgeTransport } from "../transport";

interface Recorder {
  onCalls: Array<{ channel: string }>;
  sendCalls: Array<{ channel: string; payload: unknown }>;
  emit(channel: string, payload: unknown): void;
}

function makeTransport(): { transport: BridgeTransport; rec: Recorder } {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const rec: Recorder = {
    onCalls: [],
    sendCalls: [],
    emit(channel, payload) {
      const set = handlers.get(channel);
      if (!set) return;
      for (const h of set) h(payload);
    },
  };
  const transport: BridgeTransport = {
    on<T>(channel: string, handler: (payload: T) => void) {
      rec.onCalls.push({ channel });
      const cast = handler as (payload: unknown) => void;
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(cast);
      return () => {
        set?.delete(cast);
      };
    },
    send: vi.fn(async (channel: string, payload: unknown) => {
      rec.sendCalls.push({ channel, payload });
      return { ok: true } as never;
    }),
  };
  return { transport, rec };
}

describe("createAndroidBridgeClient", () => {
  it("subscribes to every documented state channel", () => {
    const { transport, rec } = makeTransport();
    const client = createAndroidBridgeClient(transport);

    const wifi: WifiState[] = [];
    const cell: CellState[] = [];
    const audio: AudioState[] = [];
    const battery: BatteryState[] = [];
    const time: SystemTime[] = [];
    const conn: ConnectivityState[] = [];
    const lock: LockscreenState[] = [];

    client.subscribeWifi((s) => wifi.push(s));
    client.subscribeCell((s) => cell.push(s));
    client.subscribeAudio((s) => audio.push(s));
    client.subscribeBattery((s) => battery.push(s));
    client.subscribeTime((s) => time.push(s));
    client.subscribeConnectivity((s) => conn.push(s));
    client.subscribeLockscreen((s) => lock.push(s));

    expect(rec.onCalls.map((c) => c.channel)).toEqual([
      ANDROID_BRIDGE_CHANNELS.wifi.state,
      ANDROID_BRIDGE_CHANNELS.cell.state,
      ANDROID_BRIDGE_CHANNELS.audio.state,
      ANDROID_BRIDGE_CHANNELS.battery.state,
      ANDROID_BRIDGE_CHANNELS.time.state,
      ANDROID_BRIDGE_CHANNELS.connectivity.state,
      ANDROID_BRIDGE_CHANNELS.lockscreen.state,
    ]);

    rec.emit(ANDROID_BRIDGE_CHANNELS.wifi.state, { connected: true });
    rec.emit(ANDROID_BRIDGE_CHANNELS.cell.state, {
      strengthBars: 3,
      airplaneMode: false,
    });
    rec.emit(ANDROID_BRIDGE_CHANNELS.audio.state, { level: 0.7, muted: false });
    rec.emit(ANDROID_BRIDGE_CHANNELS.battery.state, {
      percent: 50,
      charging: false,
    });
    rec.emit(ANDROID_BRIDGE_CHANNELS.time.state, {
      now: 1,
      locale: "en-US",
      timeZone: "UTC",
    });
    rec.emit(ANDROID_BRIDGE_CHANNELS.connectivity.state, {
      network: "wifi",
      metered: false,
    });
    rec.emit(ANDROID_BRIDGE_CHANNELS.lockscreen.state, {
      locked: true,
      secure: true,
    });

    expect(wifi).toHaveLength(1);
    expect(cell).toHaveLength(1);
    expect(audio).toHaveLength(1);
    expect(battery).toHaveLength(1);
    expect(time).toHaveLength(1);
    expect(conn).toHaveLength(1);
    expect(lock).toHaveLength(1);
  });

  it("sends typed audio, power, settings, lockscreen, airplane commands", async () => {
    const { transport, rec } = makeTransport();
    const client = createAndroidBridgeClient(transport);

    await client.setAudioLevel(0.25);
    await client.setAudioMuted(true);
    await client.toggleAirplaneMode();
    await client.shutdown();
    await client.restart();
    await client.sleep();
    await client.openSettings();
    await client.dismissLockscreen();

    expect(rec.sendCalls).toEqual([
      {
        channel: ANDROID_BRIDGE_CHANNELS.audio.setLevel,
        payload: { level: 0.25 },
      },
      {
        channel: ANDROID_BRIDGE_CHANNELS.audio.setMuted,
        payload: { muted: true },
      },
      {
        channel: ANDROID_BRIDGE_CHANNELS.cell.toggleAirplaneMode,
        payload: {},
      },
      { channel: ANDROID_BRIDGE_CHANNELS.power.shutdown, payload: {} },
      { channel: ANDROID_BRIDGE_CHANNELS.power.restart, payload: {} },
      { channel: ANDROID_BRIDGE_CHANNELS.power.sleep, payload: {} },
      { channel: ANDROID_BRIDGE_CHANNELS.settings.open, payload: {} },
      { channel: ANDROID_BRIDGE_CHANNELS.lockscreen.dismiss, payload: {} },
    ]);
  });
});
