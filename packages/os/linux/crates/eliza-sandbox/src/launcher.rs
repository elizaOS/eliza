// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! Bubblewrap launcher for generated apps.
//!
//! Builds the `bwrap` argv that runs a manifest's entry file inside a
//! locked-down namespace. Per locked decision #14, only this app's per-app
//! cap socket (`/run/eliza/cap-<slug>.sock`) is bind-mounted in — there is
//! no shared `cap.sock`, no `/etc`, no other app's `data/`, no exec of
//! arbitrary binaries.
//!
//! Library-only: this module returns argv arrays. Spawning the child
//! process happens in `elizad::sandbox_launcher` so the supervisor can
//! own the lifecycle (kill on shutdown, restart on crash, etc.).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use eliza_types::{Capability, Manifest, manifest::AppRuntime};

/// All inputs the launcher needs that aren't already in the manifest.
#[derive(Debug, Clone)]
pub struct LaunchContext {
    /// Absolute path to `~/.eliza/apps/<slug>/`.
    pub app_root: PathBuf,
    /// Absolute path to this app's `/run/eliza/cap-<slug>.sock`.
    pub cap_socket: PathBuf,
    /// Path to the browser binary used for `webview` runtime apps.
    /// In the qcow2 / live ISO this is `/usr/bin/chromium`; on dev hosts
    /// it can be `/usr/bin/google-chrome` or any chromium-derived binary.
    pub webview_browser: PathBuf,
    /// Wayland display socket path on the host (e.g. `/run/user/1000/wayland-0`).
    /// Bind-mounted into the sandbox so the app can render to Wayland.
    pub wayland_socket: PathBuf,
    /// Optional `XDG_RUNTIME_DIR` override; defaults to `/run/user/<uid>` of
    /// the current user. Used as the parent dir for the bind-mounted
    /// Wayland socket inside the sandbox.
    pub xdg_runtime_dir: PathBuf,
}

/// What `eliza-sandbox::launcher::build` returns: the `bwrap` binary path
/// plus the argv (excluding the binary name itself, ready to feed into a
/// `tokio::process::Command::args(...)` call).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BwrapInvocation {
    /// Always `"bwrap"` today; here as a field so a future release can
    /// substitute a vendor-shipped path without editing call sites.
    pub program: OsString,
    /// Argv passed to `bwrap`, ending with the runtime command.
    pub argv: Vec<OsString>,
}

