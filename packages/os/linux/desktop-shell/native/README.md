# eliza-linux-desktop-bridge

Native host that backs the JS `BridgeTransport` contract declared in
`../src/bridge/`. Compiles to a single binary that the embedding shell
(GTK4 + WebKitGTK layer-shell surface, or a wlroots-native compositor)
launches alongside the React surface.

## Responsibilities

The native host is the only component allowed to talk to privileged Linux
desktop services. It exposes the JS-side channels defined in
`src/bridge/bridge-contract.ts` over a single IPC transport (a unix
socket or stdio, newline-delimited JSON). For every channel, the host
wires the relevant D-Bus / PipeWire interface:

| JS channel                           | Native binding                                                |
| ------------------------------------ | ------------------------------------------------------------- |
| `eliza.linux.wifi.state`             | `org.freedesktop.NetworkManager` PropertiesChanged            |
| `eliza.linux.wifi.request`           | `org.freedesktop.NetworkManager` re-emit current state        |
| `eliza.linux.audio.state`            | PipeWire (preferred) or PulseAudio (`libpulse`)               |
| `eliza.linux.audio.setLevel`         | PipeWire / PulseAudio default sink volume                     |
| `eliza.linux.audio.setMuted`         | PipeWire / PulseAudio default sink mute                       |
| `eliza.linux.battery.state`          | `org.freedesktop.UPower` `Percentage` + `State`               |
| `eliza.linux.time.state`             | `systemd-timedated` (read-only) + local monotonic clock       |
| `eliza.linux.power.shutdown`         | `org.freedesktop.login1.Manager.PowerOff`                     |
| `eliza.linux.power.restart`          | `org.freedesktop.login1.Manager.Reboot`                       |
| `eliza.linux.power.suspend`          | `org.freedesktop.login1.Manager.Suspend`                      |
| `eliza.linux.settings.open`          | `gtk-launch gnome-control-center.desktop` or `xdg-open`       |

## Status

Skeleton only. Every function in `src/lib.rs` is `unimplemented!()`. Real
wiring requires:

- `zbus` (async) or `dbus-rs` (sync) for D-Bus.
- `pipewire-rs` for PipeWire; `libpulse-binding` for the PulseAudio
  fallback.
- A small async runtime (`tokio` or `async-std`) for the event loop.
- Polkit policy files for any login1 power action invoked without a
  privileged session.

## IPC framing

The JS side expects every `BridgeTransport.on(channel)` push to arrive as
one newline-delimited JSON message of the form:

```
{"channel":"eliza.linux.wifi.state","payload":{"connected":true,"ssid":"...","signalDbm":-52}}
```

and every `BridgeTransport.send(channel, payload)` to be answered with:

```
{"channel":"eliza.linux.power.shutdown","ok":true}
```

## Build

```
cargo build --release
```

(Do not run as part of this scaffold session — the source is here for
the native engineer.)
