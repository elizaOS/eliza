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

## Repo Shape

This is the active Linux distro path. The old root-level usbeliza
prototype under `packages/os/linux/{agent,crates,live-build,vm,...}` was
removed from this branch so the Linux tree has one source of truth:
`packages/os/linux/variants/milady-tails/`.

The directory name is historical. The user-facing product is **elizaOS
Live**. Internal paths that still say `milady` are app/runtime paths and
should only be renamed when the app package itself moves.

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

**Current branch status, 2026-05-16:** the elizaOS Live source tree is
ready for a full build/test pass. `scripts/static-smoke.sh` passes in the
build worktree, the old usbeliza prototype has been removed from the PR
branch, and a low-CPU full ISO build is running separately from this docs
worktree. Do not call the image demo-complete until that build finishes
and the resulting ISO passes QEMU greeter + desktop + app checks.

**Phase 1 — done.** The containerized build pipeline produced a bootable
base ISO, and Tails' normal live-OS boot path was verified through QEMU
using `-cdrom`.

**Phases 2–7 — implemented in source, final proof pending.** Branding,
Privacy Mode plumbing, bundled elizaOS app install/autostart, the
conservative elizaOS capability broker, and elizaOS Persistent Storage
rows/hooks are in the tree. The current gate is the rebuilt ISO plus QEMU
and USB validation.

**Phases 8–9 — spec/backlog.** Mode-parity harness and customization
actions are planned but not production-complete. See [`PLAN.md`](./PLAN.md) for the phase map and
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
  every phase (2–9)
- [`docs/user-experience.md`](./docs/user-experience.md) — what users
  actually see at boot, plain language
- [`docs/mode-parity.md`](./docs/mode-parity.md) — feature behavior
  across storage/privacy combinations
- [`docs/privacy-mode-v1-gap.md`](./docs/privacy-mode-v1-gap.md) —
  known Chromium WebView privacy-mode caveat
- [`docs/production-readiness.md`](./docs/production-readiness.md) —
  what is clean, what is demo glue, and what must harden before release
- [`docs/distribution-and-updates.md`](./docs/distribution-and-updates.md) —
  release, update, model, USB writer, and enterprise distribution plan
- [`tails/README.md`](./tails/README.md) — upstream Tails README,
  unchanged
