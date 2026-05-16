# PLAN.md — elizaOS Live build order

The phased work order to take elizaOS Live from "empty scaffold" to
"boots into a working elizaOS live desktop on real USB hardware, with
the AI app ready, optional Tor privacy mode, and optional encrypted
persistent storage."

This is a multi-week project. Each phase has a clear success criterion;
don't jump phases. With the containerized build (see Phase 1) a full ISO
is ~1–1.5 h cold, and incremental rebuilds (`just binary`) are ~10 min —
several phases still need iteration.

**Detailed, file-level implementation specs for each phase live in
[`docs/specs/`](./docs/specs/).** This PLAN is the map; the specs are the
turn-by-turn directions.

---

## Current status (2026-05-16)

| | |
|---|---|
| **Phase 0 — Scaffold** | ✅ Done |
| **Phase 1 — Base ISO builds + boots** | ✅ Done — base image builds and boots through QEMU via `-cdrom` |
| **Phase 2 — elizaOS system branding** | 🔨 Source implemented; final rebuilt-ISO visual pass in progress |
| **Phase 3 — Privacy mode** | 🔨 Source implemented; needs rebuilt-ISO network/Tor validation |
| **Phase 4 — Bake elizaOS app** | 🔨 App payload staged + install hook/package list implemented; needs rebuilt-ISO runtime validation |
| **Phase 5 — Autolaunch** | 🔨 Desktop/autostart/systemd wrapper implemented; needs boot validation |
| **Phase 6 — Agent/broker** | 🔨 OS broker/env path implemented; approval-gated privileged actions still need hardening |
| **Phase 7 — Persistence** | 🔨 Tails Persistent Storage row/hooks implemented; needs persistence validation |
| **Phases 8–9** | 📋 Spec/backlog ([`docs/specs/`](./docs/specs/)), not release-complete |
| **Phases 10–11** | ⏳ Not started |

What exists right now:
- A **containerized build pipeline** (`Dockerfile`, `build.sh`, `build-iso.sh`,
  `acng.conf`, `Justfile`) that builds the ISO on any host with Docker — no
  Vagrant, no libvirt, no host-specific setup. See
  [`docs/build-infrastructure.md`](./docs/build-infrastructure.md).
- **6 genuine Tails Trixie-compat fixes** found while getting the build to
  run (5 builder-box fixes + 1 package-list fix — `gdisk`/`mtools` for the
  partitioning initramfs hook). All upstream-worthy.
- **Complete file-level specs** for every implementation phase (2–9) plus a
  product hardening plan for distribution, updates, and production readiness.
- **elizaOS OS-branding overlays** for boot menus, Plymouth, greeter,
  dark GNOME defaults, wallpaper, identity strings, and Tails credits.
- The **elizaOS desktop app** builds and is staged into the Tails
  overlay. The ISO install hook copies it to `/opt/milady`, fixes
  permissions, and removes the staging copy. `/opt/milady` is an internal
  runtime path until the app package itself is renamed.
- A narrow **elizaOS capability broker** exists at
  `/usr/local/lib/elizaos/capability-runner`. For the first rebuild it is
  intentionally conservative: status/privacy/persistence helpers plus exact
  sudo only for `root-status`; package/network mutation is deferred until an
  approval-gated policy layer exists.
- Privacy-mode, autolaunch, and `~/.eliza` Persistent Storage overlays are
  implemented locally. A low-CPU full rebuild/test pass is the current gate
  for calling the demo complete.
- The old root-level usbeliza Linux prototype was removed from this branch;
  this variant is the active Linux distro path.

See [`ROADMAP.md`](./ROADMAP.md) for the honest road from here to a real,
fully-working demo.

---

## v1.0 scope (locked 2026-05-14)

**USB-only** distribution with two storage modes and a privacy toggle.
**No install-to-internal-disk yet** — see § Deferred for the rationale.

### Storage modes (pick at boot)

