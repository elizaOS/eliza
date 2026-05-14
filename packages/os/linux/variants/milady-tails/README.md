# milady-tails — full Linux + Milady, USB-only, optional Tor + optional persistence

A live-USB distribution that takes **all of Tails**, rebrands it as
**Milady**, adds the **Milady Electrobun app** as the desktop home,
and gives users **two opt-in features**: encrypted persistence on the
USB stick, and Tor routing for privacy.

```
┌────────────────────────────────────────────────┐
│  Full Linux desktop (GNOME by default)         │
│                                                │
│   ┌──────────────────────────────────────┐    │
│   │      Milady Electrobun app           │    │
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
(milady-tails) is the **full desktop variant**: real Linux with a
normal GUI, Milady as the home app.

Both share the same agent code (`@elizaos/*` framework, BUILD_APP /
OPEN_APP actions, plugin pattern). They differ at the live-build +
session layer. See [`docs/relationship-to-usbeliza.md`](./docs/relationship-to-usbeliza.md).

## Architecture

We **start from a full copy of Tails** (77 MB, 6101 files, in
`tails/`) and **add Milady on top** — additive only, no deletion.
Tor, AppArmor, MAC spoofing, persistence-setup, Plymouth — all
preserved. The Milady additions live as new chroot hooks + package
lists + branding overrides.

This matches the `packages/os/android/vendor/eliza/` pattern in this
monorepo (brand vendor tree inside the upstream system's structure).

## License

GPL-3.0-or-later (inherited from Tails). Our additions are
Apache-2.0 where possible, dual-licensed under both. Tails project
credited prominently in CREDITS, NOTICE, the rebranded greeter, and
the in-app About page.

## Status

**Phase 0** — scaffold complete. Tails source imported. PLAN
documents the work order. No ISO builds yet.

See [`PLAN.md`](./PLAN.md) for the 11 phases.

## Docs

- [`PLAN.md`](./PLAN.md) — phased work order with success criteria
- [`docs/user-experience.md`](./docs/user-experience.md) — what users
  actually see at boot, plain language
- [`docs/relationship-to-usbeliza.md`](./docs/relationship-to-usbeliza.md) —
  architecture split between this variant and usbeliza
- [`tails/README.md`](./tails/README.md) — upstream Tails README,
  unchanged
