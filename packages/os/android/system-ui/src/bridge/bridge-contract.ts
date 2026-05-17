import type {
  AudioState,
  BatteryState,
  CellState,
  SystemTime,
  WifiState,
} from "../types";

export const ANDROID_BRIDGE_CHANNELS = {
  wifi: {
    state: "eliza.android.wifi.state",
  },
  cell: {
    state: "eliza.android.cell.state",
    toggleAirplaneMode: "eliza.android.cell.toggleAirplaneMode",
  },
  audio: {
    state: "eliza.android.audio.state",
    setLevel: "eliza.android.audio.setLevel",
    setMuted: "eliza.android.audio.setMuted",
  },
  battery: {
    state: "eliza.android.battery.state",
  },
  time: {
    state: "eliza.android.time.state",
  },
  connectivity: {
    state: "eliza.android.connectivity.state",
  },
  power: {
    shutdown: "eliza.android.power.shutdown",
    restart: "eliza.android.power.restart",
    sleep: "eliza.android.power.sleep",
  },
  settings: {
    open: "eliza.android.settings.open",
  },
  lockscreen: {
    state: "eliza.android.lockscreen.state",
    dismiss: "eliza.android.lockscreen.dismiss",
  },
} as const;

export type AndroidBridgeChannelMap = typeof ANDROID_BRIDGE_CHANNELS;

export interface ConnectivityState {
  network: "wifi" | "cellular" | "ethernet" | "none";
  metered: boolean;
}

export interface LockscreenState {
  locked: boolean;
  secure: boolean;
}

export type AndroidBridgeStateChannel =
  | typeof ANDROID_BRIDGE_CHANNELS.wifi.state
  | typeof ANDROID_BRIDGE_CHANNELS.cell.state
  | typeof ANDROID_BRIDGE_CHANNELS.audio.state
  | typeof ANDROID_BRIDGE_CHANNELS.battery.state
  | typeof ANDROID_BRIDGE_CHANNELS.time.state
  | typeof ANDROID_BRIDGE_CHANNELS.connectivity.state
  | typeof ANDROID_BRIDGE_CHANNELS.lockscreen.state;

export type AndroidBridgeCommandChannel =
  | typeof ANDROID_BRIDGE_CHANNELS.audio.setLevel
  | typeof ANDROID_BRIDGE_CHANNELS.audio.setMuted
  | typeof ANDROID_BRIDGE_CHANNELS.cell.toggleAirplaneMode
  | typeof ANDROID_BRIDGE_CHANNELS.power.shutdown
  | typeof ANDROID_BRIDGE_CHANNELS.power.restart
  | typeof ANDROID_BRIDGE_CHANNELS.power.sleep
  | typeof ANDROID_BRIDGE_CHANNELS.settings.open
  | typeof ANDROID_BRIDGE_CHANNELS.lockscreen.dismiss;

export interface AudioSetLevelPayload {
  level: number;
}

export interface AudioSetMutedPayload {
  muted: boolean;
}

export interface EmptyPayload {
  readonly _empty?: never;
}

export interface CommandAck {
  ok: true;
}

export interface AndroidBridgeCommandPayloadMap {
  [ANDROID_BRIDGE_CHANNELS.audio.setLevel]: AudioSetLevelPayload;
  [ANDROID_BRIDGE_CHANNELS.audio.setMuted]: AudioSetMutedPayload;
  [ANDROID_BRIDGE_CHANNELS.cell.toggleAirplaneMode]: EmptyPayload;
  [ANDROID_BRIDGE_CHANNELS.power.shutdown]: EmptyPayload;
  [ANDROID_BRIDGE_CHANNELS.power.restart]: EmptyPayload;
  [ANDROID_BRIDGE_CHANNELS.power.sleep]: EmptyPayload;
  [ANDROID_BRIDGE_CHANNELS.settings.open]: EmptyPayload;
  [ANDROID_BRIDGE_CHANNELS.lockscreen.dismiss]: EmptyPayload;
}

export interface AndroidBridgeCommandResponseMap {
  [ANDROID_BRIDGE_CHANNELS.audio.setLevel]: CommandAck;
  [ANDROID_BRIDGE_CHANNELS.audio.setMuted]: CommandAck;
  [ANDROID_BRIDGE_CHANNELS.cell.toggleAirplaneMode]: CommandAck;
  [ANDROID_BRIDGE_CHANNELS.power.shutdown]: CommandAck;
  [ANDROID_BRIDGE_CHANNELS.power.restart]: CommandAck;
  [ANDROID_BRIDGE_CHANNELS.power.sleep]: CommandAck;
  [ANDROID_BRIDGE_CHANNELS.settings.open]: CommandAck;
  [ANDROID_BRIDGE_CHANNELS.lockscreen.dismiss]: CommandAck;
}

export interface AndroidBridgeStatePayloadMap {
  [ANDROID_BRIDGE_CHANNELS.wifi.state]: WifiState;
  [ANDROID_BRIDGE_CHANNELS.cell.state]: CellState;
  [ANDROID_BRIDGE_CHANNELS.audio.state]: AudioState;
  [ANDROID_BRIDGE_CHANNELS.battery.state]: BatteryState;
  [ANDROID_BRIDGE_CHANNELS.time.state]: SystemTime;
  [ANDROID_BRIDGE_CHANNELS.connectivity.state]: ConnectivityState;
  [ANDROID_BRIDGE_CHANNELS.lockscreen.state]: LockscreenState;
}