1. **Amnesia (default)** — RAM only, no disk writes, full wipe on
   shutdown. Required for "borrowed laptop / hotel / zero footprint".
   Tails' default behavior, kept identical.
2. **Persistent USB (opt-in)** — LUKS-encrypted partition on the USB
   stick. Reuses Tails' native **Persistent Storage** (`tps`) tool
   unchanged. Selected dirs bind-mount from the LUKS partition.

### Privacy mode (independent of storage mode)

- **Normal (default)** — Tor routing OFF, direct internet, fast.
- **Privacy Mode (opt-in)** — Tor routing ON, behaves like stock Tails.

Both axes combine freely: 4 valid configurations.

|  | Amnesia | Persistent |
|---|---|---|
| **Normal** | "Burner laptop with AI" | "Portable AI computer" |
| **Privacy** | "Burner with full anonymity" | "Encrypted portable + anonymity" |

### Mode parity guarantees (no gaps)

**Same features work in ALL FOUR configurations.** The only differences:
- Speed (Tor is slower than direct internet)
- Trace footprint (amnesia leaves nothing, persistent leaves encrypted data on USB)

See `docs/mode-parity.md` for the exhaustive feature matrix. Anything that
doesn't work in one mode gets a documented "known gap" entry — no silent
feature loss. Phase 8 builds the harness that proves this.

The one **known v1.0 gap**: Electrobun's CEF Chromium WebView doesn't
auto-inherit the SOCKS proxy. In Privacy Mode, Milady's agent (Bun
fetch) routes through Tor correctly, but Chromium *windows* may
leak. Documented in `docs/privacy-mode-v1-gap.md`. Closing this is
v1.1 work (patch Electrobun to inject `--proxy-server`).

---

## Locked design decisions

### Architecture: full-fork of Tails, additive modifications

- Tails source lives in `tails/` at this directory's root (~6000
  tracked files, copied from a Tails `stable` clone).
- We **never delete** Tails code. All elizaOS/Milady additions are overlays,
  hooks, package-list additions, and replacement files inside Tails'
  tree. Tor, AppArmor, MAC spoofing, Persistent Storage, Plymouth — all
  stay intact.
- Matches `packages/os/android/vendor/eliza/` precedent in this
  monorepo (brand vendor tree inside system structure).

### Build system: containerized (Phase 1 — done)

Tails' upstream build drives a Vagrant + libvirt VM. We **replaced that
with a plain container** — the container *is* the build environment.
Any dev on Linux/macOS/Windows/CI runs `just build` and gets the same
ISO. The earlier Vagrant attempt is documented (and buried) in
[`docs/build-infrastructure.md`](./docs/build-infrastructure.md); don't
resurrect it.

### First-boot UX: elizaOS-branded greeter + Milady chat for personal choices

Tails uses a GTK greeter (`tails-greeter`) at first boot. We **keep
this UX** — it's battle-tested for live-USB scenarios — and rebrand it.

Boot sequence:
1. **boot menu** — pick "elizaOS" or "elizaOS — Privacy Mode"
2. **Plymouth splash** (elizaOS wordmark)
3. **elizaOS greeter** (rebranded `tails-greeter`):
   - Language / keyboard / formats
   - Admin password (sudo)
   - MAC spoofing on/off
   - **Persistent Storage**: "Unlock" (if exists) / "Create" (first time)
4. **GNOME loads** (Tails default DE, kept)
5. **Milady Electrobun app auto-launches as the always-on home window** —
   chat-driven onboarding for personal choices (name, what to build
   first, claude signin). It is not a kiosk: the normal Tails/GNOME
   desktop stays usable, and the app is supervised by a root-owned
   systemd service so closing/crashing it relaunches it.

System-level choices go through the GTK greeter. Personal/AI choices
go through Milady chat (matches the v36 onboarding pattern).

### Branding

- Full elizaOS brand in OS UI: boot splash, greeter title + colors, GNOME
  theme, wallpaper. Tails onion logo replaced with elizaOS artwork.
