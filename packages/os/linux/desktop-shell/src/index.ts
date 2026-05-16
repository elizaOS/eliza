export { DesktopShell } from "./DesktopShell";
export type { DesktopShellProps } from "./DesktopShell";
export { TopBar } from "./components/TopBar";
export { Wallpaper } from "./components/Wallpaper";
export type { WallpaperProps } from "./components/Wallpaper";
export { WifiIndicator } from "./components/indicators/WifiIndicator";
export { AudioIndicator } from "./components/indicators/AudioIndicator";
export { BatteryIndicator } from "./components/indicators/BatteryIndicator";
export { ShutdownMenu } from "./components/indicators/ShutdownMenu";
export { SettingsButton } from "./components/indicators/SettingsButton";
export { MockSystemProvider } from "./providers/MockSystemProvider";
export type { MockSystemProviderProps } from "./providers/MockSystemProvider";
export { LinuxSystemProvider } from "./providers/LinuxSystemProvider";
export type { LinuxSystemProviderProps } from "./providers/LinuxSystemProvider";
export { useSystemProvider, SystemProviderContext } from "./providers/context";
export {
  LINUX_BRIDGE_CHANNELS,
  getBridgeTransport,
  createLinuxBridgeClient,
} from "./bridge";
export type {
  BridgeTransport,
  LinuxBridgeClient,
  LinuxBridgeChannelMap,
  LinuxBridgeStateChannel,
  LinuxBridgeCommandChannel,
  LinuxBridgeCommandPayloadMap,
  LinuxBridgeCommandResponseMap,
  LinuxBridgeStatePayloadMap,
  WifiRequestPayload,
  AudioSetLevelPayload,
  AudioSetMutedPayload,
  EmptyPayload,
  CommandAck,
} from "./bridge";
export type {
  AudioState,
  BatteryState,
  CellSignalBars,
  CellState,
  SystemControls,
  SystemProvider,
  SystemTime,
  WifiState,
} from "./types";
