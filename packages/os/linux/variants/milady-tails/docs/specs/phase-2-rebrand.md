# Phase 2 — Rebrand the greeter to elizaOS (system-level UI)

Phase 2 makes the Tails system *look* like elizaOS while every Tails
subsystem keeps working. It is **branding-only**: no behavior changes, no
Tor/AppArmor/persistence touches, and no change to the later Milady app
payload. All changes are additive overlays inside the `tails/` tree. Paths
below are relative to:

```
TAILS = packages/os/linux/variants/milady-tails/tails
```

## Canonical elizaOS brand assets (real source paths)

The OS brand is elizaOS. The Milady app can still be baked in later, but
system-level boot, greeter, wallpaper, About, and identity strings must say
elizaOS. Real in-repo sources:

| Asset | Source path |
|---|---|
| elizaOS icon (1000×1000) | `packages/app/public/logos/elizaos-icon.png` |
| elizaOS docs wordmark | `packages/docs/logo/dark.png`, `packages/docs/logo/light.png` |
| elizaOS docs background | `packages/docs/images/eliza-og.png` |
| Package/home metadata | root `README.md`, `package.json`, native plugin podspecs |
| Dark palette tokens | `packages/ui/src/styles/base.css` (`.dark` block) |

**elizaOS dark palette:** bg `#050506` / `#0d0d10` / `#121214`, text
`#eaecef` (strong `#ffffff`, muted `#8a8a94`), border `#232329` /
`#313136`, **accent blue `#1238ff`** (hover `#3152ff`, fg `#ffffff`).

Derived raster assets (greeter logo, about logo, Plymouth wordmark,
wallpaper, screensaver bg) are generated from those sources with
ImageMagick and committed under `TAILS/config/chroot_local-includes`.

## A. The elizaOS greeter

The greeter is a GTK3 Python app. Its UI is text-title-only today — no
logo image, no footer — so Phase 2 both retitles and *adds* a logo + a
"powered by Tails" footer.