- **Tails credit** in:
  - `/usr/share/doc/elizaos-tails/CREDITS`
  - About elizaOS page (system)
  - License/credits docs shipped with the image
- License posture: **GPL-3.0-or-later** (inherited from Tails). Our
  Apache-2 contributions dual-licensed where possible.

### GPU access works in BOTH modes

Kernel loads GPU drivers (amdgpu, i915, nvidia, nouveau) regardless of
where root filesystem lives. Vulkan / CUDA / ROCm all functional from
USB boot. Local LLM gets full GPU acceleration on user's hardware.

### Feature parity matrix (high level — full version in docs/mode-parity.md)

| Feature | Normal+Amnesia | Normal+Persist | Privacy+Amnesia | Privacy+Persist |
|---|---|---|---|---|
| Local LLM chat | ✓ | ✓ | ✓ | ✓ |
| BUILD_APP via local stub | ✓ | ✓ | ✓ | ✓ |
| BUILD_APP via Claude CLI | ✓ | ✓ | ✓ slow | ✓ slow |
| Voice (Whisper / Kokoro) | ✓ | ✓ | ✓ | ✓ |
| Wallpaper / SET_WM / SHELL | ✓ | ✓ | ✓ | ✓ |
| GPU acceleration | ✓ | ✓ | ✓ | ✓ |
| Cloud APIs | ✓ fast | ✓ fast | ✓ slow | ✓ slow |
| OAuth | ✓ | ✓ | ⚠ may be blocked | ⚠ may be blocked |
| Chromium browser windows | ✓ | ✓ | ⚠ v1.0 gap | ⚠ v1.0 gap |
| Onboarding survives reboot | ✗ redo | ✓ once | ✗ redo | ✓ once |
| Built apps survive reboot | ✗ | ✓ | ✗ | ✓ |
| Downloaded models survive reboot | ✗ | ✓ | ✗ | ✓ |
| Wifi passwords | ✗ | ✓ | ✗ | ✓ |
| API keys | ✗ | ✓ in LUKS keyring | ✗ | ✓ in LUKS keyring |

(✓ = works. ⚠ = works with caveat. ✗ = wipes on reboot by design.)

---

## Phase 0 — Scaffold ✅ DONE

- [x] Directory `packages/os/linux/variants/milady-tails/`
- [x] README + PLAN + docs/
- [x] Tails source copied to `tails/`
- [x] Justfile

---

## Phase 1 — Base ISO builds + boots ✅ DONE

Goal: the build pipeline runs against our Tails tree and produces a
bootable ISO indistinguishable from upstream Tails.

**Spec:** [`docs/build-infrastructure.md`](./docs/build-infrastructure.md)

- [x] Containerized build pipeline — `Dockerfile`, `build.sh`,
  `build-iso.sh`, `acng.conf`, `Justfile` (recipes `build` / `build-fast` /
  `config` / `binary` / `nspawn` / `boot` / `clean` / `cache-clean`)
