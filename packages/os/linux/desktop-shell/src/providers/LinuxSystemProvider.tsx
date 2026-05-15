import type { ReactNode } from "react";
import { MockSystemProvider } from "./MockSystemProvider";

export interface LinuxSystemProviderProps {
  children: ReactNode;
}

export function LinuxSystemProvider({ children }: LinuxSystemProviderProps) {
  // IMPL: wire to D-Bus when shell embed lands.
  // IMPL: read wifi via NetworkManager (org.freedesktop.NetworkManager).
  // IMPL: read battery via UPower (org.freedesktop.UPower).
  // IMPL: read/write audio via PulseAudio / PipeWire (pactl or libpulse).
  // IMPL: shutdown/restart/suspend via logind (org.freedesktop.login1).
  // IMPL: openSettings via gtk-launch gnome-control-center or equivalent.
  return <MockSystemProvider>{children}</MockSystemProvider>;
}