- **A1. Window/application title** — `TAILS/config/chroot_local-includes/usr/lib/python3/dist-packages/tailsgreeter/__init__.py` line 25: `APPLICATION_TITLE = "Welcome to Tails!"` → `"Welcome to elizaOS!"`. This one constant feeds every window-title surface.
- **A2. Header label** — `TAILS/config/chroot_local-includes/usr/share/tails/greeter/main.ui.in` line ~98 `label_header_title` → `Welcome to elizaOS!`. Edit the `.in` template, not the generated `main.ui`. Keep `translatable="yes"`.
- **A3. Header logo** — add a `GtkImage id="image_header_logo"` before the label in `box_header` in `main.ui.in`. New file: `TAILS/config/chroot_local-includes/usr/share/tails/greeter/icons/elizaos-logo.png` (~96–128px from `elizaos-icon.png`).
- **A4. Greeter CSS** — `TAILS/config/chroot_local-includes/usr/share/tails/greeter/greeter.css` (currently 3 lines): *extend* (don't replace) with elizaOS dark theming — dark window bg `#050506`/`#121214`, light text `#eaecef`, blue `#1238ff` on `.suggested-action` buttons. Keep selectors scoped to greeter widgets.
- **A5. Greeter footer — "powered by Tails" (REQUIRED credit)** — add a final `GtkBox` to `box_inner` in `main.ui.in` with a `translatable` "powered by Tails" label (dim/italic) and optionally an "about" link. Matches the `docs/user-experience.md` mock-up.
- **A6. `.desktop` entry** — `TAILS/config/chroot_local-includes/usr/share/applications/tails-greeter.desktop`: change `Name=` to `elizaOS Greeter` **only**. Do NOT change `Exec`, `X-GNOME-Provides=tails-greeter`, or the filename — they're wired into the GNOME session (`31-gdm-tails`).
- **A7. (Do NOT touch)** the help-doc URIs in `main_window.py` / `main.ui.in` point at `/usr/share/doc/tails/website/...` — leave as `tails`.

## B. Boot menu title "Tails" → "elizaOS"

Two bootloader paths, both must change:

- **B1. BIOS / isolinux** — `TAILS/config/binary_local-hooks/10-syslinux_customize`: the hook `sed`s the generated menu. Change the `menu label` substitutions: `s/menu label Live/menu label elizaOS ${TAILS_VERSION}/` and the `(failsafe)` → `(Troubleshooting Mode)` rule's `Tails` → `elizaOS`.
- **B2. UEFI / GRUB** — `TAILS/config/binary_local-includes/EFI/debian/grub.cfg`: rewrite the three `menuentry` title texts `'Tails ...'` → `'elizaOS ...'`. **Keep `--id 'live'`/`'livefailsafe'`/`'livenonremovable'`** (live-boot logic depends on them) and **keep the `TAILS_VERSION` placeholder token** (substituted by `50-grub-efi`).

## C. Plymouth boot theme → elizaOS wordmark

Tails uses the Plymouth `text` theme. Switch to a small elizaOS graphical theme:
1. New: `TAILS/config/chroot_local-includes/usr/share/plymouth/themes/elizaos/{elizaos.plymouth,elizaos.script,elizaos-wordmark.png}` (wordmark on `#050506`).
2. Edit `TAILS/config/chroot_local-includes/usr/share/tails/build/plymouth-theme.diff` — patched value `Theme=text` → `Theme=elizaos`.
3. Edit `TAILS/config/chroot_local-hooks/22-plymouth` — after the `patch` line, add `plymouth-set-default-theme -R elizaos`.

## D. GNOME default GTK theme → dark elizaOS

Tails sets no explicit GTK theme. Add to the existing `TAILS/config/chroot_local-includes/etc/dconf/db/local.d/00_Tails_defaults`, `[org/gnome/desktop/interface]` stanza: `color-scheme='prefer-dark'`, `gtk-theme='Adwaita-dark'`. Also add `color-scheme='prefer-dark'` to `TAILS/config/chroot_local-includes/usr/share/gdm/dconf/50-tails`. A full bespoke GTK theme is out of v1.0 scope — dark + the elizaOS accent satisfies "dark elizaOS theme".

## E. Default wallpaper → elizaOS

Keep the paths, replace the bytes: overwrite `TAILS/config/chroot_local-includes/usr/share/tails/desktop_wallpaper.png` (elizaOS wallpaper derived from docs assets) and `.../screensaver_background.png` (darker variant). Leave the dconf `picture-uri` references unchanged; add `picture-uri-dark` pointing at the same file.

## F. `/etc/os-release` → elizaos-tails identifier

`/etc/os-release` is **generated** by `TAILS/auto/config` (a `cat >>` heredoc), not a static file. Edit the heredoc in `auto/config`: `NAME="elizaOS"`, `ID="elizaos-tails"`, `ID_LIKE="tails debian"` (keep `tails` internally — code/AppArmor may key off it), `PRETTY_NAME="elizaOS"`, `HOME_URL` → `https://elizaos.ai/`. **Keep all `TAILS_*` keys** (`TAILS_DISTRIBUTION`, `TAILS_GIT_COMMIT`, etc. — `tailslib.release`, the IUK upgrade system depend on them) and keep the Tails `SUPPORT_URL`/`BUG_REPORT_URL` for v1.0 (they feed inherited tooling).

## G. `/etc/issue` MOTD → elizaOS

Tails ships no custom `/etc/issue`. New file: `TAILS/config/chroot_local-includes/etc/issue` → `elizaOS \n \l`. Optionally `etc/issue.net` too. chroot_local-includes overlays override the `base-files` default; no hook needed.

## H. Tails credit — REQUIRED, three surfaces

- **H1. Greeter footer** — covered by §A5.
- **H2. About** — `TAILS/config/chroot_local-includes/usr/local/bin/tails-about`: set `program_name`/title to "elizaOS"/"About elizaOS", swap the logo to an elizaOS asset, **add a credit line** via `set_comments()` / `add_credit_section("Based on", ["The Tails project - https://tails.net/"])`. `tails-about.desktop.in`: `Name=` → `About elizaOS`. Do NOT rename the `tails-about` binary or `.desktop` filename (the `54-menu` hook + `tailslib.release` depend on them).
- **H3. CREDITS file** — new file `TAILS/config/chroot_local-includes/usr/share/doc/elizaos-tails/CREDITS` (a *new* sibling dir — allowed; the constraint only forbids renaming the existing `usr/share/doc/tails/`).

## DO NOT TOUCH (constraints)

1. APT source files — `TAILS/config/chroot_sources/tails.chroot` (+ `.gpg`), `TAILS/auto/scripts/tails-custom-apt-sources` (`deb.tails.boum.org`). They resolve Tails' package repo + IUK.
2. `/usr/share/doc/tails/` and `/usr/share/doc/amnesia` paths — only *add* `usr/share/doc/elizaos-tails/`.
3. `TAILS_*` keys in `os-release`.
4. `tails-greeter` / `tails-about` component names, `X-GNOME-Provides`, `.desktop` filenames.
5. `--id` values in `grub.cfg`; the `TAILS_VERSION` placeholder token.
6. `module=Tails` kernel cmdline param + `live/Tails.module` — live-build's squashfs module selector, not branding.

## Ordered implementation checklist

1. Generate + commit the derived brand assets (greeter logo, about logo, Plymouth PNGs, wallpaper, screensaver bg).
2. Greeter: `tailsgreeter/__init__.py`, `main.ui.in` (header label + logo + footer), `greeter.css`, `tails-greeter.desktop`.
3. Boot menus: `10-syslinux_customize`, `grub.cfg`.
4. Plymouth: `elizaos` theme dir, `plymouth-theme.diff`, `22-plymouth` hook.
5. GNOME dark theme: `00_Tails_defaults`, `gdm/dconf/50-tails`.
6. Wallpaper: overwrite `desktop_wallpaper.png` + `screensaver_background.png`; add `picture-uri-dark`.
7. `os-release`: the `auto/config` heredoc.
8. `/etc/issue` overlay.
9. Tails credit: `usr/share/doc/elizaos-tails/CREDITS`, `tails-about` + `.desktop.in`.
10. Verify the diff renames nothing on the DO-NOT-TOUCH list.
11. `just build` (or `just binary`) → `just boot`: elizaOS boot menu → elizaOS Plymouth → "Welcome to elizaOS!" greeter with logo + dark theme + "powered by Tails" footer → dark GNOME + elizaOS wallpaper; `cat /etc/os-release` / `/etc/issue` show elizaOS; `tails-about` shows the credit line. `just nspawn` pre-checks the non-GUI files in seconds.
