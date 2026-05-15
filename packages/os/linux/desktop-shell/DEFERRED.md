# Deferred native integration — Linux desktop shell

This package scaffolds the React surface. Wiring it to real Linux desktop
state requires native integrations that are intentionally out of scope for
this session.

## Required when shell embed lands

- **Surface host.** Embed this React tree as the GNOME shell / Phosh /
  sway lock screen + status bar replacement. Options:
  - GTK4 + WebKitGTK wayland surface as a layer-shell surface
    (`zwlr_layer_shell_v1`) pinned to top + bottom anchors.
  - Compositor-native rewrite using `wlroots` / `gtk4-layer-shell`.
- **Wi-Fi state.** NetworkManager via D-Bus
  (`org.freedesktop.NetworkManager`). Subscribe to `PropertiesChanged`
  for active connection, SSID, signal strength.
- **Battery state.** UPower via D-Bus
  (`org.freedesktop.UPower.Device`). Read `Percentage`, `State` (1 =
  charging). Subscribe to `PropertiesChanged`.
- **Audio state.** PulseAudio or PipeWire. Either shell out to `pactl`,
  use `libpulse` bindings, or talk to PipeWire via `pw-cli` / native
  bindings. Need: default sink volume, mute, sink description.
- **Power / session controls.** logind via D-Bus
  (`org.freedesktop.login1.Manager`): `PowerOff`, `Reboot`, `Suspend`.
- **Settings entry.** `gtk-launch gnome-control-center.desktop` or
  equivalent depending on which control center ships in the fork.
- **Wallpaper / clouds.** Re-export `SlowClouds` from
  `@elizaos/ui/backgrounds` once that module exists, then pass it into
  `<DesktopShell cloudsModule={<SlowClouds />} />`. Until then,
  `<Wallpaper>` renders only the gradient sky.
- **CompanionBar.** Once `packages/ui/src/desktop-runtime/` exports a
  `CompanionBar` component + types, pass it to
  `<DesktopShell companionBar={<CompanionBar … />} />`.

## Markers in source

Search for `// IMPL:` comments in `src/providers/LinuxSystemProvider.tsx`
for the exact integration points.
