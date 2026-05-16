import type {
  AudioState,
  BatteryState,
  SystemTime,
  WifiState,
} from "../types";

export const LINUX_BRIDGE_CHANNELS = {
  wifi: {
    state: "eliza.linux.wifi.state",
    request: "eliza.linux.wifi.request",
  },
  audio: {
    state: "eliza.linux.audio.state",
    setLevel: "eliza.linux.audio.setLevel",
    setMuted: "eliza.linux.audio.setMuted",
  },
  battery: {
    state: "eliza.linux.battery.state",
  },
  time: {
    state: "eliza.linux.time.state",
  },
  power: {
    shutdown: "eliza.linux.power.shutdown",
    restart: "eliza.linux.power.restart",
    suspend: "eliza.linux.power.suspend",
  },
  settings: {
    open: "eliza.linux.settings.open",
  },
} as const;

export type LinuxBridgeChannelMap = typeof LINUX_BRIDGE_CHANNELS;

export type LinuxBridgeStateChannel =
  | typeof LINUX_BRIDGE_CHANNELS.wifi.state
  | typeof LINUX_BRIDGE_CHANNELS.audio.state
  | typeof LINUX_BRIDGE_CHANNELS.battery.state
  | typeof LINUX_BRIDGE_CHANNELS.time.state;

export type LinuxBridgeCommandChannel =
  | typeof LINUX_BRIDGE_CHANNELS.wifi.request
  | typeof LINUX_BRIDGE_CHANNELS.audio.setLevel
  | typeof LINUX_BRIDGE_CHANNELS.audio.setMuted
  | typeof LINUX_BRIDGE_CHANNELS.power.shutdown
  | typeof LINUX_BRIDGE_CHANNELS.power.restart
  | typeof LINUX_BRIDGE_CHANNELS.power.suspend
  | typeof LINUX_BRIDGE_CHANNELS.settings.open;

export interface WifiRequestPayload {
  refresh: true;
}

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

export interface LinuxBridgeCommandPayloadMap {
  [LINUX_BRIDGE_CHANNELS.wifi.request]: WifiRequestPayload;
  [LINUX_BRIDGE_CHANNELS.audio.setLevel]: AudioSetLevelPayload;
  [LINUX_BRIDGE_CHANNELS.audio.setMuted]: AudioSetMutedPayload;
  [LINUX_BRIDGE_CHANNELS.power.shutdown]: EmptyPayload;
  [LINUX_BRIDGE_CHANNELS.power.restart]: EmptyPayload;
  [LINUX_BRIDGE_CHANNELS.power.suspend]: EmptyPayload;
  [LINUX_BRIDGE_CHANNELS.settings.open]: EmptyPayload;
}

export interface LinuxBridgeCommandResponseMap {
  [LINUX_BRIDGE_CHANNELS.wifi.request]: CommandAck;
  [LINUX_BRIDGE_CHANNELS.audio.setLevel]: CommandAck;
  [LINUX_BRIDGE_CHANNELS.audio.setMuted]: CommandAck;
  [LINUX_BRIDGE_CHANNELS.power.shutdown]: CommandAck;
  [LINUX_BRIDGE_CHANNELS.power.restart]: CommandAck;
  [LINUX_BRIDGE_CHANNELS.power.suspend]: CommandAck;
  [LINUX_BRIDGE_CHANNELS.settings.open]: CommandAck;
}

export interface LinuxBridgeStatePayloadMap {
  [LINUX_BRIDGE_CHANNELS.wifi.state]: WifiState;
  [LINUX_BRIDGE_CHANNELS.audio.state]: AudioState;
  [LINUX_BRIDGE_CHANNELS.battery.state]: BatteryState;
  [LINUX_BRIDGE_CHANNELS.time.state]: SystemTime;
}