/// Build the `bwrap` invocation for a validated manifest.
///
/// Returns an error iff the manifest's runtime isn't supported in Phase 0.
#[allow(clippy::too_many_lines)] // Mostly a long, declarative argv builder.
pub fn build(manifest: &Manifest, ctx: &LaunchContext) -> Result<BwrapInvocation, LauncherError> {
    if manifest.runtime != AppRuntime::Webview {
        return Err(LauncherError::UnsupportedRuntime(manifest.runtime));
    }

    let mut argv: Vec<OsString> = Vec::new();
    let push = |argv: &mut Vec<OsString>, s: &str| argv.push(OsString::from(s));
    let push_path = |argv: &mut Vec<OsString>, p: &Path| argv.push(p.into());

    // Namespacing
    push(&mut argv, "--die-with-parent");
    push(&mut argv, "--unshare-user");
    push(&mut argv, "--unshare-pid");
    push(&mut argv, "--unshare-ipc");
    push(&mut argv, "--unshare-uts");
    push(&mut argv, "--unshare-cgroup-try");
    push(&mut argv, "--new-session");

    // Network is opt-in. Without `network:fetch`, drop into a fresh net ns.
    if !manifest_grants_network(manifest) {
        push(&mut argv, "--unshare-net");
    }

    // /usr, /etc — only the parts a browser needs. Read-only.
    for ro in [
        "/usr",
        "/lib",
        "/lib64",
        "/lib32",
        "/bin",
        "/sbin",
        "/etc/ssl",
        "/etc/ld.so.cache",
        "/etc/ld.so.conf",
        "/etc/ld.so.conf.d",
        "/etc/fonts",
        "/etc/resolv.conf",
        "/etc/nsswitch.conf",
        "/etc/passwd",
        "/etc/group",
        "/etc/alternatives",
        "/etc/machine-id",
    ] {
        push(&mut argv, "--ro-bind-try");
        push(&mut argv, ro);
        push(&mut argv, ro);
    }

    // Pseudo-fs that browsers expect.
    push(&mut argv, "--proc");
    push(&mut argv, "/proc");
    push(&mut argv, "--dev");
    push(&mut argv, "/dev");
    push(&mut argv, "--tmpfs");
    push(&mut argv, "/tmp");

    // App's source code (read-only) and data (read-write).
    let src_in = ctx.app_root.join("src");
    let data_in = ctx.app_root.join("data");
    push(&mut argv, "--ro-bind");
    push_path(&mut argv, &src_in);
    push(&mut argv, "/app/src");
    push(&mut argv, "--bind");
    push_path(&mut argv, &data_in);
    push(&mut argv, "/app/data");

    // Per-app cap-bus socket. Only this slug's socket; other slugs' sockets
    // are not mounted, so an attempt to connect to them inside the sandbox
    // hits ENOENT (the path doesn't exist).
    push(&mut argv, "--bind");
    push_path(&mut argv, &ctx.cap_socket);
    push(&mut argv, "/run/eliza/cap.sock");

    // Wayland — the display socket only. The compositor doesn't need any
    // other host-side files.
    let wayland_in_sandbox = PathBuf::from("/run/user/0").join(
        ctx.wayland_socket
            .file_name()
            .map_or(OsString::from("wayland-0"), OsString::from),
    );
    push(&mut argv, "--ro-bind");
    push_path(&mut argv, &ctx.wayland_socket);
    push_path(&mut argv, &wayland_in_sandbox);

    // Environment.
    push(&mut argv, "--clearenv");
    push(&mut argv, "--setenv");
    push(&mut argv, "HOME");
    push(&mut argv, "/app/data");
    push(&mut argv, "--setenv");
    push(&mut argv, "PATH");
    push(&mut argv, "/usr/bin:/bin");
    push(&mut argv, "--setenv");
    push(&mut argv, "XDG_RUNTIME_DIR");
    push(&mut argv, "/run/user/0");
    push(&mut argv, "--setenv");
    push(&mut argv, "WAYLAND_DISPLAY");
    push(
        &mut argv,
        &wayland_in_sandbox.file_name().map_or_else(
            || "wayland-0".to_owned(),
            |n| n.to_string_lossy().into_owned(),
        ),
    );
    push(&mut argv, "--setenv");
    push(&mut argv, "USBELIZA_APP_SLUG");
    push(&mut argv, &manifest.slug);

    // Working directory.
    push(&mut argv, "--chdir");
    push(&mut argv, "/app");

    // Drop privileges: the eliza user is uid/gid 1000 in the live image.
    // The new user namespace makes the sandboxed process map to its own
    // uid 1000, distinct from whatever launched it.
    push(&mut argv, "--uid");
    push(&mut argv, "1000");
    push(&mut argv, "--gid");
    push(&mut argv, "1000");

    // Final command: chromium pointed at the app's entry file. Chromium's
    // own internal sandbox is incompatible with bubblewrap's user-namespace,
    // so we disable it and rely on bwrap's namespacing instead.
    push_path(&mut argv, &ctx.webview_browser);
    push(&mut argv, "--no-sandbox");
    push(&mut argv, "--disable-features=Vulkan");
    push(&mut argv, "--ozone-platform=wayland");
    push(&mut argv, "--user-data-dir=/app/data/.chromium");

    // Tag the Wayland app_id with the manifest's runtime so sway's
    // `for_window` rules in /etc/sway/config can position the window
    // correctly (panels docked top/bottom/left/right, widgets floating,
    // dock draggable, webview fullscreen). The class flag sets the
    // `app_id` for Ozone/Wayland.
    let app_id = format!("usbeliza.{}.{}", runtime_app_id_suffix(&manifest.runtime), manifest.slug);
    let class_arg = format!("--class={app_id}");
    push(&mut argv, &class_arg);

    let entry_url = format!(
        "file:///app/{}",
        manifest
            .entry
            .to_string_lossy()
            .trim_start_matches('/')
            .replace("../", ""),
    );
    push(&mut argv, "--app");
    push(&mut argv, &entry_url);

    Ok(BwrapInvocation {
        program: OsString::from("bwrap"),
        argv,
    })
}

