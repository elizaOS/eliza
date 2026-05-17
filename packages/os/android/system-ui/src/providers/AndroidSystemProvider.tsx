import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  type AndroidBridgeClient,
  createAndroidBridgeClient,
  getBridgeTransport,
} from "../bridge";
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
import { MockSystemProvider } from "./MockSystemProvider";

export interface AndroidSystemProviderProps {
  children: ReactNode;
}

interface BridgeStateOptions {
  client: AndroidBridgeClient;
  initialWifi: WifiState;
  initialAudio: AudioState;
  initialBattery: BatteryState;
  initialCell: CellState;
  initialTime: SystemTime;
}

const FALLBACK_WIFI: WifiState = { connected: false };
const FALLBACK_AUDIO: AudioState = { level: 0, muted: true };
const FALLBACK_BATTERY: BatteryState = { percent: 0, charging: false };
const FALLBACK_CELL: CellState = { strengthBars: 0, airplaneMode: false };
const FALLBACK_TIME: SystemTime = {
  now: Date.now(),
  locale: "en-US",
  timeZone: "UTC",
};

function BridgeBackedProvider({
  client,
  initialWifi,
  initialAudio,
  initialBattery,
  initialCell,
  initialTime,
  children,
}: BridgeStateOptions & { children: ReactNode }) {
  const [wifi, setWifi] = useState<WifiState>(initialWifi);
  const [audio, setAudio] = useState<AudioState>(initialAudio);
  const [battery, setBattery] = useState<BatteryState>(initialBattery);
  const [cell, setCell] = useState<CellState>(initialCell);
  const [time, setTime] = useState<SystemTime>(initialTime);

  useEffect(() => {
    const offs = [
      client.subscribeWifi(setWifi),
      client.subscribeAudio(setAudio),
      client.subscribeBattery(setBattery),
      client.subscribeCell(setCell),
      client.subscribeTime(setTime),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [client]);

  const controls = useMemo<SystemControls>(
    () => ({
      shutdown: () => {
        void client.shutdown();
      },
      restart: () => {
        void client.restart();
      },
      suspend: () => {
        void client.sleep();
      },
      openSettings: () => {
        void client.openSettings();
      },
      setAudioLevel: (level: number) => {
        void client.setAudioLevel(Math.max(0, Math.min(1, level)));
      },
      setAudioMuted: (muted: boolean) => {
        void client.setAudioMuted(muted);
      },
      toggleAirplaneMode: () => {
        void client.toggleAirplaneMode();
      },
    }),
    [client],
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

export function AndroidSystemProvider({
  children,
}: AndroidSystemProviderProps) {
  const transport = getBridgeTransport();
  if (!transport) {
    return <MockSystemProvider>{children}</MockSystemProvider>;
  }
  const client = createAndroidBridgeClient(transport);
  return (
    <BridgeBackedProvider
      client={client}
      initialWifi={FALLBACK_WIFI}
      initialAudio={FALLBACK_AUDIO}
      initialBattery={FALLBACK_BATTERY}
      initialCell={FALLBACK_CELL}
      initialTime={FALLBACK_TIME}
    >
      {children}
    </BridgeBackedProvider>
  );
}
