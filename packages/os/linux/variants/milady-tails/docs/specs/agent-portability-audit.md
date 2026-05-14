# Agent-tree portability audit (Phase 6 porting checklist)

The shared agent tree at `packages/os/linux/agent/` was written for
**usbeliza** (sway + `elizad` Tauri shell + `eliza` user + `/home/eliza`
+ `~/.eliza` + a detached systemd `eliza-agent` service). milady-tails
runs **GNOME/Wayland + the Electrobun Milady app + the `amnesia` user
(uid 1000) + Tails-native paths**.

This audit is the exhaustive list of every usbeliza-specific assumption
that must change for Phase 6. The single highest-leverage realization:
**on milady-tails the agent is an in-session Electrobun child, not a
detached systemd service** — so most Category A sway code *simplifies*
(the agent already has `WAYLAND_DISPLAY` etc.) rather than needing a
GNOME reimplementation.

## Category A — Compositor (sway) assumptions — MUST-FIX

No `swaymsg`, no `sway-ipc.*.sock`, no `SWAYSOCK`, no `for_window` rules
under GNOME Mutter.

| File:line | Assumption | Fix direction |
|---|---|---|
| `runtime/actions/open-app.ts:18-31` | `swayEnv()` globs for `sway-ipc.*.sock`, sets `SWAYSOCK` | Drop — the in-session agent already has the env. |
| `runtime/actions/open-app.ts:70-96` | Spawns chromium via `swaymsg exec` | Spawn directly (Electrobun window / `gtk-launch` / `spawn(chromium)`). |
| `runtime/actions/open-app.ts:84,93` | Hardcoded `/usr/bin/chromium` + `--class=usbeliza.app.<slug>` | Drop the class-tag dependency. |
| `runtime/actions/wallpaper.ts:206-242` | `applyWallpaperViaSway()` runs `swaymsg output * bg` | Use `gsettings set org.gnome.desktop.background picture-uri`. |
| `runtime/actions/wallpaper.ts:24-25,277,296` | Reply text says "tells sway" | Reword for GNOME. |
| `runtime/actions/open-url.ts:29-34,114-132` | `--ozone-platform=wayland` + `--class=usbeliza.browser.*` sway float rule | Drop the class tag; reconsider separate-window vs in-Electrobun. |
| `runtime/actions/open-url.ts:64-90` | Probes only `chromium`/`chromium-browser` | Add `xdg-open` fallback; don't assume chromium. |
| `runtime/actions/open-terminal.ts:5-91,148-153` | `--class=usbeliza.terminal.*` sway rule; probes alacritty/foot/xterm | Probe `gnome-terminal` first; drop the class-tag rationale. |
| `runtime/actions/open-files.ts:5-31,142-148` | "floating sway window" copy; probes thunar/pcmanfm/nautilus | nautilus-first; reword copy. |
| `runtime/actions/login-claude.ts:67-73,229-301` | OAuth window via `usbeliza.browser.oauth-*` app_id | Inherits the open-url.ts fix. |
| `runtime/flows/claude-flow.ts:18-145` | OAuth chromium window pop/close, sway placement comments | Inherits open-url.ts fix. |
| `plugins/usbeliza-codegen/prompts.ts:56-82` | Codegen *system prompt* tells the LLM `panel-*` runtimes are "floated and pinned by sway" | Rewrite the runtime-field guidance for GNOME/Electrobun. |

## Category B — `USBELIZA_*` env var rename surface — MUST-FIX

The agent reads `USBELIZA_*` (sometimes `ELIZA_*` alias), never `MILADY_*`.
milady-tails' conventions are `MILADY_*` / `ELIZA_*` → `~/.eliza`. Decide
the canonical prefix project-wide; each of these needs an alias.

Load-bearing state-dir resolvers: `onboarding/state.ts:50`,
`runtime/flows/state.ts:49`, `runtime/actions/status.ts:44-45`,
`runtime/auth/state.ts:55-62`, `runtime/paths.ts:10-15`.

Other `USBELIZA_*` reads (review each): `main.ts:23-24`
(`USBELIZA_AGENT_PORT`), `network.ts:25`, `runtime/dispatch.ts:140` +
`dispatch-llm.ts:45-48`, `runtime/local-llama-plugin.ts:72,76`,
`runtime/eliza.ts:122`, `local-inference/catalog.ts:227-228`,
`runtime/flows/persistence-flow.ts:57`, `onboarding/dispatcher.ts` (×5),
`onboarding/state.ts:128`, `runtime/actions/wallpaper.ts:38,209`,
`runtime/actions/download-model.ts:77,85`, `runtime/actions/status.ts:35,42`,
`runtime/actions/install-package.ts:180`, `providers/ollama.ts:62,70`,
`providers/local-llama.ts:118-119`, `runtime/claude-cloud-plugin.ts:206`,
`plugins/usbeliza-codegen/actions/generate-app.ts` (×5).

## Category C — `/home/eliza`, `~/.eliza`, `eliza` user — MUST-FIX

`HOME` fallbacks default to `/home/eliza`; on milady-tails it's
`/home/amnesia`. The `.eliza` directory segment is hardcoded everywhere.

