import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  createLinuxBridgeClient,
  getBridgeTransport,
  type LinuxBridgeClient,
} from "../bridge";
import type {
  AudioState,
  BatteryState,
  SystemControls,
  SystemProvider,
  SystemTime,
  WifiState,
} from "../types";
import { SystemProviderContext } from "./context";
import { MockSystemProvider } from "./MockSystemProvider";

export interface LinuxSystemProviderProps {
  children: ReactNode;
}

interface BridgeStateOptions {
  client: LinuxBridgeClient;
  initialWifi: WifiState;
  initialAudio: AudioState;
  initialBattery: BatteryState;
  initialTime: SystemTime;
}

const FALLBACK_WIFI: WifiState = { connected: false };
const FALLBACK_AUDIO: AudioState = { level: 0, muted: true };
const FALLBACK_BATTERY: BatteryState = { percent: 0, charging: false };
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
  initialTime,
  children,
}: BridgeStateOptions & { children: ReactNode }) {
  const [wifi, setWifi] = useState<WifiState>(initialWifi);
  const [audio, setAudio] = useState<AudioState>(initialAudio);
  const [battery, setBattery] = useState<BatteryState>(initialBattery);
  const [time, setTime] = useState<SystemTime>(initialTime);

  useEffect(() => {
    const offs = [
      client.subscribeWifi(setWifi),
      client.subscribeAudio(setAudio),
      client.subscribeBattery(setBattery),
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
        void client.suspend();
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
        // IMPL: Linux desktop has no airplane-mode primitive; would toggle
        // rfkill via NetworkManager + bluetoothd. Out of scope for the
        // desktop bridge contract.
      },
    }),
    [client],
  );

  const value = useMemo<SystemProvider>(
    () => ({ wifi, audio, battery, time, controls }),
    [wifi, audio, battery, time, controls],
  );

  return (
    <SystemProviderContext.Provider value={value}>
      {children}
    </SystemProviderContext.Provider>
  );
}

export function LinuxSystemProvider({ children }: LinuxSystemProviderProps) {
  const transport = getBridgeTransport();
  if (!transport) {
    return <MockSystemProvider>{children}</MockSystemProvider>;
  }
  const client = createLinuxBridgeClient(transport);
  return (
    <BridgeBackedProvider
      client={client}
      initialWifi={FALLBACK_WIFI}
      initialAudio={FALLBACK_AUDIO}
      initialBattery={FALLBACK_BATTERY}
      initialTime={FALLBACK_TIME}
    >
      {children}
    </BridgeBackedProvider>
  );
}
