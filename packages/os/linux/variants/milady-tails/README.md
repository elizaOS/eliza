# elizaOS Live

A live-USB distribution that boots as **elizaOS**, includes the bundled
elizaOS desktop app as the home surface, and gives users **two opt-in
features**: encrypted persistence on the USB stick, and Tor routing for
privacy.

```
┌────────────────────────────────────────────────┐
│  Full Linux desktop (GNOME by default)         │
│                                                │
│   ┌──────────────────────────────────────┐    │
│   │      elizaOS desktop app             │    │
│   │   (chat, agent, BUILD_APP, voice…)   │    │
│   └──────────────────────────────────────┘    │
│                                                │
│  + Files, Terminal, Browser, apt ecosystem     │
│  + Notifications, panel, workspace switching   │
│  + GPU acceleration (Vulkan / CUDA / ROCm)     │
└────────────────────────────────────────────────┘
```

## v1.0 scope (locked 2026-05-14)

**USB-only** distribution. Boot from a USB stick. **Pick one of two
storage modes at boot, optionally combine with Tor privacy mode**.

### Storage modes (chosen at the greeter, every boot)

|  | What user gets | What survives reboot |
|---|---|---|
| **Amnesia** (default) | RAM only, no disk writes, system leaves no trace on shutdown | Nothing — fresh every time |
| **Persistent USB** (opt-in) | LUKS-encrypted partition on the same USB stick, bind-mounted to `~/.eliza/` and friends | Chat history, built apps, model downloads, Wi-Fi, API keys |

A returning user can pick a different mode per-boot. The greeter
shows the same window every time; the persistence row either offers
"Create" (first-time) or shows a passphrase field (returning).
Skip the passphrase → amnesia for that boot, persisted data stays
sealed.

### Privacy mode (chosen at the boot menu, independent of storage)

|  | What user gets |
|---|---|
| **Normal** (default) | Direct internet. Fast cloud APIs, fast model downloads. |
| **Privacy Mode** (opt-in) | All traffic routed through Tor. Slow but anonymous. Same features. |

**All four combos work**. See `docs/user-experience.md` for the
boot-time walkthrough and the feature-parity matrix.

## What we're NOT shipping in v1.0

- **Install to internal disk** — deferred to v2.0. Tails refuses this
  by design (forensic concerns); we're considering it carefully with
  respect for their reasoning. See `PLAN.md § Deferred`.
- **Runtime privacy toggle** — switching modes requires reboot in v1.0.
- **Closing the Chromium WebView Tor-leak gap** — known v1.0 gap,
  fixed in v1.1.

## How it relates to usbeliza

`packages/os/linux/` (usbeliza) is the **minimal kiosk variant**: chat
IS the entire UI, no normal Linux desktop visible. This variant
(currently stored at `variants/milady-tails/`) is the **full desktop
elizaOS variant**: real Linux with a normal GUI, elizaOS as the home app.

Both share the same agent code (`@elizaos/*` framework, BUILD_APP /
OPEN_APP actions, plugin pattern). They differ at the live-build +
session layer. See [`docs/relationship-to-usbeliza.md`](./docs/relationship-to-usbeliza.md).

## Architecture

We keep the upstream live-OS internals intact and layer elizaOS branding,
the elizaOS app, persistence wiring, and supervised OS capabilities on top.
Tor, AppArmor, MAC spoofing, persistence setup, Plymouth, and the normal
desktop remain preserved. The additions live as new chroot hooks + package
lists + branding overrides.

This matches the `packages/os/android/vendor/eliza/` pattern in this
monorepo (brand vendor tree inside the upstream system's structure).

## License

GPL-3.0-or-later for the inherited live-OS components. Our additions are
Apache-2.0 where possible, dual-licensed under both where required.

## Status

**Phase 1 — done.** The containerized build pipeline produced a 1.9 GB
elizaOS ISO, and that ISO boots in QEMU to the elizaOS greeter via
`-cdrom`.

**Phase 2 — overlay implemented, rebuild pending.** The OS branding
overlays now target elizaOS: boot menu, Plymouth, greeter, wallpaper,
dark GNOME defaults, `/etc/os-release`, `/etc/issue`, and the visible app
surfaces.
The remaining Phase 2 gate is rebuilding the ISO and doing the visual
QEMU pass.

**Phases 3–7 — overlay implemented, rebuild pending.** Privacy mode,
elizaOS app install/autostart, the conservative elizaOS capability broker,
and elizaOS Persistent Storage rows/hooks are in the tree. They still need
the rebuilt ISO + QEMU/USB validation before they can be marked done.

Phases 8–9 are **fully spec'd** ([`docs/specs/`](./docs/specs/)) but not
implemented. See [`PLAN.md`](./PLAN.md) for the phase map and
[`ROADMAP.md`](./ROADMAP.md) for the honest road to a real,
fully-working demo.

## Build it

Only requirement is Docker. From this directory:

```
just static-smoke # CPU-light syntax/config checks, no Docker/QEMU
just config    # ~1 min live-build go/no-go
just build     # full clean ISO -> out/
just build-cool # low-CPU demo build, skips offline docs, caps Docker+squashfs to 2 CPUs
just build-demo # fastest full demo build; skips bundled offline website/docs
just boot      # boot the latest ISO in QEMU
just usb-write /dev/sdX # write the latest ISO with removable-disk guards
```

Set `ELIZAOS_BUILD_CPUS=2`, `ELIZAOS_MKSQUASHFS_PROCESSORS=2`, or
`ELIZAOS_BUILD_MEMORY=8g` when you need Docker to stay out of the way of
Android/AOSP/app builds on the same machine. `just build-cool` sets the
CPU and squashfs caps to 2 by default and skips rebuilding the bundled
offline website/docs; set `ELIZAOS_SKIP_WEBSITE=0` if you need exact
offline docs in a cool build.

## Docs

- [`PLAN.md`](./PLAN.md) — phase map with success criteria and status
- [`ROADMAP.md`](./ROADMAP.md) — the honest road from here to a real demo
  and to v1.0
- [`docs/build-infrastructure.md`](./docs/build-infrastructure.md) — the
  containerized build, why it exists, how it works
- [`docs/specs/`](./docs/specs/) — file-level implementation specs for
  every phase (2–9) + the agent-tree portability audit
- [`docs/user-experience.md`](./docs/user-experience.md) — what users
  actually see at boot, plain language
- [`docs/mode-parity.md`](./docs/mode-parity.md) — feature behavior
  across storage/privacy combinations
- [`docs/privacy-mode-v1-gap.md`](./docs/privacy-mode-v1-gap.md) —
  known Chromium WebView privacy-mode caveat
- [`docs/relationship-to-usbeliza.md`](./docs/relationship-to-usbeliza.md) —
  architecture split between this variant and usbeliza
- [`tails/README.md`](./tails/README.md) — upstream Tails README,
  unchanged
