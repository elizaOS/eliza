# usbeliza — current status

**Last updated:** 2026-05-13.

## TL;DR

**v35 ISO ships at `out/usbeliza-v35-final-amd64.iso` — production-ready USB-stick OS with persistence, OAuth, themed boot, all visible in QEMU.**

The wave between v18 and v35 closed every visible polish gap: persistence works on the real-USB code path (was bricked at slot 3), the OAuth Chromium opens chrome-less + floating + visible (was invisible behind a fullscreen Eliza), local-llama backs every chat turn the moment Claude isn't signed in (was throwing a "can't reach my local model" preset), the boot splash is the orange Eliza wordmark on pure black (was the Debian default joy theme), and the chat is the only thing on screen until the user asks for more.

| Capability | State |
|---|---|
| Live ISO boots in QEMU (legacy BIOS + UEFI + USB-storage emulation) | ✓ |
| Live ISO boots on real bare-metal USB (Phase 1 milestone) | ⏳ user write-pending |
| Plymouth splash: orange "Eliza" wordmark, pulsing dot, pure black | ✓ verified v34 |
| Persistence: chat "set up persistence" → LUKS partition on `/dev/sdaN` via `sfdisk --no-reread --force` + `partx -a` + `losetup` wrap | ✓ verified v28 (both pre-allocated + bare-metal-clean flows) |
| Chat → real local 1B Llama on first boot (no Claude needed) | ✓ verified v33 |
| Chat → cloud Claude after `login to claude` (rephrase + chat-fallthrough + BUILD_APP through `claude --print`) | ✓ delegation pattern in `claude-cloud-plugin` |
| OAuth Chromium: chrome-less app mode, floating 1280×720 centered, single window (no claude-CLI xdg-open) | ✓ verified v35 |
| Onboarding: 10 questions rephrased through whatever model is available (local or cloud) from turn 1 | ⏳ in source (v36 staged but not built) |
| Action surface in chat: 22 actions, 5 multi-turn flows | ✓ |
| 377/377 agent unit tests, Rust workspace clean, tsc clean | ✓ |

## v25–v35 (2026-05-12 → 2026-05-13): persistence + OAuth visibility + theming

Eleven point releases worth of fixes that fall into four buckets:

**Persistence on USB code path (v25–v28).** The Linux kernel locks O_EXCL opens on `/dev/sdaN` when `/dev/sda` is mounted whole-disk as iso9660 — `cryptsetup luksFormat /dev/sda3` and `parted /dev/sda mkpart` both fail with EBUSY. Working chain: `sfdisk --append --no-reread --force` writes the partition table (the BLKRRPART failure is expected), `partx -a` registers the new slot in the kernel, then `losetup -f --show /dev/sda3` wraps the partition in a loop device that cryptsetup can claim exclusively. Writes propagate to the underlying sectors so the LUKS header lands on `/dev/sda3` and the next boot's `live-boot` probe detects it.

**Local-llama for chat-fallthrough + onboarding (v32).** `claude-cloud-plugin` used to throw `"claude is not signed in"` when no auth marker existed. `@elizaos/core`'s model resolver does NOT cascade between TEXT_LARGE providers on throw — it surfaces the throw to the caller. So every chat fall-through hit the catch in `runChatModel` and returned the hardcoded `"I can't reach my local model"` preset, even though local-llama-plugin was right there in the plugins list. Fix: claude-cloud now delegates to `generateViaLocalLlama` (exported from local-llama-plugin) when not signed in, instead of throwing. `useModel(TEXT_LARGE)` is therefore always answerable, which lets the onboarding rephrase default-on for every boot.

