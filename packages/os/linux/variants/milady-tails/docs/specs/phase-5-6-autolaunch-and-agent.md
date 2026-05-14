# Phases 5 & 6 — Auto-launch Milady + wire the agent

Phase 5 makes the Milady app launch as the desktop. Phase 6 wires its
agent / onboarding / local LLM. The **full Phase 6 porting checklist** is
in [`agent-portability-audit.md`](./agent-portability-audit.md) — this doc
is the integration design; that doc is the file-by-file change list.

Paths: `TAILS = packages/os/linux/variants/milady-tails/tails`.

## Context established by research

- **Tails uses GDM + a stock GNOME Wayland session.** The `tails-greeter`
  is a GDM greeter session; clicking "Start" auto-logs-in the `amnesia`
  user (uid 1000) into GNOME. `/etc/gdm3/PostLogin/Default` runs as root
  after login (locale, sudo, network unblock) — **do not modify it**.
- **Tails' GNOME honors `/etc/xdg/autostart/`** (proof:
  `systemd-desktop-target.desktop` lives there). So an autostart entry is
  the correct, minimal mechanism — no GDM patching.
- **Tails already ships** `no-overview@fthx`, `disable-log-out`,
  `disable-user-switching` in its dconf — much of "GNOME shell defaults"
  is done; milady-tails only rebrands and confirms.
- **usbeliza's session layer is NOT reusable** (sway + `elizad` Tauri
  shell, different user). What IS reusable: the entire `agent/` tree.

## PHASE 5 — Auto-launch Milady on greeter exit

Mechanism: the Milady Electrobun app is an XDG autostart entry for the
`amnesia` GNOME session. greeter → GDM → `PostLogin/Default` → GNOME →
`gnome-session` reads `/etc/xdg/autostart/*.desktop` → launches Milady.

Files to add (under `TAILS/config/chroot_local-includes/`):

1. **`etc/xdg/autostart/milady.desktop`** — the autostart entry. `Exec`
   points at the Phase-4 binary (`/opt/milady/bin/launcher`), `X-GNOME-Autostart-Phase=Applications`,
   `NoDisplay=true`, and the `Exec` env pins `ELIZA_STATE_DIR=/home/amnesia/.eliza`
   so all components + Phase 7 persistence agree on one state root.
2. **`etc/dconf/db/local.d/00_Milady_defaults`** — sibling to Tails'
   `00_Tails_defaults` (sorts after, Milady keys win): `color-scheme='prefer-dark'`,
   `gtk-theme='Adwaita-dark'`, wallpaper `picture-uri`/`picture-uri-dark`,
   `welcome-dialog-last-shown-version='99.0'` (disables the GNOME intro).
   **Do NOT redefine `enabled-extensions`** — Tails ships `no-overview@fthx`
   in it; redefining clobbers Tails' list.
3. **chroot hook** (e.g. `99-milady-desktop`) — runs `dconf update` so the
   new db file compiles in; `chmod +x` the app binary if needed.

Fullscreen: the Milady Electrobun app should self-fullscreen on launch
(its own window config) — GNOME has no sway-style `fullscreen enable`
config knob.

Conflict callouts: Tails locks `disable-log-out`/`disable-user-switching`
(fine — Milady needs neither); `usb-protection=lockscreen` is fine (the
persistence USB is the *boot* device, already trusted). Don't touch
`/etc/gdm3/PostLogin/Default`.

## PHASE 6 — Wire Milady's onboarding + agent

### Reusable verbatim from usbeliza's `agent/` tree
- **Onboarding** — `agent/src/onboarding/{state,questions,dispatcher}.ts`:
  the v36 **3-question** flow (`name` → `claudeOfferAccepted` → `buildIntent`).
  State → `~/.eliza/onboarding.toml`; completion writes `calibration.toml`.
- **Chat entry** — `agent/src/chat.ts`: `handleOnboarding()` runs first;
  empty first message = "first window open" trigger.
- **Actions** — `runtime/actions/build-app.ts` (`BUILD_APP`), `open-app.ts`
  (`OPEN_APP`), `runtime/local-llama-plugin.ts` (GGUF inference + GPU),
  `runtime/flows/claude-flow.ts` (the v36 paste-code OAuth flow).
- **Runtime** — `runtime/eliza.ts` (direct `AgentRuntime` construction).

### What's milady-tails-specific
This is **a real refactor, not a quick edit** — see the portability
audit. The headline:

1. **Agent host model** — *recommended (A): the Electrobun Milady app
   hosts the agent in-process.* It runs inside the GNOME session and
   inherits `WAYLAND_DISPLAY`/`XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`.
   This matches "the desktop IS the Milady app" and **invalidates the
   "agent is detached under systemd, must rediscover the compositor"
   premise** behind all of usbeliza's sway socket-globbing — so most of
   it *simplifies* rather than needing GNOME reimplementation.
2. **`OPEN_APP` GNOME delta** — `agent/src/runtime/actions/open-app.ts`
   hardcodes `swaymsg exec`. The one real *code* change: spawn the
   Chromium app-mode window directly (`chromium --app=… --ozone-platform=wayland`)
   or via Electrobun's native child-window API. The `swayEnv()` sock-glob
   is dead under GNOME.
3. **State dir** — set `ELIZA_STATE_DIR=/home/amnesia/.eliza` in the
   `milady.desktop` launch env so onboarding/calibration/apps share one
   root Phase 7 can bind-mount.

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
**Phase 5:** confirm Phase 4's binary path → add `etc/xdg/autostart/milady.desktop` (with `ELIZA_STATE_DIR` in `Exec`) → add `etc/dconf/db/local.d/00_Milady_defaults` → add/extend the chroot hook to run `dconf update` → `just boot`: greeter → Start → GNOME → Milady window, dark-themed.
**Phase 6:** apply the portability audit's must-fix categories → confirm the in-process agent host model → resolve the `open-app.ts` de-sway → bake the GGUF + GPU-enabled node-llama-cpp → QEMU verification matrix above.
