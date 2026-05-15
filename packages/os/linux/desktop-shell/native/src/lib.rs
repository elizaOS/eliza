//! Native host for the elizaOS Linux desktop-shell bridge.
//!
//! Every function here is intentionally `unimplemented!()`. The JS-side
//! contracts (`packages/os/linux/desktop-shell/src/bridge/`) drive the
//! channel names; each module below maps one channel group to its
//! D-Bus / PipeWire counterpart.

pub mod wifi {
    // IMPL: D-Bus bind to org.freedesktop.NetworkManager via `zbus`. Watch
    // `NetworkManager.PropertiesChanged` + `ActiveConnection`, emit
    // `eliza.linux.wifi.state` on every change.
    pub struct WifiState {
        pub connected: bool,
        pub ssid: Option<String>,
        pub signal_dbm: Option<i32>,
    }

    pub fn current() -> WifiState {
        unimplemented!("wifi::current — bind NetworkManager via zbus")
    }

    pub fn request_refresh() {
        unimplemented!("wifi::request_refresh — re-emit cached NetworkManager state")
    }
}

pub mod audio {
    // IMPL: PipeWire via `pipewire-rs` preferred; fall back to PulseAudio via
    // `libpulse-binding`. Track default sink volume + mute; emit
    // `eliza.linux.audio.state` on PropertiesChanged.
    pub struct AudioState {
        pub level: f32,
        pub muted: bool,
        pub output_device: Option<String>,
    }

    pub fn current() -> AudioState {
        unimplemented!("audio::current — read PipeWire default sink, fallback PulseAudio")
    }

    pub fn set_level(_level: f32) {
        unimplemented!("audio::set_level — set default sink volume via pipewire-rs")
    }

    pub fn set_muted(_muted: bool) {
        unimplemented!("audio::set_muted — set default sink mute via pipewire-rs")
    }
}

pub mod battery {
    // IMPL: D-Bus bind to org.freedesktop.UPower; resolve the display
    // device (`DisplayDevice` property), read `Percentage` + `State`.
    pub struct BatteryState {
        pub percent: u8,
        pub charging: bool,
    }

    pub fn current() -> BatteryState {
        unimplemented!("battery::current — bind UPower DisplayDevice via zbus")
    }
}

pub mod time {
    // IMPL: read system locale + timezone once via systemd-timedated
    // (org.freedesktop.timedate1); push a tick from a 1Hz timer on the
    // monotonic clock. Wall time comes from `SystemTime::now()`.
    pub struct SystemTime {
        pub now_ms: i64,
        pub locale: String,
        pub time_zone: String,
    }

    pub fn current() -> SystemTime {
        unimplemented!("time::current — read timedated, combine with SystemTime::now")
    }
}

pub mod power {
    // IMPL: D-Bus bind to org.freedesktop.login1.Manager. Calls require
    // either an active local session or a Polkit policy entry for the
    // desktop session user.
    pub fn shutdown() {
        unimplemented!("power::shutdown — call login1.Manager.PowerOff(true)")
    }

    pub fn restart() {
        unimplemented!("power::restart — call login1.Manager.Reboot(true)")
    }

    pub fn suspend() {
        unimplemented!("power::suspend — call login1.Manager.Suspend(true)")
    }
}

pub mod settings {
    // IMPL: spawn `gtk-launch gnome-control-center.desktop` if the
    // GNOME control center is installed; otherwise fall back to
    // `xdg-open` against the user's preferred settings .desktop file.
    pub fn open() {
        unimplemented!("settings::open — spawn gtk-launch or xdg-open")
    }
}

pub mod ipc {
    // IMPL: open a unix socket at $XDG_RUNTIME_DIR/eliza-linux-desktop-bridge.sock
    // (preferred) or speak newline-delimited JSON over stdio when invoked as
    // a child of the shell process. Inbound messages are
    // `{ "channel": "...", "payload": { ... } }`; outbound state pushes
    // are the same shape; command responses include `"ok": true`.
    pub fn run_event_loop() -> ! {
        unimplemented!("ipc::run_event_loop — accept BridgeTransport clients, fan in/out")
    }
}
