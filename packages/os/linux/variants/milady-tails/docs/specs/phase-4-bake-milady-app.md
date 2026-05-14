# Phase 4 — Bake the Milady Electrobun app into the ISO

Goal: `/opt/milady/` exists in the chroot and contains a runnable binary.
Paths are relative to `TAILS = packages/os/linux/variants/milady-tails/tails`.

## 1. The Milady Linux build — the real (fragile) sequence

A naive `bun run build:desktop` from the milady repo **fails**. The repo
ships in a hybrid state — corrupt committed `bun.lock`, `@elizaos/*`
pinned to a dead `beta` dist-tag, inconsistent `node_modules`. The
sequence that works (verified — run from `eliza-labs/milady/`):

```bash
# 1. install eliza/ workspace deps (works cleanly on its own)
bun install --cwd eliza --no-frozen-lockfile --ignore-scripts
# 2. relink all @elizaos/* into consistent local-source mode
MILADY_ELIZA_SOURCE=local node scripts/setup-upstreams.mjs
# 3. build a package setup-upstreams skips (its empty dist/ breaks the bundle)
( cd eliza/packages/electrobun-carrots && bun run build )
# 4. build the desktop app — MILADY_ELIZA_SOURCE=local is MANDATORY
MILADY_ELIZA_SOURCE=local bun run build:desktop
```

**Output** is a *directory tree*, not a tarball:
`eliza/packages/app-core/platforms/electrobun/build/dev-linux-x64/Milady-dev/`

```
Milady-dev/
  bin/        launcher (the entrypoint) + bun + 5× "bun Helper*" + CEF libs
              (libcef.so ~428 MB, libwebgpu_dawn.so, chrome-sandbox, …)
  Resources/  main.js, version.json, appIcon.png
    app/      brand-config.json, renderer/ (Vite bundle, ~106 MB),
              eliza-dist/ (~2.2 GB — runtime bundle: entry.js, node_modules, …)
  Milady.desktop, Info.plist
```

⚠ **Size**: the tree is **~2.5–2.9 GB uncompressed** — far larger than
PLAN.md's original "300–400 MB" estimate (that figure was the *compressed*
tarball of an older, smaller build). `Resources/app/eliza-dist/` alone is
~2.2 GB. This is the single biggest risk — see §5.

`Resources/version.json` is present (Electrobun's packager generates it
for the `dev` channel). For a true release artifact you'd run
`desktop-build.mjs package --env=stable` and let the release workflow
inject a `stable`-channel version.json.

## 2. The `9100-install-milady` chroot hook

**Path:** `TAILS/config/chroot_local-hooks/9100-install-milady`
(bare name, no `.hook.chroot` suffix — matches every existing Tails hook
like `22-plymouth`. PLAN.md's `9100-install-milady.hook.chroot` name is
imprecise; live-build accepts both.)

Conventions from existing hooks: `#!/bin/sh`, `set -eu`, `echo` progress
line, operate on absolute chroot paths, fail loud on missing input.

Steps:
1. `echo "Installing Milady Electrobun app"`.
2. Verify the staged tree exists at `/usr/share/milady-tails/milady-app/` (placed there via `chroot_local-includes` — see §4). Guard: `[ -d "$STAGE" ] || { echo "..." >&2; exit 1; }`.
3. Install into `/opt/milady/`: `mkdir -p /opt/milady && cp -a "$STAGE"/. /opt/milady/` so `/opt/milady/bin/launcher` is the runnable binary. (Use `cp -a` of the whole tree — avoids per-file globbing; the tree has filenames with spaces, e.g. `bin/bun Helper`.)
4. Guard `version.json`: `[ -f /opt/milady/Resources/version.json ]` — write a minimal one if absent (defensive; the build normally produces it).
5. Ship the `.desktop` entry as a static `chroot_local-includes` file (cleaner than heredoc in the hook): `TAILS/config/chroot_local-includes/usr/share/applications/milady.desktop` with `Exec=/opt/milady/bin/launcher`, absolute `Icon=`, `StartupWMClass=Milady`. The hook just verifies it exists.
6. Permissions: `chmod 0755` the executables; **`chrome-sandbox`** needs `chown root:root && chmod 4755` (setuid) — or launch CEF with `--no-sandbox` if AppArmor blocks it (see §5).
7. **`rm -rf "$STAGE"`** — critical, or the ~2.9 GB tree exists *twice* in the chroot before squashfs.

