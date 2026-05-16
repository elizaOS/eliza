import { describe, expect, it, vi } from "vitest";
import type { AudioState, BatteryState, SystemTime, WifiState } from "../../types";
import { LINUX_BRIDGE_CHANNELS } from "../bridge-contract";
import { createLinuxBridgeClient } from "../client";
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

describe("createLinuxBridgeClient", () => {
  it("subscribes to wifi/audio/battery/time state channels", () => {
    const { transport, rec } = makeTransport();
    const client = createLinuxBridgeClient(transport);

    const wifi: WifiState[] = [];
    const audio: AudioState[] = [];
    const battery: BatteryState[] = [];
    const time: SystemTime[] = [];

    const offW = client.subscribeWifi((s) => wifi.push(s));
    const offA = client.subscribeAudio((s) => audio.push(s));
    const offB = client.subscribeBattery((s) => battery.push(s));
    const offT = client.subscribeTime((s) => time.push(s));

    expect(rec.onCalls.map((c) => c.channel)).toEqual([
      LINUX_BRIDGE_CHANNELS.wifi.state,
      LINUX_BRIDGE_CHANNELS.audio.state,
      LINUX_BRIDGE_CHANNELS.battery.state,
      LINUX_BRIDGE_CHANNELS.time.state,
    ]);

    rec.emit(LINUX_BRIDGE_CHANNELS.wifi.state, { connected: true, ssid: "x" });
    rec.emit(LINUX_BRIDGE_CHANNELS.audio.state, { level: 0.3, muted: false });
    rec.emit(LINUX_BRIDGE_CHANNELS.battery.state, { percent: 80, charging: true });
    rec.emit(LINUX_BRIDGE_CHANNELS.time.state, {
      now: 123,
      locale: "en-US",
      timeZone: "UTC",
    });

    expect(wifi).toHaveLength(1);
    expect(audio).toHaveLength(1);
    expect(battery).toHaveLength(1);
    expect(time).toHaveLength(1);

    offW();
    offA();
    offB();
    offT();

    rec.emit(LINUX_BRIDGE_CHANNELS.wifi.state, { connected: false });
    expect(wifi).toHaveLength(1);
  });

  it("sends typed audio + power + settings commands", async () => {
    const { transport, rec } = makeTransport();
    const client = createLinuxBridgeClient(transport);

    await client.setAudioLevel(0.42);
    await client.setAudioMuted(true);
    await client.shutdown();
    await client.restart();
    await client.suspend();
    await client.openSettings();

    expect(rec.sendCalls).toEqual([
      { channel: LINUX_BRIDGE_CHANNELS.audio.setLevel, payload: { level: 0.42 } },
      { channel: LINUX_BRIDGE_CHANNELS.audio.setMuted, payload: { muted: true } },
      { channel: LINUX_BRIDGE_CHANNELS.power.shutdown, payload: {} },
      { channel: LINUX_BRIDGE_CHANNELS.power.restart, payload: {} },
      { channel: LINUX_BRIDGE_CHANNELS.power.suspend, payload: {} },
      { channel: LINUX_BRIDGE_CHANNELS.settings.open, payload: {} },
    ]);
  });
});