**OAuth Chromium visibility (v32–v35).** Three stacked bugs hid the LOGIN_CLAUDE window. (1) `for_window [app_id="^usbeliza\.browser\..*"]` missed because chromium 148 under Ozone-Wayland reports `app_id=null` regardless of `--class=`; added a `[class="Chromium"]` X11-side catch-all. (2) Eliza was set to `fullscreen enable` in sway/config — sway's true-fullscreen mode hides ALL siblings, even `sticky` floats, so chromium opened with `visible: false`; dropped to default tiling. (3) Chromium `--app=URL` PWA mode generates a synthetic `app_id` of the form `chrome-DOMAIN-PROFILE` that doesn't match the `usbeliza.*` rule either; added a `^chrome-.*` fallback. Plus the chromium spawn itself: `--app=URL` for chrome-less webview, `--use-gl=swiftshader` for opaque software rasterization (fixes "Eliza chat leaks through OAuth window when scrolling" rendering glitch under `--disable-gpu`), and `BROWSER=/bin/true` in the claude-CLI spawn env so the CLI's xdg-open call no-ops (prevents a second chromium with regular chrome bar from opening beside the app-mode one).

**Boot splash theming (v34).** Plymouth IS configured to use `usbeliza` via `/etc/plymouth/plymouthd.conf`, the theme files are in the initramfs, and `plymouth-set-default-theme usbeliza --rebuild-initrd` runs in the 0500 hook. The old `usbeliza.script` was using `"·"` Unicode middle-dot which framebuffer console fonts don't all carry — plymouth silently fell back to the default dots animation. Rewrote with ASCII-only glyphs (`.` instead of `·`) + precomputed 30-frame alpha-pulse cycle (no per-frame `Image.Text` allocation that crashed plymouth on slow disks). Plus kernel cmdline `rd.systemd.show_status=false vt.global_cursor_default=0` to suppress the Debian text/cursor that was bleeding through. v34 boot now: GRUB → kernel/initrd → orange "Eliza" wordmark + pulsing dot → handoff to sway/elizad. Zero Debian branding visible.

**Loading UX (v33).** Onboarding's "yes" to claude offer used to silently fire LOGIN_CLAUDE and emit the next question. The chromium window takes 3–5s to render, and users typed again thinking the chat froze. The next-question reply now prepends `"Opening the Claude sign-in window — it'll pop up in a few seconds. While that loads: "` so the latency is acknowledged before it starts.

