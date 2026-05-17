export type CellSignalBars = 0 | 1 | 2 | 3 | 4 | 5;

export interface WifiState {
  connected: boolean;
  ssid?: string;
  signalDbm?: number;
}

export interface AudioState {
  level: number;
  muted: boolean;
  outputDevice?: string;
}

export interface BatteryState {
  percent: number;
  charging: boolean;
}

export interface CellState {
  strengthBars: CellSignalBars;
  carrier?: string;
  airplaneMode: boolean;
}

export interface SystemTime {
  now: number;
  locale: string;
  timeZone: string;
}

export interface SystemControls {
  shutdown(): void;
  restart(): void;
  suspend(): void;
  openSettings(): void;
  setAudioLevel(level: number): void;
  setAudioMuted(muted: boolean): void;
  toggleAirplaneMode(): void;
}

export interface SystemProvider {
  wifi: WifiState;
  audio: AudioState;
  battery: BatteryState;
  cell?: CellState;
  time: SystemTime;
  controls: SystemControls;
}
