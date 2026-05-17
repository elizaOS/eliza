import type {
  AudioState,
  BatteryState,
  CellState,
  SystemTime,
  WifiState,
} from "../types";
import {
  ANDROID_BRIDGE_CHANNELS,
  type AudioSetLevelPayload,
  type AudioSetMutedPayload,
  type CommandAck,
  type ConnectivityState,
  type EmptyPayload,
  type LockscreenState,
} from "./bridge-contract";
import type { BridgeTransport } from "./transport";

export interface AndroidBridgeClient {
  subscribeWifi(cb: (state: WifiState) => void): () => void;
  subscribeCell(cb: (state: CellState) => void): () => void;
  subscribeAudio(cb: (state: AudioState) => void): () => void;
  subscribeBattery(cb: (state: BatteryState) => void): () => void;
  subscribeTime(cb: (state: SystemTime) => void): () => void;
  subscribeConnectivity(cb: (state: ConnectivityState) => void): () => void;
  subscribeLockscreen(cb: (state: LockscreenState) => void): () => void;
  setAudioLevel(level: number): Promise<void>;
  setAudioMuted(muted: boolean): Promise<void>;
  toggleAirplaneMode(): Promise<void>;
  shutdown(): Promise<void>;
  restart(): Promise<void>;
  sleep(): Promise<void>;
  openSettings(): Promise<void>;
  dismissLockscreen(): Promise<void>;
}

const EMPTY: EmptyPayload = {};

export function createAndroidBridgeClient(
  transport: BridgeTransport,
): AndroidBridgeClient {
  return {
    subscribeWifi: (cb) =>
      transport.on<WifiState>(ANDROID_BRIDGE_CHANNELS.wifi.state, cb),
    subscribeCell: (cb) =>
      transport.on<CellState>(ANDROID_BRIDGE_CHANNELS.cell.state, cb),
    subscribeAudio: (cb) =>
      transport.on<AudioState>(ANDROID_BRIDGE_CHANNELS.audio.state, cb),
    subscribeBattery: (cb) =>
      transport.on<BatteryState>(ANDROID_BRIDGE_CHANNELS.battery.state, cb),
    subscribeTime: (cb) =>
      transport.on<SystemTime>(ANDROID_BRIDGE_CHANNELS.time.state, cb),
    subscribeConnectivity: (cb) =>
      transport.on<ConnectivityState>(
        ANDROID_BRIDGE_CHANNELS.connectivity.state,
        cb,
      ),
    subscribeLockscreen: (cb) =>
      transport.on<LockscreenState>(
        ANDROID_BRIDGE_CHANNELS.lockscreen.state,
        cb,
      ),
    setAudioLevel: async (level) => {
      const payload: AudioSetLevelPayload = { level };
      await transport.send<AudioSetLevelPayload, CommandAck>(
        ANDROID_BRIDGE_CHANNELS.audio.setLevel,
        payload,
      );
    },
    setAudioMuted: async (muted) => {
      const payload: AudioSetMutedPayload = { muted };
      await transport.send<AudioSetMutedPayload, CommandAck>(
        ANDROID_BRIDGE_CHANNELS.audio.setMuted,
        payload,
      );
    },
    toggleAirplaneMode: async () => {
      await transport.send<EmptyPayload, CommandAck>(
        ANDROID_BRIDGE_CHANNELS.cell.toggleAirplaneMode,
        EMPTY,
      );
    },
    shutdown: async () => {
      await transport.send<EmptyPayload, CommandAck>(
        ANDROID_BRIDGE_CHANNELS.power.shutdown,
        EMPTY,
      );
    },
    restart: async () => {
      await transport.send<EmptyPayload, CommandAck>(
        ANDROID_BRIDGE_CHANNELS.power.restart,
        EMPTY,
      );
    },
    sleep: async () => {
      await transport.send<EmptyPayload, CommandAck>(
        ANDROID_BRIDGE_CHANNELS.power.sleep,
        EMPTY,
      );
    },
    openSettings: async () => {
      await transport.send<EmptyPayload, CommandAck>(
        ANDROID_BRIDGE_CHANNELS.settings.open,
        EMPTY,
      );
    },
    dismissLockscreen: async () => {
      await transport.send<EmptyPayload, CommandAck>(
        ANDROID_BRIDGE_CHANNELS.lockscreen.dismiss,
        EMPTY,
      );
    },
  };
}