The hook must NOT install runtime packages (that's `milady-runtime.list`), set up autostart (Phase 5), or touch `~/.eliza` (Phase 6).

## 3. `milady-runtime.list`

**Path:** `TAILS/config/chroot_local-packageslists/milady-runtime.list` —
plain text, one Debian package per line (live-build auto-includes all
`*.list` in that dir).

The runtime libs CEF/Chromium links against (derived from `ldd` of the
built `libcef.so` — **NOT** `libwebkit2gtk-4.1`; Electrobun bundles its
own CEF):

```
# X11 / display
libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3
libxrandr2 libxrender1 libxi6 libxres1 libxkbcommon0 libxau6 libxdmcp6
# GBM / DRM / Vulkan (GPU path)
libgbm1 libdrm2 libvulkan1 mesa-vulkan-drivers
# GTK / Cairo / Pango / fontconfig
libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libfontconfig1 libfreetype6
libharfbuzz0b libgraphite2-3 libthai0 libdatrie1 libfribidi0 libpixman-1-0
# ATK / at-spi (CEF hard-links these)
libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0
# NSS (Chromium crypto)
libnss3 libnspr4
# audio
libasound2
# misc
libcups2 libexpat1 libgnutls30
```

**Verify after the first ISO build**: `ldd /opt/milady/bin/cef/libcef.so`
inside the booted chroot, check for `not found`, add anything missing.

## 4. How the artifact gets into the build

**Recommended: a `just milady-app` Justfile recipe builds Milady on the
host, then stages the tree into `chroot_local-includes`.**

The recipe: run the §1 build sequence (resolving the milady repo root,
which is 5 levels up from the variant dir) → `cp -a`/`tar` the
`Milady-*/` tree into
`TAILS/config/chroot_local-includes/usr/share/milady-tails/milady-app/`.
live-build copies `chroot_local-includes/*` into the chroot verbatim; the
`9100` hook installs it.

The staging path is `.gitignore`'d — the ~2.9 GB tree must never be
committed. `just build`/`just binary` should depend on `just milady-app`
running first.

**Not** build-inside-the-chroot (bloats the chroot with bun/node toolchain,
slow), **not** commit-the-blob, **not** download-from-release (no Milady
Linux release published yet — that's a v1.1 reproducibility path).

## 5. Risks

1. **ISO size.** ~2.9 GB app tree + Tails (~1.3 GB squashfs) → the ISO
   could be **3–4 GB**. Mitigations: the `9100` hook *must* `rm -rf` the
   staging copy; investigate a slimmer build profile (trimming
   `eliza-dist/node_modules`); re-measure and write down the budget.
2. **`chrome-sandbox` setuid under Tails' AppArmor + read-only squashfs.**
   The most likely "boots but Milady window won't render" failure. Setuid
   bits survive squashfs, but AppArmor may confine the helper. Test in
   QEMU; have `--no-sandbox` ready as a documented fallback (injectable
   via Electrobun's chromiumFlags or a launcher wrapper).
3. **First-run network.** Electrobun's CEF is bundled — the *shell* needs
   no network. But the agent does (Claude sign-in, **local model
   download** — models are NOT in the app tree). Phase 4 success =
   "chat renders"; do not bake a multi-GB model into `/opt/milady`.
4. **Build fragility.** The §1 sequence must be encoded exactly in
   `just milady-app`; `setup-upstreams.mjs` has non-fatal optional-plugin
   failures (tolerated), and `MILADY_ELIZA_SOURCE=local` is mandatory.
5. **Brand env.** The recipe must use `bun run build:desktop` (sets
   `ELIZA_APP_NAME=Milady` etc.) so the tree is `Milady-*/`, not `Eliza-*/`.

## Ordered implementation checklist

1. Add the `just milady-app` recipe — the §1 build sequence + stage into `chroot_local-includes/usr/share/milady-tails/milady-app/`.
2. `.gitignore` that staging path (already done in the variant `.gitignore`).
3. Create `TAILS/config/chroot_local-packageslists/milady-runtime.list` (§3).
4. Create `TAILS/config/chroot_local-includes/usr/share/applications/milady.desktop`.
5. Create `TAILS/config/chroot_local-hooks/9100-install-milady` (§2).
6. Make `just build` / `just binary` depend on `just milady-app`.
7. `just build` → `just boot` → verify `/opt/milady/bin/launcher` exists, Milady appears in the apps menu, clicking it renders the chat UI.
8. `ldd` the installed `libcef.so` in the booted chroot; check `journalctl`/AppArmor for `DENIED` on the launcher + bun helpers; add missing packages.
9. Re-measure the ISO size; update PLAN.md's size figure + document the budget.
