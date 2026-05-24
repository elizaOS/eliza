# Phase 2 — Rebrand the greeter to elizaOS (system-level UI)

Phase 2 makes the Tails system *look* like elizaOS while every Tails
subsystem keeps working. It is **branding-only**: no behavior changes, no
Tor/AppArmor/persistence touches. All changes are additive overlays inside
the `tails/` tree. Paths below are relative to:

```
TAILS = packages/os/linux/variants/elizaos/tails
```

## Canonical elizaOS brand assets (current implementation)

The OS brand is elizaOS. System-level boot, greeter, wallpaper, About,
Persistent Storage, help, and identity strings must say elizaOS. Current
source paths:

| Asset | Source path |
|---|---|
| Official SVG logo sources | `assets/logo_white_bluebg.svg`, `assets/logo_blue_nobg.svg` |
| System SVG app icon | `TAILS/config/chroot_local-includes/usr/share/icons/hicolor/scalable/apps/elizaos.svg` |
| Pixmap SVG/PNG app icon | `TAILS/config/chroot_local-includes/usr/share/pixmaps/elizaos.svg`, `elizaos.png` |
| Generated boot icon | `TAILS/config/chroot_local-includes/usr/share/tails/bootx64.png` |
| Generated wallpaper/splash/greeter assets | `scripts/generate-elizaos-brand-assets.sh` outputs under `TAILS/config/*` |

**Current palette:** blue `#0B35F1`, white/soft grey surfaces, and black
text where needed for contrast. Avoid the earlier black/red/orange theme on
core visible surfaces.

Derived raster assets are generated from the official SVGs with ImageMagick
and committed under `TAILS/config/chroot_local-includes`.

## A. The elizaOS greeter

The greeter is a GTK3 Python app. Phase 2 retitles it, adds elizaOS logo
art, applies the Poppins/blue-white visual treatment, and routes help to
local elizaOS docs.

- **A1. Window/application title** — `TAILS/config/chroot_local-includes/usr/lib/python3/dist-packages/tailsgreeter/__init__.py` line 25: `APPLICATION_TITLE = "Welcome to Tails!"` → `"Welcome to elizaOS!"`. This one constant feeds every window-title surface.
- **A2. Header label** — `TAILS/config/chroot_local-includes/usr/share/tails/greeter/main.ui.in` line ~98 `label_header_title` → `Welcome to elizaOS!`. Edit the `.in` template, not the generated `main.ui`. Keep `translatable="yes"`.
- **A3. Header logo** — add a `GtkImage id="image_header_logo"` before the label in `box_header` in `main.ui.in`. New file: `TAILS/config/chroot_local-includes/usr/share/tails/greeter/icons/elizaos-logo.png` (~96–128px from `elizaos-icon.png`).
- **A4. Greeter CSS** — `TAILS/config/chroot_local-includes/usr/share/tails/greeter/greeter.css`: use Poppins and the blue/white/soft-grey elizaOS palette. Keep selectors GTK-compatible; `scripts/static-smoke.sh` parses this CSS to prevent the previous GTK `:root` regression.
- **A5. Greeter attribution** — keep Tails attribution in About/legal/CREDITS, not as the primary greeter product identity.
- **A6. `.desktop` entry** — `TAILS/config/chroot_local-includes/usr/share/applications/tails-greeter.desktop`: change `Name=` to `elizaOS Greeter` **only**. Do NOT change `Exec`, `X-GNOME-Provides=tails-greeter`, or the filename — they're wired into the GNOME session (`31-gdm-tails`).
- **A7. Greeter help** — route help links to `/usr/share/doc/elizaos/website/doc.en.html`; keep inherited filenames/module names only where required.

## B. Boot menu title "Tails" → "elizaOS"

Two bootloader paths, both must change:

- **B1. BIOS / isolinux** — `TAILS/config/binary_local-hooks/10-syslinux_customize`: the hook `sed`s the generated menu. Change the `menu label` substitutions: `s/menu label Live/menu label elizaOS ${TAILS_VERSION}/` and the `(failsafe)` → `(Troubleshooting Mode)` rule's `Tails` → `elizaOS`.
- **B2. UEFI / GRUB** — `TAILS/config/binary_local-includes/EFI/debian/grub.cfg`: rewrite the three `menuentry` title texts `'Tails ...'` → `'elizaOS ...'`. **Keep `--id 'live'`/`'livefailsafe'`/`'livenonremovable'`** (live-boot logic depends on them) and **keep the `TAILS_VERSION` placeholder token** (substituted by `50-grub-efi`).

