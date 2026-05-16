import type {
  AudioState,
  BatteryState,
  SystemTime,
  WifiState,
} from "../types";
import {
  type AudioSetLevelPayload,
  type AudioSetMutedPayload,
  type CommandAck,
  type EmptyPayload,
  LINUX_BRIDGE_CHANNELS,
} from "./bridge-contract";
import type { BridgeTransport } from "./transport";

export interface LinuxBridgeClient {
  subscribeWifi(cb: (state: WifiState) => void): () => void;
  subscribeAudio(cb: (state: AudioState) => void): () => void;
  subscribeBattery(cb: (state: BatteryState) => void): () => void;
  subscribeTime(cb: (state: SystemTime) => void): () => void;
  setAudioLevel(level: number): Promise<void>;
  setAudioMuted(muted: boolean): Promise<void>;
  shutdown(): Promise<void>;
  restart(): Promise<void>;
  suspend(): Promise<void>;
  openSettings(): Promise<void>;
}

const EMPTY: EmptyPayload = {};

export function createLinuxBridgeClient(
  transport: BridgeTransport,
): LinuxBridgeClient {
  return {
    subscribeWifi: (cb) =>
      transport.on<WifiState>(LINUX_BRIDGE_CHANNELS.wifi.state, cb),
    subscribeAudio: (cb) =>
      transport.on<AudioState>(LINUX_BRIDGE_CHANNELS.audio.state, cb),
    subscribeBattery: (cb) =>
      transport.on<BatteryState>(LINUX_BRIDGE_CHANNELS.battery.state, cb),
    subscribeTime: (cb) =>
      transport.on<SystemTime>(LINUX_BRIDGE_CHANNELS.time.state, cb),
    setAudioLevel: async (level) => {
      const payload: AudioSetLevelPayload = { level };
      await transport.send<AudioSetLevelPayload, CommandAck>(
        LINUX_BRIDGE_CHANNELS.audio.setLevel,
        payload,
      );
    },
    setAudioMuted: async (muted) => {
      const payload: AudioSetMutedPayload = { muted };
      await transport.send<AudioSetMutedPayload, CommandAck>(
        LINUX_BRIDGE_CHANNELS.audio.setMuted,
        payload,
      );
    },
    shutdown: async () => {
      await transport.send<EmptyPayload, CommandAck>(
        LINUX_BRIDGE_CHANNELS.power.shutdown,
        EMPTY,
      );
    },
    restart: async () => {
      await transport.send<EmptyPayload, CommandAck>(
        LINUX_BRIDGE_CHANNELS.power.restart,
        EMPTY,
      );
    },
    suspend: async () => {
      await transport.send<EmptyPayload, CommandAck>(
        LINUX_BRIDGE_CHANNELS.power.suspend,
        EMPTY,
      );
    },
    openSettings: async () => {
      await transport.send<EmptyPayload, CommandAck>(
        LINUX_BRIDGE_CHANNELS.settings.open,
        EMPTY,
      );
    },
  };
}