/// Map an `AppRuntime` to the short suffix we embed in the chromium
/// `--class` flag (which sway reads as the window's `app_id`). The sway
/// config in `live-build/.../etc/sway/config` has `for_window` rules
/// matching these prefixes to dock / float / pin the window correctly.
fn runtime_app_id_suffix(runtime: &eliza_types::AppRuntime) -> &'static str {
    use eliza_types::AppRuntime::*;
    match runtime {
        Webview => "app",
        Gtk4 => "gtk",
        Terminal => "term",
        PanelTop => "panel-top",
        PanelBottom => "panel-bottom",
        PanelLeft => "panel-left",
        PanelRight => "panel-right",
        Dock => "dock",
        Widget => "widget",
    }
}

fn manifest_grants_network(manifest: &Manifest) -> bool {
    manifest
        .capabilities
        .iter()
        .any(|c| matches!(c, Capability::NetworkFetch { .. }))
}

/// Errors the launcher can return.
#[derive(Debug, thiserror::Error)]
pub enum LauncherError {
    /// The manifest's `runtime` is not supported in Phase 0.
    #[error("unsupported runtime: {0:?} (Phase 0 supports only `webview`)")]
    UnsupportedRuntime(AppRuntime),
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use eliza_types::{
        Capability, Manifest, manifest::AppRuntime, manifest::MANIFEST_SCHEMA_VERSION,
    };

    use super::*;

