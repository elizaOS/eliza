# @elizaos/os

Linux disk images, Android vendor overlays, and desktop USB/device installers.
Application and native-runtime sources belong to `packages/app` and its plugins.
Builders use the enclosing Eliza checkout, or `ELIZAOS_ELIZA_ROOT` when explicitly
set. Standalone OS checkouts use `.eliza-source` by default.

Install workspace dependencies with Bun 1.3.14 at the repository root. Use Node
24.15.0 for scripts. From the repository root:

```bash
bun run --cwd packages/os build                 # installer web frontends only
bun run --cwd packages/os verify                # installer and release checks
bun run --cwd packages/os verify:linux          # Linux configuration checks
make -C packages/os/linux/elizaos build ARCH=amd64 PROFILE=gui
make -C packages/os/android bootstrap AOSP_ROOT=/path/to/aosp
make -C packages/os/android build ARCH=x86_64 AOSP_ROOT=/path/to/aosp
```

OS image builds are separate from the installer frontend build. See
[Linux](linux/README.md), [Android](android/README.md), and the
[USB installer](usb-installer/README.md) for their entrypoints.

The Linux tree currently retains both mkosi and older live-build paths; mkosi is
the persistent workstation image. Release builds require signed desktop artifacts
and the control-broker inputs checked by `mkosi.postinst.chroot`. Those inputs are
not supplied by a frontend build. A successful configuration or planner test does
not demonstrate boot, persistence, or installation onto an internal disk.

Assemble the complete built GN browser dependency closure into a **new**
`$STAGE/browser` before the existing desktop archive producer signs `$STAGE`:

```bash
python3 packages/os/scripts/linux/assemble-browser-payload.py \
  --build-root "$LINUX_BUILD" --runtime-deps "$LINUX_RUNTIME_DEPS" \
  --component "$LINUX_COMPONENT_ASSETS" --overlay "$LINUX_COMPONENT_OVERLAY" \
  --node-archive "$NODE_ARCHIVE" \
  --native-host packages/browser-bridge-extension/scripts/native-host.mjs \
  --source-commit "$SOURCE_COMMIT" --architecture x86_64 \
  --chromium-revision "$CHROMIUM_REVISION" --chromium-version "$CHROMIUM_VERSION" \
  --output "$STAGE/browser"
node packages/app/scripts/package-linux-gtk-artifact.mjs produce \
  --stage="$STAGE" --out="$ARTIFACT_OUT" --key="$DESKTOP_SIGNING_KEY" \
  --version="$VERSION" --arch=x86_64 --source-commit="$SOURCE_COMMIT"
```

Use `gn desc "$LINUX_BUILD" //chrome:chrome runtime_deps --format=json` for the
closure. The assembler requires every declared file, generated GRIT header,
reviewed Linux overlay, and pinned official Node 24.15.0 archive; it neither
fetches inputs nor qualifies runtime behavior. Escaping dependencies and empty required assets fail explicitly. Empty non-executable
generated stamps and Python package markers remain in the hashed closure. Run its isolated tests
with `python3 packages/os/scripts/linux/test_assemble_browser_payload.py`.
