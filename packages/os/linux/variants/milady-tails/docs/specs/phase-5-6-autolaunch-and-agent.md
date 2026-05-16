# Phases 5 & 6 — Auto-launch Milady + wire the agent

Phase 5 makes the elizaOS app launch as the desktop. Phase 6 wires its
agent / onboarding / local LLM. This doc is the integration design for
the Tails-based elizaOS Live variant.

Paths: `TAILS = packages/os/linux/variants/milady-tails/tails`.

Status as of 2026-05-16: Phase 5's OS-side launcher/supervisor overlay
exists in source and is part of the current rebuild/test pass. Phase 6
has the OS-side capability runner and launch env in place, but
approval-gated package/network actions and production package boundaries
are not release-complete.

## Context established by research

- **Tails uses GDM + a stock GNOME Wayland session.** The `tails-greeter`
  is a GDM greeter session; clicking "Start" auto-logs-in the `amnesia`
  user (uid 1000) into GNOME. `/etc/gdm3/PostLogin/Default` runs as root
  after login (locale, sudo, network unblock) — **do not modify it**.
- **Tails' GNOME honors `/etc/xdg/autostart/`** (proof:
  `systemd-desktop-target.desktop` lives there). For a production-feeling
  AI OS, autostart is only the session trigger; a root-owned systemd
  service is the supervisor that restarts Milady if it exits. No GDM
  patching.
- **Tails already ships** `no-overview@fthx`, `disable-log-out`,
  `disable-user-switching` in its dconf — much of "GNOME shell defaults"
  is done; elizaOS Live only rebrands and confirms.
- The removed root-level Linux prototype's session layer was not reusable
  here (sway + a custom shell, different user). elizaOS Live uses the
  GNOME session Tails already boots and starts the bundled app inside that
  session.

## PHASE 5 — Auto-launch Milady on greeter exit

Mechanism: a root-owned systemd path watches for the live user's session
bus, then starts a system service that runs Milady as `amnesia`. The XDG
autostart entry remains as a harmless session backup; `/usr/local/bin/milady`
uses a lock so the two paths cannot create duplicate app instances.

Files to add (under `TAILS/config/chroot_local-includes/`):

1. **`etc/systemd/system/milady.path`** — enabled from
   `multi-user.target`; starts `milady.service` when `/run/user/1000/bus`
   appears.
2. **`etc/systemd/system/milady.service`** — root-owned system service,
   `User=amnesia`, `Restart=always`, `ExecStart=/usr/local/lib/run-with-user-env /usr/local/bin/milady`.
   Normal `amnesia` can close the window, but the service relaunches it and
   the user cannot delete/disable this system unit without root.
3. **`usr/local/bin/milady`** — canonical wrapper; refuses root/non-amnesia,
   pins `ELIZA_STATE_DIR=/home/amnesia/.eliza` and XDG dirs, exports
   elizaOS mode/broker env, and holds a lock to prevent duplicate instances.
4. **`etc/xdg/autostart/milady.desktop`** — backup/session launch entry.
   It calls `/usr/local/bin/milady`, `X-GNOME-Autostart-Phase=Applications`,
   `NoDisplay=true`.
5. **`etc/dconf/db/local.d/00_Tails_defaults`** — currently patched in place
   for elizaOS wallpaper/favorites while preserving Tails' existing
   `enabled-extensions`. If this is split later into a sibling
   `00_Milady_defaults`, keep the same rule: do not clobber Tails'
   extension list.
6. **existing `20-dconf_update` chroot hook** — compiles the local dconf
   database.

Window model: Milady should be a normal, movable GNOME window. It is not
fullscreen, not a kiosk, and always-on because systemd supervises the
process, not because the desktop is blocked. Users can still use Tor
Browser, Files, Terminal, settings, and other Tails desktop tools.

Conflict callouts: Tails locks `disable-log-out`/`disable-user-switching`
(fine — Milady needs neither); `usb-protection=lockscreen` is fine (the
persistence USB is the *boot* device, already trusted). Don't touch
`/etc/gdm3/PostLogin/Default`.

## PHASE 6 — Wire Milady's onboarding + agent

### App/runtime responsibilities
- **Onboarding** — the bundled app should run the v36-style first-run
  flow and persist state under `~/.eliza` when Persistent Storage is
  unlocked.
- **Chat entry** — first window open should be enough to start onboarding
  or the signed-in home surface; it must not require a private model
  download before the UI appears.
