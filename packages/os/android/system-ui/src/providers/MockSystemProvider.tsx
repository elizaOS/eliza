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

// Defaults are intentionally empty / disconnected. MockSystemProvider is a
// test and storybook harness only; it must never ship plausible production-like
// Wi-Fi / cell / battery state that could be mistaken for live readiness
// evidence. Consumers that want populated state pass it explicitly via props.
const EMPTY_WIFI: WifiState = { connected: false };

const EMPTY_AUDIO: AudioState = { level: 0, muted: true };

const EMPTY_BATTERY: BatteryState = { percent: 0, charging: false };

const EMPTY_CELL: CellState = { strengthBars: 0, airplaneMode: false };

export function MockSystemProvider({
  children,
  initialWifi = EMPTY_WIFI,
  initialAudio = EMPTY_AUDIO,
  initialBattery = EMPTY_BATTERY,
  initialCell = EMPTY_CELL,
  locale = "en-US",
  timeZone = "UTC",
  tickMs = 1000,
}: MockSystemProviderProps) {
  const [wifi] = useState<WifiState>(initialWifi);
  const [audio, setAudio] = useState<AudioState>(initialAudio);
  const [battery] = useState<BatteryState>(initialBattery);
  const [cell, setCell] = useState<CellState>(initialCell);
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
        setAudio((prev) => ({
          ...prev,
          level: Math.max(0, Math.min(1, level)),
        })),
      setAudioMuted: (muted: boolean) =>
        setAudio((prev) => ({ ...prev, muted })),
      toggleAirplaneMode: () =>
        setCell((prev) => ({ ...prev, airplaneMode: !prev.airplaneMode })),
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
