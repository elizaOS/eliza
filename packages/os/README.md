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