- **Actions** — BUILD_APP, OPEN_APP, persistence/status, provider sign-in,
  and local-model setup should be routed through app/runtime packages that
  are actually bundled in the image.
- **Runtime** — embedded Bun/agent startup must be self-contained in the
  live image, not dependent on workspace dev dependencies outside the ISO.

### What's elizaOS Live-specific
This is **real integration work, not a quick edit**. The headline:

1. **Agent host model** — *recommended (A): the Electrobun Milady app
   hosts the agent in-process.* It runs inside the GNOME session and
   inherits `WAYLAND_DISPLAY`/`XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`.
   This matches "the desktop IS the Milady app" and **invalidates the
   "agent is detached under systemd, must rediscover the compositor"
   premise** behind older sway socket-globbing approaches — so most of it
   *simplifies* rather than needing GNOME reimplementation.
2. **`OPEN_APP` GNOME delta** — `agent/src/runtime/actions/open-app.ts`
   hardcodes `swaymsg exec`. The one real *code* change: spawn the
   Chromium app-mode window directly (`chromium --app=… --ozone-platform=wayland`)
   or via Electrobun's native child-window API. The `swayEnv()` sock-glob
   is dead under GNOME.
3. **State dir** — set `ELIZA_STATE_DIR=/home/amnesia/.eliza` in the
   `milady.desktop` launch env so onboarding/calibration/apps share one
   root Phase 7 can bind-mount.
4. **Capability runner** — `/usr/local/lib/elizaos/capability-runner`
   exists as a conservative first pass. It reports status/privacy/
   persistence, opens Tails Persistent Storage, and allows exact sudo for
   `root-status`; package install and network mutation intentionally refuse
   until approval-gated actions exist.

### `~/.eliza/` in amnesia vs persistent
- **Amnesia**: `/home/amnesia` is already on Tails' tmpfs/overlay union.
  `~/.eliza/` is created on first write, lives in RAM, wiped on poweroff.
  No-op — just verify it materializes.
- **Persistent**: Phase 7's `tps` `MiladyData` `Feature` bind-mounts the
  LUKS-backed dir over `/home/amnesia/.eliza` *before the session starts*.
  Phase 6's job: verify the agent tolerates `~/.eliza` being a bind-mount
  (it does — all path resolution goes through `$HOME`).

### Local LLM / GPU
Bake the GGUF to a milady path; the `milady.desktop` autostart sets
`LOCAL_LARGE_MODEL` — or the full Milady app uses `@elizaos/plugin-local-inference`
with its own Vulkan/CUDA profiles. The Phase-4 `milady-runtime.list`
already has `libvulkan1` + `mesa-vulkan-drivers`; bake the GPU-enabled
`node-llama-cpp` peer binary, not the CPU one.

### Must verify in QEMU (Phase 6 success criteria)
1. v36 3-question onboarding runs in chat after the greeter.
2. `~/.eliza/` works in amnesia (tmpfs) and persistent (LUKS bind-mount).
3. BUILD_APP — stub backend + Claude backend (v36 paste-code OAuth).
4. OPEN_APP opens a Chromium app-mode window (the de-sway path — the one
   code-delta verification).
5. Local LLM offloads to GPU on virtio-gpu + bare-metal NVIDIA/AMD.

### Known conflicts (documented, not blockers)
- Privacy Mode routes through Tor → Anthropic/OpenAI often block Tor exit
  IPs; local LLM is the always-works path.
- Electrobun's CEF Chromium doesn't inherit the SOCKS proxy → leaks past
  Tor in Privacy Mode (the known v1.0 gap — `docs/privacy-mode-v1-gap.md`).
- Milady must tolerate offline-first boot (it already does — "local-only
  mode" is a first-class milady deployment shape).

## Ordered implementation checklist
**Phase 5:** confirm Phase 4's binary path → add root-owned `milady.path`/`milady.service` supervisor → add `etc/xdg/autostart/milady.desktop` backup → add `/usr/local/bin/milady` wrapper → add/extend dconf defaults and hook → `just boot`: greeter → Start → GNOME → Milady window, dark-themed, normal desktop still usable, close/crash relaunches. The file overlay steps are done locally; the `just boot` validation is still pending.
**Phase 6:** apply the portability audit's must-fix categories → confirm the in-process agent host model → resolve the `open-app.ts` de-sway → bake the GGUF + GPU-enabled node-llama-cpp → QEMU verification matrix above.