- [x] `apt-cacher-ng` wired in — required (Tails' chroot has Tor-only DNS
  that's dead at build time; apt reaches packages via the proxy by IP) and
  it caches downloads so rebuilds are fast
- [x] 6 Tails Trixie-compat fixes (builder-box interface naming, `ifupdown`,
  `isc-dhcp-client`, `qemu-guest-agent`, vagrant agent channel, and
  `gdisk`/`mtools` for the partitioning initramfs hook)
- [x] `lb config` go/no-go passes in the container
- [x] Full `lb build` produced a finished `.iso` in `out/`
- [x] Boot the ISO in QEMU via `-cdrom`; confirm Tails greeter appears
- [x] **Success**: base ISO boots to the upstream Tails greeter

---

## Phase 2 — Rebrand the greeter to elizaOS (system-level UI) 🔨 IN PROGRESS

Goal: Tails greeter still does its job, but visually it's elizaOS.

**Spec:** [`docs/specs/phase-2-rebrand.md`](./docs/specs/phase-2-rebrand.md)
— enumerates every file (greeter title/logo/CSS, boot menu, Plymouth,
GNOME theme, wallpaper, `os-release`, `issue`), the real elizaOS asset
sources, and the hard "do not rename" list (apt sources, `/usr/share/doc/tails`,
`TAILS_*` keys, session-wired filenames).

- [x] Greeter: window title → "Welcome to elizaOS!", header logo, dark CSS
- [x] Boot menu title "Tails" → "elizaOS" (GRUB + syslinux)
- [x] Plymouth theme → elizaOS wordmark
- [x] GNOME default → dark elizaOS theme
- [x] Default wallpaper + screensaver background → elizaOS
- [x] `/etc/os-release` → `elizaos-tails` identity (keep all `TAILS_*` keys)
- [x] `/etc/issue` MOTD → elizaOS
- [x] **Tails credit**: greeter footer, `tails-about` "Based on Tails" line,
  `/usr/share/doc/elizaos-tails/CREDITS`
- [ ] Boot ISO in QEMU, confirm branded everywhere + Tails credit visible

Brand assets are pre-rendered (greeter logo, about logo, Plymouth wordmark,
wallpaper, screensaver bg) from real elizaOS sources.

---

## Phase 3 — Privacy-mode toggle (boot-menu pick) 🔨 OVERLAY IMPLEMENTED

Goal: Two boot menu entries flip Tor routing on/off. Both produce an
identical Milady experience minus speed.

**Spec:** [`docs/specs/phase-3-privacy-mode.md`](./docs/specs/phase-3-privacy-mode.md)

- [x] `lib/live/config/0001-elizaos-privacy-mode` — reads the privacy
  kernel cmdline flag (`elizaos_privacy=1`, with compatibility for
  `elizaos.privacy=on`) → writes `/etc/elizaos/privacy-mode`; malformed
  values fail closed to privacy/Tor mode
- [x] `etc/ferm/ferm-direct.conf` — permissive firewall (Tor NAT-redirects
  dropped), the `privacy=off` counterpart to Tails' Tor-only `ferm.conf`
- [x] `dispatcher.d/00-firewall.sh` + `10-tor.sh` branch on the flag
- [x] Boot entries: GRUB (`grub.cfg` edit) + syslinux (`10-syslinux_customize`)
- [x] resolv.conf handled per-mode
- [ ] Test both boot entries in QEMU; confirm direct + Tor traffic

---

## Phase 4 — Bake the Milady Electrobun app into the ISO 🔨 OVERLAY IMPLEMENTED

Goal: `/opt/milady/` exists in the chroot, contains a runnable binary.

**Spec:** [`docs/specs/phase-4-bake-milady-app.md`](./docs/specs/phase-4-bake-milady-app.md)
— the real (fragile) build sequence, the `9100-install-milady` hook
design, and the `ldd`-derived `milady-runtime.list`.

- [x] `just milady-app` recipe — builds the Milady Linux app on the host
  (the build needs the `eliza`-first install + `setup-upstreams.mjs` +
  `MILADY_ELIZA_SOURCE=local` dance — a naive `bun run build:desktop` fails)
- [x] Stage the app tree into `tails/config/chroot_local-includes/usr/share/elizaos/milady-app/`
  (`.gitignore`'d — it is ~2.5–2.9 GB uncompressed, far too large to commit)
- [x] `tails/config/chroot_local-hooks/9100-install-milady` — installs to
  `/opt/milady/`, guards `version.json`, fixes perms incl. `chrome-sandbox`
  setuid, then `rm -rf`'s the staging copy (critical for ISO size)
- [x] `tails/config/chroot_local-packageslists/milady-runtime.list` — the
  CEF/Electrobun runtime libs (NOT `libwebkit2gtk-4.1` — Electrobun bundles
  its own CEF)
- [x] Static `usr/share/applications/milady.desktop`
- [ ] Build ISO, boot, launch Milady, confirm chat UI renders

⚠ **Top risk**: the app tree is ~2.9 GB uncompressed (`eliza-dist/` alone is
2.2 GB) — much larger than first estimated. The resulting ISO could be
3–4 GB. And `chrome-sandbox` under Tails' AppArmor + read-only squashfs is
the most likely "boots but won't render" failure (`--no-sandbox` fallback
documented). See the spec + ROADMAP risk section.

---

## Phase 5 — Auto-launch Milady on greeter exit 🔨 OVERLAY IMPLEMENTED

Goal: after the greeter exits, GNOME comes up with Milady as the first
window and keeps it available as the home agent without hiding the normal
desktop.

**Spec:** [`docs/specs/phase-5-6-autolaunch-and-agent.md`](./docs/specs/phase-5-6-autolaunch-and-agent.md)
— mostly config, not code: Tails honors `/etc/xdg/autostart/`, and the
current implementation adds a root-owned systemd path/service supervisor.

- [x] `etc/systemd/system/milady.path` + `milady.service` — root-owned
  system service starts when the live user session bus appears, runs
  Milady as `amnesia`, and restarts it if it exits
- [x] `etc/xdg/autostart/milady.desktop` — backup/session launch entry
  using `/usr/local/bin/milady`
- [x] `/usr/local/bin/milady` — pins `ELIZA_STATE_DIR=/home/amnesia/.eliza`
  plus XDG dirs in the launch env and uses a lock to avoid duplicate app
  instances
- [x] `etc/dconf/db/local.d/00_Tails_defaults` — dark theme, wallpaper,
  disable GNOME welcome dialog (don't clobber Tails' `enabled-extensions`)
- [x] chroot hook runs `dconf update`
- [ ] Verify in QEMU: boot → greeter → Start → GNOME → Milady

---

## Phase 6 — Wire Milady's onboarding + agent on elizaOS Live 🔨 PARTIAL OS OVERLAY

Goal: the same Milady that runs on macOS desktop runs on this live USB.

**Spec:** [`docs/specs/phase-5-6-autolaunch-and-agent.md`](./docs/specs/phase-5-6-autolaunch-and-agent.md).

This is **not "one code delta" — it is real product integration work.**
The live image has to align the Electrobun/CEF runtime, embedded Bun
agent, plugin package graph, `~/.eliza` state, model/provider defaults,
and Tails' live-user session. The demo branch includes explicit runtime
guards/fallbacks; production needs cleaner package boundaries and a
security review of every privileged capability.

- [ ] Replace demo-only package/runtime fallbacks with first-class
  production package boundaries where needed
- [x] Decide the canonical state dir (`~/.eliza`) + env prefix for the
  OS-side launch path: `/usr/local/bin/milady` exports `ELIZA_STATE_DIR`,
  `MILADY_STATE_DIR`, `ELIZAOS_*`, and `ELIZAOS_CAPABILITY_RUNNER`
- [ ] `~/.eliza` works in amnesia (tmpfs) and persistent (LUKS bind-mount)
- [ ] Verify BUILD_APP (stub + Claude backends), OPEN_APP, local LLM on GPU,
  the v36 3-question onboarding running in chat

---

## Phase 7 — Persistent USB integration (Tails-native) 🔨 OVERLAY IMPLEMENTED

Goal: user opts into LUKS persistence via the greeter; Milady's data
survives reboots; **no Tails persistence code is modified, only added
configuration**.

**Spec:** [`docs/specs/phase-7-persistence.md`](./docs/specs/phase-7-persistence.md)
— note: this Tails release uses the modern **Persistent Storage (`tps`)**
stack, not the legacy `tails-persistence-setup`. Footprint is tiny.

- [x] One `MiladyData` `Feature` subclass in `tps/configuration/features.py`
  (bindings for `~/.eliza`, `~/.milady`, `~/.config/milady`,
  `enabled_by_default=True`)
- [x] One UI row in `features_view.ui.in` (required or the frontend crashes)
- [x] One on-activated hook (wipe stale runtime/cache and singleton lock state)
- [ ] 2 thin agent chat actions ("save my work…", "what's on my storage?")
  that shell Tails' GUI — do NOT reimplement LUKS
- [ ] Verify in QEMU with a multi-partition virtual USB

---

## Phase 8 — Mode-parity validation 📋 SPEC'D

Goal: all 4 combos work the same. Anything that doesn't = documented gap.

**Spec:** [`docs/specs/phase-8-mode-parity-harness.md`](./docs/specs/phase-8-mode-parity-harness.md)
— a `mode-parity.sh` orchestrator for this variant's QEMU and USB-image
paths.

- [ ] `scripts/mode-parity.sh` + `scripts/mode-parity-checklist.sh`
- [ ] Boots all 4 `{amnesia,persistent}×{normal,privacy}` combos through
  one shared checklist, diffs them, emits `parity-report.md`
- [ ] `just mode-parity` recipe
- [ ] Fold findings into `docs/mode-parity.md`

---

## Phase 9 — Rice / customization actions 📋 SPEC'D

Goal: "Install i3", "switch tiling", "swipe-down-for-notis" — all through
chat with Milady orchestrating Linux underneath.

**Spec:** [`docs/specs/phase-9-customization-actions.md`](./docs/specs/phase-9-customization-actions.md)
— most substrate already exists (`INSTALL_PACKAGE` + its confirmation
flow, `OPEN_TERMINAL`, `SET_WALLPAPER`).

- [ ] `SHELL` action — a thin gating layer over the existing apt infra +
  build-time polkit `.rules` / sudoers `.toml` overlays for passwordless
  privileged ops
- [ ] `SET_DESKTOP`, `THEME`, `NOTIFICATIONS` actions (compose the existing
  install flow)
- [ ] Shared `customization.ts` persistence-awareness helper
- [ ] `docs/customization-vocabulary.md`

---

## Phase 10 — Bare-metal USB validation ⏳ NOT STARTED

- [ ] Write ISO to real USB via `dd`
- [ ] Boot on real hardware (2–3 machines: Intel, AMD, NVIDIA GPU)
- [ ] Verify all Phase 1–9 features work bare-metal
- [ ] Verify persistence flow on a real USB stick
- [ ] Verify GPU acceleration on real graphics cards

---

## Phase 11 — Release v1.0 ⏳ NOT STARTED

- [ ] Doc polish, CREDITS, license bundle
- [ ] License audit (every file: authored vs. Tails-derived)
- [ ] Build reproducibility check
- [ ] Cut release tag, attach ISO to a GitHub Release
- [ ] Open a Discussions thread for v1.1 priorities

---

## Deferred / future (v1.x and beyond)

### Install-to-internal-disk mode (DEFERRED, considering carefully)

> "Make this my main computer. Wipe my drive, install elizaOS on it."
> — would let users use elizaOS as a daily-driver Linux,
> trading the live-USB constraints for full hardware speed + storage.

**Why deferred and being considered with respect for Tails' design**:

Tails refuses to install itself to disk by design. Their reasoning:
- **Disk = traceable**. Log files, swap, fsync'd writes leave forensic
  evidence that contradicts Tails' "leave no trace" promise.
- **Live-USB enforces good habits**. If everything wipes on reboot,
  users naturally treat each session as fresh.
- **The threat model assumes adversaries with physical access**, who
  could analyze a disk image but not a powered-off RAM stick.

We respect that reasoning. An elizaOS ISO that defaults to amnesia
inherits the same forensic protection. Tails users picked Tails
specifically because there's no disk install option — adding one
without thought betrays that choice.

**That said**: Milady's target audience is broader than Tails'. Many
users want "AI Linux as my daily driver" without needing
amnesia-on-laptop. For them, install-to-disk would be a real product.

Before we add it, we need a real design RFC covering: the threat model
when installed, default full-disk encryption, the dual-boot story, the
install UX (Calamares vs. Milady-chat-driven), and the Tails community
pulse on the derivative. **Planned target: v2.0**, after v1.0 ships and
real users tell us what they want. **For now: don't add it.**

### Chromium WebView proxy patches (v1.1)

Closes the Privacy-Mode-Chromium-leak gap. Patch Electrobun to inject
`--proxy-server=socks5://127.0.0.1:9050` into Chromium launch flags
when `elizaos.privacy=on`. Likely an upstream PR to Electrobun.

### Runtime privacy toggle (v1.2 or later)

Switch privacy modes mid-session without reboot. iptables atomic swap +
tor.service start/stop + Chromium re-proxy.

### Cross-distro install medium (post-v2.0)

`.deb`, `.AppImage`, Flatpak packaging. Lower priority — the live-USB IS
the product.

---

## Risk inventory

1. **Tails build latent bugs** — every build run so far surfaced a real
   Trixie-compat bug. 6 found + fixed; more may surface in the chroot
   hooks / binary stage. The containerized loop + `apt-cacher-ng` cache
   makes each iteration fast.
2. **ISO size** — the Milady app tree is ~2.9 GB uncompressed. On top of
   Tails (~1.3 GB squashfs) the ISO could be 3–4 GB. Mitigations: the
   `9100` hook must `rm -rf` the staging copy; consider a slimmer build
   profile; re-measure and budget. See Phase 4 spec.
3. **`chrome-sandbox` under AppArmor + squashfs** — the likely "boots but
   Milady won't render" failure. `--no-sandbox` is the documented fallback.
4. **Phase 6 is real product integration** — not a quick edit. CEF,
   embedded Bun, bundled plugins, model/provider defaults, state dirs, and
   supervised OS capabilities all have to agree inside the live-user
   session. The in-session model helps, but it still needs proof.
5. **Milady build fragility** — the desktop build needs a specific
   `eliza`-first + `setup-upstreams.mjs` + `MILADY_ELIZA_SOURCE=local`
   sequence; a naive `bun run build:desktop` fails. Encoded in `just milady-app`.
6. **Large monorepo bloat** — the vendored `tails/` tree is ~6000 files.
   PR maintainers may push back; submodule pattern is the fallback.
7. **Tor blocking cloud APIs** — Anthropic/OpenAI often refuse Tor exit
   IPs. In Privacy Mode cloud chat may fail; local LLM still works.
8. **Chromium proxy gap (v1.0)** — WebView windows leak in Privacy Mode.
   Real security gap, fixed in v1.1.
9. **Cold-boot RAM attacks** — theoretical threat against amnesia. Tails'
   `memlockd` zeros RAM on shutdown; we keep it.

---

## Open questions

- **Which Tails release tag to track?** Currently a Tails `stable` clone.
  Pin in `tails/debian/changelog`; document upgrade cadence.
- **Vendored `tails/` git strategy** — the vendored copy ships without
  `.git`; `build-iso.sh` `git init`s a throwaway repo at build time so
  the build works either way. Long-term: keep as committed files, or
  convert to a submodule of an elizaOS Tails fork. Decide before v1.0.
- **Default browser in Normal Mode** — Tor Browser doesn't fit direct
  internet. Or: no browser, Milady opens links in app-mode windows.
- **Canonical state dir + env prefix** — elizaOS Live should standardize
  on `~/.eliza` for product state while supporting existing app/runtime
  paths (`MILADY_*`, `~/.milady`) until the app package is renamed.

---

## How to contribute

The build needs only Docker. From this directory:

```
just config        # ~1 min go/no-go — does the Tails config tree process?
just build         # full clean ISO → out/  (~1–1.5 h cold, faster cached)
just binary        # ~10 min incremental rebuild after editing overlay files
just nspawn        # seconds — boot the built chroot for non-GUI sanity
just boot          # boot the latest ISO in QEMU
```

Pick a phase, read its spec in `docs/specs/`, implement against the
vendored `tails/` tree, validate with `just binary` + `just boot`.
Exploratory work until Phase 10 ships a real v1.0 ISO that boots on bare
metal.