## C. Plymouth boot theme → elizaOS wordmark

Tails uses the Plymouth `text` theme. Switch to a small elizaOS graphical theme:
1. New: `TAILS/config/chroot_local-includes/usr/share/plymouth/themes/elizaos/{elizaos.plymouth,elizaos.script,elizaos-wordmark.png}` (white wordmark on eliza blue, generated from the official elizaOS SVG assets).
2. Edit `TAILS/config/chroot_local-includes/usr/share/tails/build/plymouth-theme.diff` — patched value `Theme=text` → `Theme=elizaos`.
3. Edit `TAILS/config/chroot_local-hooks/22-plymouth` — after the `patch` line, add `plymouth-set-default-theme -R elizaos`.

## D. GNOME default GTK theme → light elizaOS

The current implementation uses Poppins and a light blue/white elizaOS look
rather than the earlier dark mock. Keep this aligned with
`scripts/generate-elizaos-brand-assets.sh`, `greeter.css`, and
`00_Tails_defaults`.

## E. Default wallpaper → elizaOS

Keep the paths, replace the bytes: overwrite `TAILS/config/chroot_local-includes/usr/share/tails/desktop_wallpaper.png` (elizaOS wallpaper derived from docs assets) and `.../screensaver_background.png` (darker variant). Leave the dconf `picture-uri` references unchanged; add `picture-uri-dark` pointing at the same file.

## F. `/etc/os-release` → elizaos-tails identifier

`/etc/os-release` is **generated** by `TAILS/auto/config` (a `cat >>` heredoc), not a static file. Edit the heredoc in `auto/config`: `NAME="elizaOS"`, `ID="elizaos-tails"`, `ID_LIKE="tails debian"` (keep `tails` internally — code/AppArmor may key off it), `PRETTY_NAME="elizaOS"`, `HOME_URL`/`SUPPORT_URL`/`BUG_REPORT_URL` → `https://elizaos.ai/`. **Keep all `TAILS_*` keys** (`TAILS_DISTRIBUTION`, `TAILS_GIT_COMMIT`, etc. — `tailslib.release` and inherited update plumbing depend on them).

## G. `/etc/issue` MOTD → elizaOS

Tails ships no custom `/etc/issue`. New file: `TAILS/config/chroot_local-includes/etc/issue` → `elizaOS \n \l`. Optionally `etc/issue.net` too. chroot_local-includes overlays override the `base-files` default; no hook needed.

## H. Tails credit — REQUIRED, three surfaces

- **H1. Greeter footer** — covered by §A5.
- **H2. About** — `TAILS/config/chroot_local-includes/usr/local/bin/tails-about`: set `program_name`/title to "elizaOS"/"About elizaOS" and swap the logo to an elizaOS asset. Keep upstream attribution in source/release notes, not as first-run product copy. `tails-about.desktop.in`: `Name=` → `About elizaOS`. Do NOT rename the `tails-about` binary or `.desktop` filename (the `54-menu` hook + `tailslib.release` depend on them).
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
5. GNOME light elizaOS theme: `00_Tails_defaults`, `gdm/dconf/50-tails`.
6. Wallpaper: overwrite `desktop_wallpaper.png` + `screensaver_background.png`; add `picture-uri-dark`.
7. `os-release`: the `auto/config` heredoc.
8. `/etc/issue` overlay.
9. Tails credit: `usr/share/doc/elizaos-tails/CREDITS`, `tails-about` + `.desktop.in`.
10. Verify the diff renames nothing on the DO-NOT-TOUCH list.
11. `just build` (or `just binary`) → `just boot`: elizaOS boot menu → elizaOS Plymouth → "Welcome to elizaOS!" greeter with logo + light Poppins theme → GNOME + elizaOS wallpaper; `cat /etc/os-release` / `/etc/issue` show elizaOS; `tails-about` shows the credit line. `just nspawn` pre-checks the non-GUI files in seconds.