`/home/eliza` literal fallbacks: `download-model.ts:79,87`,
`local-llama-plugin.ts:82`, `login-claude.ts:131-133`.

`~/.eliza` segment hardcoded (defines where chat history / calibration /
auth / built apps / models land): `onboarding/state.ts:52`,
`runtime/flows/state.ts:51`, `runtime/auth/state.ts:62`,
`runtime/paths.ts:15`, `runtime/actions/status.ts:45`,
`runtime/actions/wallpaper.ts:41`, `runtime/actions/download-model.ts:80,88`,
`local-llama-plugin.ts:83`, `plugins/usbeliza-codegen/actions/generate-app.ts:73,92-93`.

usbeliza-prefixed system paths: `local-llama-plugin.ts:70-93`
(`/usr/share/usbeliza/models/…`), `runtime/eliza.ts:117,123`,
`providers/local-llama.ts:70,119` (`/opt/usbeliza/lib`),
`runtime/flows/persistence-flow.ts:57` (`/usr/local/bin/usbeliza-persistence-setup`).

Character: `characters/eliza.ts:44,51` (`username: "eliza"`,
`/run/eliza/cap-*.sock`), `plugins/usbeliza-codegen/prompts.ts:41`
(`/run/eliza/`). The `eliza-cap-bus` Rust crate is shared — confirm
`/run/eliza/` is intentionally shared before changing.

## Category D — Process / persistence-script assumptions — MUST-FIX

- `runtime/flows/persistence-flow.ts:20-110` — `DEFAULT_RUNNER` shells
  `/usr/local/bin/usbeliza-persistence-setup`. milady-tails uses Tails'
  native Persistent Storage (`tps`) — that script won't exist. Swap
  `DEFAULT_RUNNER` for a `tps` driver (or gate the flow). See
  [`phase-7-persistence.md`](./phase-7-persistence.md).
- `runtime/flows/install-package-flow.ts` + `install-package-runner.ts` —
  `sudo apt-get install`. Tails routes through Tor + has its own
  additional-software handling; Phase 9 adds polkit gating.
- `onboarding/apply-system.ts:21-130` — relies on
  `/etc/sudoers.d/usbeliza-localectl` (NOPASSWD for the `eliza` user).
  Won't exist; calibration apply silently degrades until an `amnesia`
  equivalent is added.
- `runtime/claude-cloud-plugin.ts` / `login-claude.ts` / codegen — probe
  `claude`/`codex` binaries; confirm the milady-tails ISO bakes them.
- Privacy-mode: the agent spawns `curl` / `fetch`s directly with no proxy
  handling — in Privacy Mode these must route through Tor's SOCKS proxy.

## Category E — systemd / session model — MUST-FIX

- `runtime/actions/wallpaper.ts:210-213` + `open-app.ts:12-16` — code
  *assumes* "eliza-agent runs from systemd, not the session, so
  `SWAYSOCK`/`WAYLAND_DISPLAY` aren't inherited". **False on milady-tails**
  — the Electrobun app hosts the agent in-session. This premise is the
  root of all Category A.
- `onboarding/apply-system.ts:9-14` — references the systemd unit
  `usbeliza-apply-calibration.service`. milady-tails has none; calibration
  re-apply should hang off the Phase 5 `/etc/xdg/autostart/` path.
- `main.ts` / `chat.ts` / `eliza.ts` comments assume the consumer is
  `elizad`'s Tauri shell. milady-tails' consumer is Electrobun. The HTTP
  wire shape is reusable; the empty-first-message onboarding trigger must
  be honored by Electrobun, and port `41337` (only `USBELIZA_AGENT_PORT`/
  `ELIZA_API_PORT` overrides) needs reconciling with milady's port system.

## Category F — Cosmetic / lower-priority

- `characters/eliza.ts:26-57` — the persona's `OS_CONTEXT_PREAMBLE` says
  "the chat box IS their desktop, there is no separate browser/file
  manager". On milady-tails the chat is an *app*; browser/files/terminal
  *are* separate. **Borderline must-fix** — it shapes every LLM reply.
- Reply/comment copy referencing `~/.eliza/apps`, "Phase 1.5", "Her-style
  desktop ricing" (`apps.ts`, `build-app.ts`, `system.ts`, `install-package.ts`).
- Naming: `usbelizaPlugin`, `USBELIZA_ACTIONS`, `usbeliza-codegen`,
  `agentId = stringToUuid("usbeliza-eliza-v1")` (**load-bearing** for
  memory-row identity — keep stable or namespace deliberately), plugin
  `name` fields, `[usbeliza]` log prefixes.
- All `tests/*.ts` reference `USBELIZA_*` — must move in lockstep with B.

## Summary — Phase 6 hard blockers

1. All of **Category A** — sway IPC + `swaymsg` + `for_window` class tags.
2. **Category B + C together** — decide `~/.eliza` vs `~/.milady` and the
   env prefix, then the ~25-file rename.
3. **Category D** — the `tps` persistence-script swap.
4. **Category E** — the in-session agent host model.

Should-fix-but-graceful-degrades: `apply-system.ts` sudoers, the
`/usr/share/usbeliza/` paths, the Privacy-Mode Tor proxy.
Cosmetic: Category F (the persona preamble borderline).