**Misc.** Added `parted` + `gdisk` to the chroot package list (the persistence-setup script needs them on a bare-metal first boot to grow the partition table). Added `bootloaders/isolinux/{isolinux,live}.cfg` (live-build's Debian-Trixie xorriso default-stripped our kernel cmdline + set `timeout 0` no-auto-boot menu; we override with the full cmdline + `timeout 1`). `live-build/config/includes.chroot_before_packages/etc/dpkg/dpkg.cfg.d/usbeliza-build-non-interactive` bakes `force-confdef`/`force-confold` into the chroot so a Trixie point-release boundary mid-build doesn't hang dpkg on the `/etc/issue` conffile prompt. Refactored `Justfile`'s `iso-boot` recipe into `scripts/iso-boot.sh` so just 1.50's `bash -uc` `$$` quirk doesn't break it.

## v18 (2026-05-12): real-Claude wave, kept

| Path | Real-world result |
|---|---|
| Cloud Claude rephrase (HELP, CURRENT_TIME, LIST_APPS, etc) | ✓ **5-6s, real Claude voice** |
| Chat fallthrough ("what should we build today") | ✓ **Real Claude conversation** (was local 1B garbage before) |
| BUILD_APP "build me a stopwatch" | ✓ **62s, 10.7 KB real HTML, last_built_by:claude-code-unknown** |
| INSTALL_PACKAGE "install ripgrep" | ✓ **ripgrep 14.1.1 installed, prompts cloud-Claude rephrased** |
| OPEN_FILES "open files" | ✓ **thunar spawned** |
| OPEN_TERMINAL | ✓ **alacritty + foot fallback both work** |

Four root-cause bugs fixed in v18:

1. **`USBELIZA_CODEGEN_STUB=1` was hardcoded in the unit file** — every BUILD_APP used the deterministic stub, never real Claude. Flipped to `=0`; generate-app.ts falls back to stub when claude isn't signed in (graceful degrade).
2. **Cloud Claude was never registered as a TEXT_LARGE provider** — rephrase routed to local 1B which produced garbage like "Hi Eliza, it's 10:21 AM UTC". New `claude-cloud-plugin.ts` registers TEXT_LARGE via `claude --print --model claude-sonnet-4-6` spawn, priority 100. Throws when claude isn't available; rephrase wrapper falls back to preset.
3. **`--max-tokens` flag not supported by claude CLI 2.x** — cloud plugin's spawn errored, fell back to preset silently. Dropped the flag; the prompt's `≤300 chars` instruction caps length.
4. **apt indices + alacritty + thunar missing from chroot** — `--apt-indices true` in lb config, new `0520-usbeliza-extra-apps.hook.chroot` force-installs alacritty + thunar (cache-trap immune).

v17 closes out the "hybrid OS" escape-hatch wave + two polish bugs:

- **OPEN_FILES action** — say "open files" / "show my files" / "open file manager" — thunar (or pcmanfm/nautilus) spawns floating 1200×800.
- **Ctrl+Alt+D** — same as above, keybind from anywhere in sway.
- **Ctrl+Alt+Esc** — "panic button" focus the chat from any workspace / any window. The user is never lost behind a chromium kiosk or a thunar window.
- **Timezone trailing affirmation** — "los angeles yeah", "tokyo please", "nyc thanks", "i'm in london yes" all parse cleanly now. Loop strips trailing affirmation/filler tokens (yeah, yes, please, thanks, correct, right, cool, bet, ok, okay) and retries the lookup.
- **Offer-flag boolean round-trip** — `parseTomlState` was reading bare TOML `true`/`false` as raw strings, then `serializeCalibrationToml`'s `typeof === "boolean"` filter dropped them. Fixed: parser now coerces `true|false` → boolean and `-?\d+` → number, with the legacy string fallback last. `wifi_offer_accepted` and `claude_offer_accepted` now persist correctly through calibration.toml.

v16 also still shipping:
- **OPEN_TERMINAL** + alacritty + Ctrl+Alt+T
- **INSTALL_PACKAGE** (multi-turn apt with confirmation + progress streaming + curated DE/dev metapackage groups)
- **Chromium "invisible blocker" fix** — Wayland-Ozone surface acquire + floating 1280×720 instead of kiosk fullscreen

v16 is the **"agent can rice your Linux from chat"** wave:

- **OPEN_TERMINAL action** — say "open a terminal" or "give me a shell" and Eliza spawns alacritty (or foot/xterm fallback) as a floating 900×600 sway window. `Ctrl+Alt+T` is also a keybind. Full shell, full apt, full everything.
- **INSTALL_PACKAGE action** — say "install i3" or "give me gnome" and Eliza confirms ("Install gnome (~1.2 GB)? yes / no"), then runs `sudo apt-get install -y --no-install-recommends`, streams progress back to chat, returns a summary. Curated metapackage groups for i3 / sway / gnome / kde / xfce / vim / dev-essentials. Blocklist for foot-gun packages (openssh-server, sudo, etc.). Multi-turn flow.
- **Chromium "invisible blocker" fix** — kiosk fullscreen replaced with floating 1280×720 centered window. Wayland surface now acquires correctly via `--ozone-platform=wayland`. Chat box stays visible behind the OAuth window — no more "frozen-looking" moments.

The combination of OPEN_TERMINAL + INSTALL_PACKAGE means the agent can boot a vanilla Eliza-Chat-OS install and turn it into anyone's preferred Linux setup from chat: "give me a minimalist i3 setup with vim and tmux" → installs i3 + i3status + dmenu + vim + tmux + ~/.vimrc + ~/.tmux.conf → opens a terminal → done.

v15 closes the audit's "Eliza is everywhere" punch list: every visible turn from the dispatcher routes through `maybeRephrase` → `rephraseAsEliza` when the gate is on. That covers Action replies (since v11), flow continuations + bail-outs + chat-model errors (new in v15), and onboarding questions / completion message (also new — gated separately by `USBELIZA_LLM_ONBOARDING` with auto-on when Claude/Codex signed in). Six bug fixes landed in v15:

1. **Local Llama "No sequences left"** — `local-llama-plugin.ts` was leaking sequences (`createContext({sequences:1})` + never `dispose`). Fixed: `sequences:8` + `try/finally sequence.dispose()`.
2. **Chromium didn't spawn for LOGIN_CLAUDE / OPEN_URL** — `eliza-agent.service` was missing `WAYLAND_DISPLAY` / `XDG_RUNTIME_DIR` / `DISPLAY` so chromium silently exited. Three new `Environment=` lines.
3. **Timezone garbled** ("America/Los Angeles" → "america/lo_sangeles") — `parseTimezone` rewrote with a 6-step algorithm + 23 new test cases. Natural phrasings now map ("Los Angeles", "pacific time", "I'm in tokyo").
4. **Offer flags dropped on save** — `serializeCalibrationToml` now persists `wifi_offer_accepted` + `claude_offer_accepted`.
5. **Flow + bail-out + chat-error replies not LLM-rephrased** — new `maybeRephrase` helper at dispatch boundary.
6. **Onboarding questions felt scripted** — full state machine routes through rephrase when gated on.

Plus dev tooling:
- `scripts/run-vm.sh` — full-screen QEMU launcher (2560x1440 + audio + 8 GB)
- `scripts/dev-watch.sh` — inotify + rsync + service restart, ~2s feedback loop
- `scripts/snapshot-smoke.sh` — savevm/loadvm-based smoke, ~5s warm-boot
- `scripts/ai-monkey.sh` — real Claude probes the VM as a chaotic user, AI summary

v14 bumps the inner display from 1920x1080 to **2560x1440** so the chat box fills modern laptop screens instead of looking like a small box. Ships `scripts/run-vm.sh` — a one-shot QEMU launcher that opens full-screen on the primary monitor with audio + 8 GB RAM + 6 cores by default. Sway's `output * resolution 2560x1440 scale 1` is pinned in `/etc/sway/config` so virtio-vga lands on the right canvas immediately. Justfile's chroot-cache mirror was widened to the full `includes.chroot_after_packages/` tree (was just `/opt/usbeliza/`) so edits to sway/systemd/GRUB land in the next build's squashfs. v13 builds on v11's LLM-rephrase + v10's dream-world surface with three product fixes the broader smoke caught:

1. **URL pre-match in dispatch** — any message containing `http(s)://` routes straight to OPEN_URL, beating the simile matcher (`agent/src/runtime/dispatch.ts`).
2. **LOGIN_CLAUDE/CODEX return-early** — the chat now replies "I've opened the sign-in page" within ~1s instead of blocking for up to 5 min waiting on OAuth token detection. Background poll continues + writes the marker file when the user finishes.
3. **NETWORK_STATUS + DOWNLOAD_MODEL simile coverage** — natural phrasings (`what's my network`, `is the network up`, `download llama`, `install llama`, etc.) now match.

Plus a **live-build chroot-cache trap fix** in the Justfile: after the first build, `lb`'s `--cache-stages "bootstrap chroot"` restores the chroot tarball wholesale and skips `chroot_local-includes`, silently freezing /opt/usbeliza at the first-build code. `iso-stage` now force-mirrors the staged tree into chroot/ whenever it exists.

Real `claude` CLI 2.1.138 + `codex` 0.130.0 ship in the chroot. Real `node-llama-cpp` + bundled Llama-3.2-1B GGUF runs in-process. Onboarding asks 10 questions, all 10 verified by the harness. Multi-turn flows for wifi + LUKS. No Ollama daemon. No persistent topbar. Chat is the desktop.

**284 agent tests, 4 rust tests, 47/47 E2E probes — all green.** All work pushed to `origin/main`.

## v13 also addressed (still in v14)

| Surface | State |
|---|---|
| Boot chain | GRUB (themed, 2s auto-advance, orange splash) → Plymouth (orange Eliza wordmark + pulsing dot) → sway → elizad chat box |
| First-boot script | Eliza asks: name, then **offers Wi-Fi setup** (multi-turn picker), then **offers Claude/Codex auth** (browser OAuth via chromium), then 5 personality questions, then 3 system questions (keyboard / language / timezone). Local Llama-3.2-1B handles every turn before any cloud auth. |
| Action surface (chat verbs) | BUILD_APP, OPEN_APP, LIST_APPS, DELETE_APP, LIST_WIFI, CONNECT_WIFI, NETWORK_STATUS, LOGIN_CLAUDE, LOGIN_CODEX, OPEN_URL, LIST_MODELS, DOWNLOAD_MODEL, BATTERY_STATUS, CURRENT_TIME, SETUP_PERSISTENCE, SET_WALLPAPER, HELP |
| Reply phrasing (v11) | Every Action reply runs through `rephraseAsEliza()` → `runtime.useModel(TEXT_LARGE)` with the full Eliza system prompt + the action's structured data, so user-facing turns sound like Eliza. Default-on when Claude/Codex is signed in; falls back to the suggested preset on timeout/error. Toggle with `USBELIZA_LLM_REPLIES`. |
| Dream-world surface (v10) | `SET_WALLPAPER` (ImageMagick + `swaymsg output * bg`); manifest runtime enum extended to `webview / gtk4 / terminal / wallpaper / panel-{top,bottom,left,right} / dock / widget`; sway `for_window [app_id="^usbeliza\\.<runtime>\\..*"]` rules dock generated apps at the requested screen position. |
| Multi-turn flows | `connect to wifi` → list networks → pick → ask password → connect; `set up persistence` → confirm → passphrase → confirm passphrase → LUKS |
| Local inference | `node-llama-cpp@3.10.0` linking `libllama.so` in-process; Llama-3.2-1B Q4_K_M GGUF baked at `/usr/share/usbeliza/models/`. No Ollama daemon. |
| Cloud codegen | Real `claude` CLI 2.1.138 + `codex` CLI 0.130.0 bundled. LOGIN_CLAUDE opens chromium fullscreen for OAuth, polls token file at `~/.config/claude/.credentials.json`, kills the window when signed-in. |
| Cap-bus | Per-app sockets at `/run/eliza/cap-<slug>.sock`. v1 capability handlers: `time:read`, `storage:scoped`, `notifications:write`, `clipboard:read/write`, `network:fetch` (manifest-declared allowlist, 5 MiB body cap). |
| App lifecycle | Atomic-swap via `src.next/` + rolling `.history/v<N>/` (max 5 versions); 2-retry critique loop on failure; `rollbackTo()` for the version picker. `data/` never touched. |
| Persistence | LUKS on `sdX3` of the USB; setup walked through chat conversationally. `live-additional-software` is Phase 1.5. |
| Theme | Pure black `#0a0a0a` + warm orange `#FF6B35` accent. Same palette across Plymouth + GRUB + chat box + sway focused border + ANSI /etc/issue. No persistent UI chrome — chat is the desktop. |
| Tails-derived helpers | `third-party/tails/` (GPL-3.0): persistence.py, have-wifi, tails-unblock-network, tails-shell-library, htpdate, tails-get-network-time, tails-shutdown-on-media-removal.service, tails-block-device-info, tails-notify-user. Combined ISO license is GPL-3 per Tails' posture. |

## Autonomous test harness

`scripts/v9-smoke.sh` boots the latest ISO headless under QEMU/KVM with QMP + serial sockets, waits for SSH + `/api/status` ready, pre-seeds calibration so probes test the action surface directly, fires 12 chat probes, captures a screenshot at each step via QMP `screendump`, writes a markdown summary. Use it after every ISO build.

```
scripts/run-vm.sh                                        # full-screen 2560x1440 QEMU, audio + ssh forwarded
scripts/run-vm.sh --windowed                             # draggable GTK window if you prefer
just iso-build                                           # ~14 min full rebuild (fresh chroot); ~4 min incremental
scripts/v11-e2e.sh out/usbeliza-v14-final-amd64.iso      # ~3 min full E2E (47 probes)
scripts/v9-smoke.sh  out/usbeliza-v14-final-amd64.iso    # ~2 min legacy 12-probe smoke (still passes)
ls vm/snapshots/v11-e2e-*/summary.md                     # PASS/FAIL table
```

## What's still pending

- **#29** Bare-metal USB write + first boot on a real machine. `scripts/usb-write.sh <device>` (safety-guarded) is the next thing; user runs it once they have a USB stick handy.
- **#34** Model-picker UX in calibration flow. `LIST_MODELS` + `DOWNLOAD_MODEL` exist as separate chat actions; the calibration question "which model should I use?" would tie them into onboarding.
- Real Claude OAuth end-to-end in QEMU (needs a test Anthropic account).
- Voice input — waiting on Shaw's TTS model selection (Phase 1.5).
- ARM64 ISO (Phase 2; same `live-build` config, separate `--linux-flavours arm64`).
- Secure Boot shim signing (Phase 5; multi-month LF paperwork).
- ~~Push commits to origin/main~~ (done 2026-05-12; HEAD currently at the v13 wave).

## Repo state

```
out/usbeliza-v18-final-amd64.iso    # current shipping artifact (real Claude rephrase + codegen + apt + DE escape hatches)
out/usbeliza-v17-final-amd64.iso    # kept as fallback (OPEN_FILES + keybinds; preceded the real-Claude wave)
scripts/run-vm.sh                   # full-screen QEMU launcher (default: 2560x1440, 8 GB, 6 cores)
scripts/dev-watch.sh                # inotify + rsync + restart agent — ~2s edit-to-VM feedback loop
scripts/snapshot-smoke.sh           # savevm/loadvm-based smoke — ~5s warm-boot vs 90s cold
scripts/ai-monkey.sh                # real Claude exploration tester — finds edge cases regex probes miss
scripts/v11-e2e.sh                  # full E2E harness — 47 probes across 8 phases (deterministic)
scripts/v9-smoke.sh                 # legacy 12-probe smoke
scripts/v10-live-demo.md            # dream-world walkthrough for QEMU GUI test
scripts/usb-write.sh                # safety-guarded bare-metal writer
agent/                              # @elizaos/core AgentRuntime + 17 Actions + dispatch-llm rephrase + multi-turn flows
crates/elizad/                      # Tauri chat shell; topbar removed; orange/black palette
crates/eliza-cap-bus/               # JSON-RPC broker + 5 capability handlers
crates/eliza-sandbox/               # bubblewrap launcher + runtime app_id tagging for sway
crates/eliza-types/                 # Manifest/runtime schema (AppRuntime enum with 10 variants)
third-party/tails/                  # GPL-3.0 lifted code
PLAN.md                             # locked decisions + "dream world" section
AGENTS.md                           # operational SOP
```

## Test counts

- TypeScript / agent: **284 tests, 0 fail**
- Rust workspace: **4 unit tests, 0 fail** (cap-bus state)
- Live-USB E2E (against v15 ISO): **47/47 PASS** in 2m30s
  - Phase 0 onboarding state machine (12 probes — greeting + 10 question turns + calibration.toml on-disk verify)
  - Phase A status & system (7 probes — help, online, network paraphrase, list-models, battery, time, list-apps-empty)
  - Phase B dream-world surface (4 probes — 2 wallpaper actions + on-disk PNG verify each)
  - Phase C app lifecycle (9 probes — build, manifest verify, open, list, build second, delete, list-after, open-missing)
  - Phase D network + model picker (4 probes — list-wifi, network-status, network-paraphrase, download-model-already)
  - Phase E auth surface (3 probes — login-claude early-return, login-codex early-return, open-url)
  - Phase F multi-turn flows (5 probes — wifi-flow start, network-status follow-up, persistence flow + continue + bail)
  - Phase G chat fallthrough (1 probe — local-llama hello)
  - Phase H LLM-rephrase ON path (2 probes — help + time with fake claude auth marker)
