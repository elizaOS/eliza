# PLAN.md — milady-tails build order

The phased work order to take milady-tails from "empty scaffold" to "boots
into a working Linux + Milady desktop on real USB hardware, with optional
Tor privacy mode and optional encrypted persistent storage."

This is a multi-week project. Each phase has a clear success criterion;
don't jump phases — live-build's feedback loop is 15-30 min per attempt
and several phases need iteration.

---

## v1.0 scope (locked 2026-05-14)

**USB-only** distribution with two storage modes and a privacy toggle.
**No install-to-internal-disk yet** — see § Deferred for the rationale.

### Storage modes (pick at boot)

1. **Amnesia (default)** — RAM only, no disk writes, full wipe on
   shutdown. Required for "borrowed laptop / hotel / zero footprint".
   Tails' default behavior, kept identical.
2. **Persistent USB (opt-in)** — LUKS-encrypted partition on the USB
   stick. Reuses Tails' `tails-persistence-setup` tool unchanged.
   Selected dirs bind-mount from the LUKS partition.

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

See `docs/mode-parity.md` for the exhaustive feature matrix and what's
verified to work in each combo. Anything that doesn't work in one mode
gets a documented "known gap" entry — no silent feature loss.

The one **known v1.0 gap**: Electrobun's CEF Chromium WebView doesn't
auto-inherit the SOCKS proxy. In Privacy Mode, Milady's agent (Bun
fetch) routes through Tor correctly, but Chromium *windows* may
leak. Documented in `docs/privacy-mode-v1-gap.md`. Closing this is
v1.1 work (patch Electrobun to inject `--proxy-server` flag).

---

## Locked design decisions

### Architecture: full-fork of Tails, additive modifications

- Tails source lives in `tails/` at this directory's root (6077
  tracked files, copied from `/home/nubs/Git/tails` minus `.git`).
- We **never delete** Tails code. All Milady additions are overlays,
  hooks, package-list additions, and replacement files inside Tails'
  tree. Tor, AppArmor, MAC spoofing, persistence-setup, Plymouth — all
  stay intact.
- Matches `packages/os/android/vendor/eliza/` precedent in this
  monorepo (brand vendor tree inside system structure).

### First-boot UX: Tails greeter rebranded + Milady chat for personal choices

Tails uses a GTK greeter (`tails-greeter`) at first boot. We **keep
this UX** — it's battle-tested for live-USB scenarios — and rebrand it.

Boot sequence:
1. **isolinux boot menu** — pick "Milady" or "Milady — Privacy Mode"
2. **Plymouth splash** (Milady wordmark)
3. **Milady greeter** (rebranded `tails-greeter`):
   - Language / keyboard / formats
   - Admin password (sudo)
   - MAC spoofing on/off
   - **Persistent Storage**: "Unlock" (if exists) / "Create" (first time)
4. **GNOME loads** (Tails default DE, kept)
5. **Milady Electrobun app auto-launches fullscreen** — chat-driven
   onboarding for personal choices (name, what to build first, claude
   signin)

