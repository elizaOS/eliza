import { type ReactNode, useEffect, useMemo, useState } from "react";
import type {
  AudioState,
  BatteryState,
  CellState,
  SystemControls,
  SystemProvider,
  SystemTime,
  WifiState,
} from "../types";
import { SystemProviderContext } from "./context";

export interface MockSystemProviderProps {
  children: ReactNode;
  initialWifi?: WifiState;
  initialAudio?: AudioState;
  initialBattery?: BatteryState;
  initialCell?: CellState;
  locale?: string;
  timeZone?: string;
  tickMs?: number;
}

const DEFAULT_WIFI: WifiState = {
  connected: true,
  ssid: "eliza-home",
  signalDbm: -52,
};

const DEFAULT_AUDIO: AudioState = {
  level: 0.6,
  muted: false,
  outputDevice: "Internal Speakers",
};

const DEFAULT_BATTERY: BatteryState = {
  percent: 94,
  charging: false,
};

export function MockSystemProvider({
  children,
  initialWifi = DEFAULT_WIFI,
  initialAudio = DEFAULT_AUDIO,
  initialBattery = DEFAULT_BATTERY,
  initialCell,
  locale = "en-US",
  timeZone = "UTC",
  tickMs = 1000,
}: MockSystemProviderProps) {
  const [wifi] = useState<WifiState>(initialWifi);
  const [audio, setAudio] = useState<AudioState>(initialAudio);
  const [battery] = useState<BatteryState>(initialBattery);
  const [cell, setCell] = useState<CellState | undefined>(initialCell);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);

  const time = useMemo<SystemTime>(
    () => ({ now, locale, timeZone }),
    [now, locale, timeZone],
  );

  const controls = useMemo<SystemControls>(
    () => ({
      shutdown: () => {},
      restart: () => {},
      suspend: () => {},
      openSettings: () => {},
      setAudioLevel: (level: number) =>
        setAudio((prev) => ({ ...prev, level: Math.max(0, Math.min(1, level)) })),
      setAudioMuted: (muted: boolean) =>
        setAudio((prev) => ({ ...prev, muted })),
      toggleAirplaneMode: () =>
        setCell((prev) =>
          prev ? { ...prev, airplaneMode: !prev.airplaneMode } : prev,
        ),
    }),
    [],
  );

  const value = useMemo<SystemProvider>(
    () => ({ wifi, audio, battery, cell, time, controls }),
    [wifi, audio, battery, cell, time, controls],
  );

  return (
    <SystemProviderContext.Provider value={value}>
      {children}
    </SystemProviderContext.Provider>
  );
}