    fn fixture(slug: &str, runtime: AppRuntime, caps: Vec<Capability>) -> Manifest {
        Manifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            slug: slug.into(),
            title: "T".into(),
            intent: "t".into(),
            runtime,
            entry: PathBuf::from("src/index.html"),
            capabilities: caps,
            version: 1,
            last_built_by: "test".into(),
            last_built_at: "2026-05-10T00:00:00Z".into(),
        }
    }

    fn ctx() -> LaunchContext {
        LaunchContext {
            app_root: PathBuf::from("/home/eliza/.eliza/apps/calendar"),
            cap_socket: PathBuf::from("/run/eliza/cap-calendar.sock"),
            webview_browser: PathBuf::from("/usr/bin/chromium"),
            wayland_socket: PathBuf::from("/run/user/1000/wayland-0"),
            xdg_runtime_dir: PathBuf::from("/run/user/1000"),
        }
    }

    fn argv_strings(inv: &BwrapInvocation) -> Vec<String> {
        inv.argv
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect()
    }

    fn contains_pair(argv: &[String], a: &str, b: &str) -> bool {
        argv.windows(2).any(|w| w[0] == a && w[1] == b)
    }

    #[test]
    fn webview_app_emits_namespacing_flags() {
        let m = fixture("calendar", AppRuntime::Webview, vec![Capability::TimeRead]);
        let inv = build(&m, &ctx()).expect("ok");
        let argv = argv_strings(&inv);
        for flag in [
            "--die-with-parent",
            "--unshare-user",
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-net",
            "--unshare-uts",
            "--unshare-cgroup-try",
            "--new-session",
        ] {
            assert!(argv.iter().any(|s| s == flag), "missing {flag}");
        }
    }

    #[test]
    fn webview_app_with_network_fetch_keeps_net_namespace() {
        let m = fixture(
            "calendar",
            AppRuntime::Webview,
            vec![
                Capability::TimeRead,
                Capability::NetworkFetch {
                    allowlist: vec!["api.example.com".into()],
                },
            ],
        );
        let inv = build(&m, &ctx()).expect("ok");
        let argv = argv_strings(&inv);
        assert!(
            !argv.iter().any(|s| s == "--unshare-net"),
            "network-granted apps must NOT get --unshare-net",
        );
    }

    #[test]
    fn webview_app_binds_only_per_app_cap_socket() {
        let m = fixture("calendar", AppRuntime::Webview, vec![Capability::TimeRead]);
        let inv = build(&m, &ctx()).expect("ok");
        let argv = argv_strings(&inv);
        // The host path is /run/eliza/cap-calendar.sock (per-app, locked decision #14).
        assert!(contains_pair(
            &argv,
            "--bind",
            "/run/eliza/cap-calendar.sock"
        ));
        // Inside the sandbox it appears as the canonical path /run/eliza/cap.sock.
        let bind_idx = argv
            .iter()
            .position(|s| s == "/run/eliza/cap-calendar.sock")
            .expect("bind src present");
        assert_eq!(argv[bind_idx + 1], "/run/eliza/cap.sock");
    }

    #[test]
    fn webview_app_binds_src_ro_and_data_rw() {
        let m = fixture("calendar", AppRuntime::Webview, vec![Capability::TimeRead]);
        let inv = build(&m, &ctx()).expect("ok");
        let argv = argv_strings(&inv);
        assert!(contains_pair(
            &argv,
            "--ro-bind",
            "/home/eliza/.eliza/apps/calendar/src",
        ));
        assert!(contains_pair(
            &argv,
            "--bind",
            "/home/eliza/.eliza/apps/calendar/data",
        ));
    }

    #[test]
    fn webview_app_passes_chromium_in_app_url() {
        let m = fixture("calendar", AppRuntime::Webview, vec![Capability::TimeRead]);
        let inv = build(&m, &ctx()).expect("ok");
        let argv = argv_strings(&inv);
        assert!(argv.iter().any(|s| s == "/usr/bin/chromium"));
        assert!(argv.iter().any(|s| s == "--no-sandbox"));
        assert!(argv.iter().any(|s| s == "--ozone-platform=wayland"));
        assert!(
            argv.iter().any(|s| s == "file:///app/src/index.html"),
            "argv missing the entry URL"
        );
    }

    #[test]
    fn webview_app_clears_env_and_sets_safe_defaults() {
        let m = fixture("calendar", AppRuntime::Webview, vec![Capability::TimeRead]);
        let inv = build(&m, &ctx()).expect("ok");
        let argv = argv_strings(&inv);
        assert!(argv.iter().any(|s| s == "--clearenv"));
        // HOME, PATH, XDG_RUNTIME_DIR, WAYLAND_DISPLAY, USBELIZA_APP_SLUG.
        for k in [
            "HOME",
            "PATH",
            "XDG_RUNTIME_DIR",
            "WAYLAND_DISPLAY",
            "USBELIZA_APP_SLUG",
        ] {
            assert!(contains_pair(&argv, "--setenv", k), "missing --setenv {k}");
        }
    }

    #[test]
    fn entry_path_traversal_is_neutralized() {
        let mut m = fixture("calendar", AppRuntime::Webview, vec![Capability::TimeRead]);
        m.entry = PathBuf::from("../../etc/passwd");
        let inv = build(&m, &ctx()).expect("ok");
        let argv = argv_strings(&inv);
        let url = argv.iter().find(|s| s.starts_with("file:///app/"));
        assert!(
            url.is_some_and(|u| !u.contains("..")),
            "url must not contain `..`",
        );
    }

    #[test]
    fn unsupported_runtime_errors_cleanly() {
        let m = fixture("term", AppRuntime::Terminal, vec![Capability::TimeRead]);
        let err = build(&m, &ctx()).expect_err("phase 0 doesn't support terminal");
        assert!(matches!(err, LauncherError::UnsupportedRuntime(_)));
    }
}