System-level choices go through the GTK greeter (it's good for these).
Personal/AI choices go through Milady chat (matches v36 pattern).

### Branding

- Full Milady brand in UI: boot splash, greeter title + colors, GNOME
  theme, wallpaper. Tails onion logo replaced with Milady wordmark.
- **Tails credit** in:
  - `/usr/share/doc/milady-tails/CREDITS`
  - About Milady page (in app)
  - Bottom of the rebranded greeter ("powered by Tails")
  - `LICENSES/` directory + `NOTICE.md`
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

## Phase 0 — Scaffold (DONE this commit)

- [x] Directory `packages/os/linux/variants/milady-tails/`
- [x] README + this PLAN + docs/relationship-to-usbeliza.md
- [x] Tails source copied to `tails/`
- [x] Justfile recipe stubs

**Success**: PR opened, scaffold in monorepo, branch
`nubs/os-linux-milady-tails-scaffold` pushed.

---

## Phase 1 — First boot as Tails (no Milady yet, validates the import)

Goal: prove the live-build pipeline runs against our copied Tails tree
and produces a bootable ISO identical to upstream Tails.

- [ ] Write `Justfile` recipes invoking Tails' own `auto/build`
- [ ] First build attempt: `just iso-build`
- [ ] Debug failures (APT snapshot pins, build-host deps)
- [ ] Boot in QEMU, confirm Tails greeter appears, Tor connects, Tor
  Browser opens
- [ ] **Success**: indistinguishable from upstream Tails

**Effort**: 1-3 days of build-debug iteration. Tails' build has APT
snapshot date pins, requires specific keyring versions, may need
updated host packages.

---

## Phase 2 — Rebrand the greeter to Milady (system-level UI)

Goal: Tails greeter still does its job, but visually it's Milady.

- [ ] Replace greeter window title, logo, color scheme to Milady
- [ ] Boot menu title "Tails" → "Milady"
- [ ] Plymouth theme → Milady wordmark
- [ ] GNOME default GTK theme → dark Milady
- [ ] Default wallpaper → Milady
- [ ] `/etc/os-release` → milady-tails identifier
- [ ] `/etc/issue` MOTD → Milady
- [ ] Apt source comments + `/usr/share/doc/` paths preserved (don't
  break Tails' update path)
- [ ] **Tails credit** added to greeter footer + About + CREDITS file
- [ ] Boot ISO in QEMU, confirm Milady-branded everywhere, Tails credit
  visible

**Effort**: 3-5 days. Lots of small files to touch — Tails' branding
is distributed across hundreds of files.

---

## Phase 3 — Privacy-mode toggle (Path A: boot-menu pick)

Goal: Two boot menu entries flip Tor routing on/off. Both produce
identical Milady experience minus speed.

- [ ] Add second boot menu entry "Milady — Privacy Mode" — same
  kernel + initramfs, different cmdline (`milady.privacy=on|off`)
- [ ] Add `/etc/milady/privacy-mode` flag file populated from cmdline
  by initramfs script
- [ ] Modify `dispatcher.d/00-firewall.sh` to check the flag:
  - `privacy=on` → apply Tails' current ferm.conf (Tor-only)
  - `privacy=off` → permissive ferm.conf variant (direct internet)
- [ ] Modify `dispatcher.d/10-tor.sh`:
  - `privacy=on` → start tor@default.service, wait for bootstrap
  - `privacy=off` → tor.service stays masked
- [ ] Modify `/etc/resolv.conf` handling:
  - `privacy=on` → static `nameserver 127.0.0.1` (Tor DNSPort)
  - `privacy=off` → NetworkManager-managed
- [ ] Add Milady chat action "show me my network status" reporting
  current mode + trade-offs
- [ ] Update `docs/privacy-mode-v1-gap.md` with implementation evidence
  for the Chromium WebView leak
- [ ] Test both boot entries in QEMU; confirm direct + Tor traffic

**Effort**: 5-7 days. Firewall rule ordering is subtle — wrong move
either breaks all networking or leaks past Tor.

---

## Phase 4 — Bake the Milady Electrobun app into the ISO

Goal: `/opt/milady/` exists in chroot, contains a runnable binary.

- [ ] Build Milady for Linux:
  `cd /home/nubs/Git/iqlabs/eliza-labs/milady && bun run build:desktop`
  (already a first-class target — `electrobun.config.ts:426-443`,
  CI workflow `release-electrobun.yml`)
- [ ] Verify output: `~300-400 MB .tar.zst` in milady's `build/` dir
- [ ] Add chroot hook `9100-install-milady.hook.chroot` to:
  1. Read milady tarball from bind-mount or pre-baked path
  2. Extract to `/opt/milady/`
  3. Create `/usr/share/applications/milady.desktop` entry
- [ ] Add `package-lists/milady-runtime.list` — CEF runtime deps:
  libnss3, libgbm, libwebkit2gtk-4.1, libx11, libxdamage, libxrandr,
  libxcomposite, libdrm2, libvulkan1, mesa-vulkan-drivers
- [ ] Test: build ISO, boot, click Milady from apps menu, chat renders

**Effort**: 2-3 days. Biggest risk: undeclared Chromium runtime deps.

---

## Phase 5 — Auto-launch Milady on greeter exit

Goal: After greeter exits, GNOME comes up with Milady fullscreen as
the first window.

- [ ] Add `/etc/xdg/autostart/milady.desktop` for amnesia user
- [ ] Configure GNOME shell defaults:
  - Hide activities overview initially
  - Disable first-run intro
  - Dark Milady theme
- [ ] Verify in QEMU: boot → greeter → Start → GNOME → Milady
  fullscreen

**Effort**: 2-3 days. GNOME defaults need testing across Tails' tweaks.

---

## Phase 6 — Wire Milady's onboarding + agent on milady-tails

Goal: Same Milady that runs on macOS desktop runs on this live USB.
"build me a calculator" → real Chromium app window appears.

- [ ] Verify Milady's `~/.eliza/` works in amnesia mode (tmpfs)
- [ ] Verify `~/.eliza/` works in persistent mode (LUKS bind-mount)
- [ ] Verify BUILD_APP:
  - Stub backend (no claude): placeholder HTML works
  - Claude backend (signed in): v36 multi-turn paste-code OAuth flow
- [ ] Verify OPEN_APP launches Chromium app-mode window
- [ ] Verify local LLM uses GPU (test virtio-gpu in QEMU + bare-metal
  NVIDIA / AMD)
- [ ] Verify v36 3-question onboarding runs in chat after greeter

**Effort**: 1 week. Mostly verification — code exists upstream.

---

## Phase 7 — Persistent USB integration (Tails-native)

Goal: User opts into LUKS persistence via the greeter; Milady's data
survives reboots; **no Tails persistence code is modified, only added
configuration**.

- [ ] Add `tails-persistence-setup` config that knows about our dirs:
  - `~/.eliza/` (chat history, calibration, app builds, model cache)
  - `~/.milady/` (alternative state dir if any plugin uses it)
  - `/etc/NetworkManager/system-connections/` (Wi-Fi passwords —
    already in Tails' default persistent list)
  - `~/.config/milady/` (custom themes, dotfile customizations)
- [ ] Add Milady chat action "save my work to encrypted USB partition"
  that:
  - Detects no LUKS partition exists → prompts user to set one up
  - Launches Tails' persistence-setup GUI
  - On completion, marks the persistence-config done
- [ ] Add chat action "what's on my persistent storage?" — lists dirs
  + sizes
- [ ] Verify in QEMU with a multi-partition virtual USB:
  - First boot: amnesia, set up persistence via Milady chat
  - Reboot: greeter detects LUKS, asks for passphrase
  - Unlock → Milady boots with old chat history intact

**Effort**: 4-5 days. Most of this is integration — Tails' persistence
tooling does the heavy lifting; we just configure which dirs we want
and add chat-driven prompts.

---

## Phase 8 — Mode-parity validation

Goal: All 4 combos work the same. Anything that doesn't = documented
gap, not silent failure.

- [ ] Finalize `docs/mode-parity.md` with verified mode coverage
- [ ] Build mode-parity test harness: for each of 4 combos
  (normal+amnesia, normal+persist, privacy+amnesia, privacy+persist):
  - Boot ISO with that config
  - Drive Milady through full feature set via QMP keyboard injection
    (same pattern we used for usbeliza)
  - Screenshot each feature
  - Compare against expected
- [ ] Any gap found → document or fix
- [ ] **No silent feature loss** — every working feature works in all 4
  modes, every gap is in the doc

**Effort**: 1 week. Tedious but essential.

---

## Phase 9 — Rice / customization actions

Goal: "Install i3", "switch tiling", "swipe-down-for-notis" — all
through chat with Milady orchestrating Linux underneath.

- [ ] SHELL action with polkit gating (Milady can `apt install`
  without password prompts, configured at build time)
- [ ] SET_DESKTOP action — writes session config so next login uses
  chosen WM (i3, sway, awesome, KDE, …)
- [ ] THEME action — orchestrates GTK theme / dotfiles
- [ ] NOTIFICATIONS action — installs/configures swaync or GNOME
  shell extensions for Android-style swipe-down UX
- [ ] `docs/customization-vocabulary.md` — full chat command set
- [ ] **Persistence-aware**: customizations only stick in persistent
  mode. Amnesia mode resets to defaults each boot.

**Effort**: 1-2 weeks. Each customization needs a tested chain.

---

## Phase 10 — Bare-metal USB validation

- [ ] Write ISO to real USB via `dd`
- [ ] Boot on real hardware (2-3 machines: Intel, AMD, NVIDIA GPU)
- [ ] Verify all Phase 1-9 features work bare-metal
- [ ] Verify persistence flow on real USB stick (create, reboot,
  unlock, data persists)
- [ ] Verify GPU acceleration on real graphics cards

**Effort**: 3-5 days. Same risks as usbeliza Phase 0 — BIOS quirks,
GPU drivers, Wi-Fi firmware not in chroot.

---

## Phase 11 — Release v1.0

- [ ] Doc polish, CREDITS, NOTICE
- [ ] License audit (every file: authored vs. Tails-derived)
- [ ] Build reproducibility check
- [ ] Cut release tag, attach ISO to GitHub Release
- [ ] Open Discussions thread for v1.1 priorities (Chromium proxy
  patches, runtime privacy toggle, install-to-disk RFC)

---

## Deferred / future (v1.x and beyond)

### Install-to-internal-disk mode (DEFERRED, considering carefully)

> "Make this my main computer. Wipe my drive, install Milady-Linux on
> it." — would let users use milady-tails as a daily-driver Linux,
> trading the live-USB constraints for full hardware speed + storage.

**Why deferred and being considered with respect for Tails' design**:

Tails refuses to install itself to disk by design. Their reasoning:
- **Disk = traceable**. Log files, swap, fsync'd writes leave forensic
  evidence that contradicts Tails' "leave no trace" promise.
- **Live-USB enforces good habits**. If everything wipes on reboot,
  users naturally treat each session as fresh.
- **The threat model assumes adversaries with physical access**, who
  could analyze a disk image but not a powered-off RAM stick.

We respect that reasoning. A milady-tails ISO that defaults to amnesia
inherits the same forensic protection. Tails users picked Tails
specifically because there's no disk install option — adding one
without thought betrays that choice.

**That said**: Milady's target audience is broader than Tails'. Many
users want "AI Linux as my daily driver" without needing
amnesia-on-laptop. For them, install-to-disk would be a real product.

Before we add it, we need a real design RFC that thinks through:

1. **Threat model when installed**: does milady-tails-installed offer
   any of the forensic protections amnesia mode does? (Probably no —
   it's just normal Linux at that point.) Be honest about what users
   trade for installing.
2. **Default FDE**: Should installed milady-tails REQUIRE LUKS
   full-disk encryption? Tails users would expect yes.
3. **Dual-boot story**: Wipe-only, or can users dual-boot with an
   existing Windows/macOS? Wipe-only is simpler but commits users.
4. **Install UX**: Calamares wizard (familiar to Linux users), or
   Milady-chat-driven ("install me on /dev/nvme0n1, type yes")?
   Probably chat for consistency with our paradigm.
5. **Tails community pulse**: would the Tails project see this as a
   fair derivative, or would they ask us to rename? (Likely fine
   since we're already forking + rebranding, but worth asking.)

**Planned target**: v2.0, after v1.0 amnesia + persistent USB ships and
real users tell us what they want.

**For now**: don't add it. The v1.0 ISO is intentionally USB-only.
Users who want a disk install can build their own from this base or
wait for v2.0.

### Chromium WebView proxy patches (v1.1)

Closes the Privacy-Mode-Chromium-leak gap. Patch Electrobun to inject
`--proxy-server=socks5://127.0.0.1:9050` into Chromium launch flags
when `milady.privacy=on`. Likely upstream PR to Electrobun.

### Runtime privacy toggle (v1.2 or later)

Switch privacy modes mid-session without reboot. iptables atomic swap
+ tor.service start/stop + Chromium re-proxy. New systemd daemon
`milady-network-mode.service` listening on D-Bus.

### Cross-distro install medium (post-v2.0)

`.deb`, `.AppImage`, `.snap`, Flatpak packaging for distros that don't
want the full live-USB. Lower priority — the live-USB IS the product.

---

## Risk inventory

1. **Tails build system complexity** — hundreds of config files,
   APT snapshot pins, build-host package requirements. Phase 1 will
   probably fail several times before clean.
2. **Large monorepo bloat** — PR maintainers may push back on
   committing all of Tails. Fallback: submodule pattern. Pivot-friendly
   mid-PR.
3. **GPL-3 inheritance** — anything derived from Tails is GPL-3.
   Documented in NOTICE; same posture as usbeliza.
4. **Tor blocking cloud APIs** — Anthropic and OpenAI often refuse Tor
   exit IPs. In Privacy Mode, cloud chat may fail entirely; local LLM
   still works. Document in `docs/privacy-mode-v1-gap.md`.
5. **Cold-boot RAM attacks** — theoretical threat against amnesia.
   Tails has `memlockd` for RAM-zeroing on shutdown; we keep it.
6. **Chromium proxy gap (v1.0)** — WebView windows leak in Privacy
   Mode. Real security gap, fixed in v1.1.
7. **Milady-electrobun-linux maturity** — target exists but isn't
   shipped as a release product yet. First builds may surface
   platform issues.
8. **USB persistence wear** — heavy writes to LUKS partition wear USB
   flash faster than SSDs. Document the trade-off; recommend
   high-endurance USB sticks for daily-driver persistent use.

---

## Open questions

- **Which Tails release tag to track?** They cut stable monthly. Pin
  in `tails/debian/changelog`, document upgrade cadence in CONTRIBUTING.
- **Where does the Milady Electrobun build artifact come from?**
  (a) bind-mount pre-built tarball, (b) build inside chroot (slow),
  (c) download from milady GitHub release URL. Probably (a) for v1.0,
  (c) for v1.1 reproducibility.
- **Default browser in Normal Mode**: Tor Browser doesn't make sense
  for direct internet. Firefox? Chromium? Or no browser — Milady
  opens links in app-mode windows.
- **Minimum persistence dir set**: `~/.eliza/` + Tails defaults (Wi-Fi).
  Possibly add `~/.config/`, `~/Documents/`. Needs UX design.

---

## How to contribute

Pick a phase, open PR to `nubs/os-linux-milady-tails-*` branch family
on elizaOS/eliza. Don't merge straight to develop — exploratory until
Phase 10 ships and a real v1.0 ISO boots on bare metal.

Test in QEMU first via `just iso-debug` (systemd-nspawn ~30s) or
`just iso-boot` (full QEMU). Add screenshots to PR for any phase
touching user-visible UX.
