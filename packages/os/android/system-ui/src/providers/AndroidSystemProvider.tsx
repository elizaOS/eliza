import type { ReactNode } from "react";
import { MockSystemProvider } from "./MockSystemProvider";

export interface AndroidSystemProviderProps {
  children: ReactNode;
}

export function AndroidSystemProvider({ children }: AndroidSystemProviderProps) {
  // IMPL: wire to Android Settings.Global, AudioManager, ConnectivityManager via native bridge.
  // IMPL: wifi state via ConnectivityManager + WifiManager (NetworkCallback).
  // IMPL: cell state via TelephonyManager (SignalStrength, NetworkOperatorName).
  // IMPL: audio state via AudioManager (STREAM_MUSIC volume + isStreamMute).
  // IMPL: battery via BatteryManager (ACTION_BATTERY_CHANGED sticky intent + EXTRA_LEVEL/EXTRA_SCALE).
  // IMPL: airplane mode via Settings.Global.AIRPLANE_MODE_ON (read) + system intent (write, requires platform signature).
  // IMPL: shutdown/restart/suspend via PowerManager (requires android.permission.REBOOT — platform-signed only).
  // IMPL: openSettings via Intent(Settings.ACTION_SETTINGS).
  return <MockSystemProvider>{children}</MockSystemProvider>;
}
