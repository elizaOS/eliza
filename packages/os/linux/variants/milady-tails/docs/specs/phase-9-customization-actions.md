# Phase 9 — Customization chat actions

"Install i3", "switch to tiling", "swipe-down for notifications", "dark
theme" — all through chat, the bundled elizaOS app orchestrating Linux
underneath. Each action should live in the app/runtime packages that are
actually bundled into the ISO. **Persistence-aware**: customizations only
stick in persistent mode.

## Established pattern
An `Action` is `{ name, similes[], description, validate, handler,
examples }`. `validate` returns a bool from a text matcher; `handler`
calls `callback({ text, actions:[NAME] })` and returns `{ success, text,
data }`. System boundaries (spawn, apt) are injected via `options` so
tests don't shell out. Multi-turn work uses a flow + dispatcher route.
Actions register in the bundled runtime plugin/action registry.

## What already exists — do NOT duplicate
- **`SET_WALLPAPER`** (`actions/wallpaper.ts`) — THEME must not touch wallpaper.
- **`INSTALL_PACKAGE`** + `install-package-flow.ts` + `install-package-runner.ts`
  — chat-driven `apt-get install` *with a confirmation flow*, package-name
  validation, curated `PACKAGE_GROUPS` (`i3 desktop` → `[i3, i3status,
  i3lock, dmenu, xterm]`, etc.), `DANGEROUS_PACKAGES` blocklist. **This is
  the SHELL substrate** — it already does the apt install.
- **`OPEN_TERMINAL`** — the "drop me into a shell" escape hatch.
- **`SETUP_PERSISTENCE`** + `persistence-flow.ts` — Phase 9 actions *read*
  persistence state, they don't manage it.

So: **SHELL is a thin gating layer over the existing `INSTALL_PACKAGE`
substrate; SET_DESKTOP / THEME / NOTIFICATIONS are genuinely new actions.**

## Shared prerequisite: runtime customization helper
Exports `persistenceState(): "persistent" | "amnesia"` (reads a marker the
live system knows). Every Phase 9 handler calls it and appends a
persistence-aware sentence: persistent → "this'll stick after reboot";
amnesia → "heads up — resets to defaults next boot; say 'set up
persistence' to make it stick." Implements the PLAN "persistence-aware"
requirement once.

## Action 1 — SHELL (with polkit gating)
**File:** app/runtime action module for `SHELL`.
`validate` **defers to `INSTALL_PACKAGE`** when install intent is present
(returns false) so package installs keep going through the confirmation
flow; SHELL handles the *non-install* privileged commands ("update the
package list", "remove i3", "enable bluetooth service"). `validate`
matches a curated verb→command-template allowlist (not free-form shell —
charset-validated args, array-spawn, no shell metacharacters). `handler`
shells via an injectable `spawnFn`.

**Polkit gating — the load-bearing new system surface** (build-time
config in the variant's live-build overlay, NOT the agent):
- `TAILS/config/chroot_local-includes/etc/polkit-1/rules.d/org.milady.shell.rules`
  — grants the desktop user `Result.YES` for the relevant systemd /
  packagekit actions (pattern from Tails' `org.boum.tails.additional-software.rules`).
- `TAILS/config/chroot_local-includes/etc/generate-sudoers.d/milady-shell.toml`
  — a `[[commands]]` block (pattern from `tps.toml`) granting the desktop
  user `NOPASSWD` on `/usr/bin/apt-get` + a wrapper with a fixed arg
  allowlist. This makes the agent's existing `sudo apt-get` passwordless.

## Action 2 — SET_DESKTOP
**File:** app/runtime action module for `SET_DESKTOP`. similes
`switch to i3`, `use sway`, `tiling desktop`, etc. `validate` matches
verb + a known-WM token. **Composes** `INSTALL_PACKAGE`: if the WM's
packages aren't installed, hands off to `beginInstallPackageFlow()`, then
on the follow-up turn writes session config. System surface: writes
`~/.dmrc` / an AccountsService user-session key naming the `.desktop`
session file in `/usr/share/xsessions/` or `/usr/share/wayland-sessions/`
— additive, never modifies Tails' GDM hooks.

## Action 3 — THEME
**File:** app/runtime action module for `THEME`. similes `dark
theme`, `make it dark`, etc. Distinct from `SET_WALLPAPER` — THEME is GTK
theme + dotfiles, no image generation. `handler` writes `gsettings set
org.gnome.desktop.interface gtk-theme/color-scheme` and/or
`~/.config/gtk-{3,4}.0/settings.ini`. Curated theme set (ship
`Adwaita-dark` + the elizaOS-branded dark theme from Phase 2). Writes to
`~/.config/milady/` (already in Phase 7's persistence dir list).

## Action 4 — NOTIFICATIONS
**File:** app/runtime action module for `NOTIFICATIONS`. similes
`swipe down for notifications`, `android-style notifications`, `install
swaync`, etc. Like SET_DESKTOP, **composes** `install-package-flow` if
`swaync`/the GNOME shell extension isn't installed, then writes config
(`~/.config/swaync/config.json`, or `gnome-extensions enable`).

## Plugin registration
- Add all 4 to the bundled runtime action registry.
- SET_DESKTOP + NOTIFICATIONS reuse the existing `install-package-flow`
  for the multi-turn install handoff — no new flow files.
- Update `HELP_ACTION` reply text in `actions/system.ts`.

## Documentation
New file `variants/milady-tails/docs/customization-vocabulary.md` — the
full chat command set (every simile for the 4 actions, the WM/theme/
notification options) + the "amnesia vs persistent" note.

## Ordered implementation checklist
1. Runtime customization helper — `persistenceState()` + the reply helper.
2. The polkit `.rules` + sudoers `.toml` overlay files + the `milady-shell-runner` wrapper.
3. `actions/shell.ts` — defers to `INSTALL_PACKAGE` on install intent.
4. `actions/set-desktop.ts` — composes `install-package-flow`, writes `~/.dmrc` additively.
5. `actions/theme.ts` — GTK theme + `~/.config/gtk-*` / `~/.config/milady/`.
6. `actions/notifications.ts` — composes `install-package-flow`, writes notification config.
7. Register all 4 in `plugin.ts`; update `HELP_ACTION`.
8. Unit tests in the owning runtime package (inject fake `spawnFn`, assert no shell-out, assert persistence-aware reply branches).
9. Write `docs/customization-vocabulary.md`.
