# Flatpak packaging status

The canonical desktop release workflow packages the already-built and tested
Electrobun Linux tree with
`packages/app-core/scripts/package-electrobun-flatpak.mjs`. The resulting
side-loadable `.flatpak` contains the same desktop runtime revision as the
AppImage, Debian, and RPM artifacts. It is installed and held through a
45-second launch-liveness check before release artifacts are uploaded.

On Linux, run the Electrobun build first and then use:

```bash
bun run --cwd packages/app-core build:flatpak:direct
```

The package is written under
`packages/app-core/platforms/electrobun/artifacts/`.

## Linux sandbox contract

The direct Electrobun Linux artifacts and the Flatpak do not provide the same
isolation boundary:

- Electrobun `1.18.1` hard-codes CEF `no_sandbox` and appends
  `--no-sandbox` plus `--disable-gpu-sandbox` in its Linux native wrapper.
  The packaged `chrome-sandbox` helper therefore does not establish Chromium
  process isolation. See the pinned upstream
  [native wrapper](https://github.com/blackboardsh/electrobun/blob/v1.18.1/package/src/native/linux/nativeWrapper.cpp#L772-L781)
  and [CEF initialization](https://github.com/blackboardsh/electrobun/blob/v1.18.1/package/src/native/linux/nativeWrapper.cpp#L2308-L2314).
- `.AppImage`, `.deb`, `.rpm`, and unpacked Electrobun trees must not be called
  production-renderer-sandboxed. A real `bundleCEF: false` rebuild using the
  GTK/WebKit wrapper is the only acceptable way to evaluate a CEF-free direct
  artifact; editing packaged metadata does not change the selected wrapper.
- The Flatpak adds an independently enforced bubblewrap boundary around the
  whole application. This is an **outer Flatpak sandbox**, not a Chromium
  renderer sandbox and not defense in depth between compromised renderer and
  main process.

`linux-distribution-contract.mjs` rejects a stronger renderer-sandbox claim,
group/world-writable or escaping build entries, unknown changes in the pinned
CEF posture, and every Flatpak grant outside this exact allowlist:

```text
share:   network, ipc
socket:  wayland, fallback-x11, pulseaudio
device:  dri
command: eliza
```

It also verifies the finalized Flatpak metadata after `flatpak build-finish`,
so changing the requested arguments without changing the resulting metadata
cannot create a false pass. Run the static contract against the newest Linux
tree with:

```bash
bun run --cwd packages/app-core verify:linux-distribution
```

## GNU libc compatibility contract

Every installable Linux package now has a fail-closed GNU libc audit before
the first staging copy is made. The audit identifies ELF files by their magic
bytes, not their filenames, and runs `readelf -W --version-info` over every
one. That includes extensionless executables, native `.node` modules, and all
lazy-loaded local-inference `.so` files nested under `Resources`. Musl and
static ELF alternatives are still inspected; an ELF with no GLIBC version
requirements does not raise the GNU libc floor. Private or named GLIBC ABI
requirements fail closed.

The maximum accepted requirement is `GLIBC_2.38`. This ceiling comes from the
pinned Electrobun `1.18.1` Linux native wrapper, which already requires
`GLIBC_2.38`; it is the existing unavoidable direct-package floor, not a new
distro-support promise. Raising it in a fused or lazy-loaded library would make
parts of an otherwise launchable application fail only when that feature is
loaded. Lowering it below `2.38` requires rebuilding and qualifying the pinned
native wrapper as well as the fused libraries.

Both distribution entry points enforce the same complete-tree audit:

```bash
node packages/app-core/scripts/package-electrobun-linux.mjs \
  --build-dir=packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev
node packages/app-core/scripts/package-electrobun-flatpak.mjs \
  --build-dir=packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev
```

The contract is only an ELF ABI ceiling. It does not by itself qualify Ubuntu,
Debian, Fedora, or any other distribution: system WebKitGTK/GTK dependencies,
the selected Flatpak runtime, architecture, installation, and runtime behavior
must still be tested. In particular, do not claim Ubuntu 22.04 compatibility;
its libc predates the pinned wrapper's floor. Ubuntu 24.04 or a newer libc is
also not a completed compatibility claim without the remaining dependency and
runtime evidence.

The current release workflow still builds Linux inputs on the moving
`ubuntu-latest` runner label. Packaging will now reject an output that exceeds
the ceiling, but that runner label is not a reproducible builder contract. The
remaining production gate is to rebuild the full native and fused closure in a
pinned, immutable Linux builder whose libc is no newer than `2.38`, then run
this audit on the exact staged tree and exercise the resulting installers and
Flatpak. Do not use symbol-string editing, binary patching, or exclusions for
inference libraries to manufacture a pass.

### Runtime refs and disk preflight

The release default remains `org.gnome.Platform//49` with
`org.gnome.Sdk//49`. Reproducible local compatibility checks may supply full
refs explicitly; both refs must match the requested architecture:

```bash
node packages/app-core/scripts/package-electrobun-flatpak.mjs \
  --build-dir=packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev \
  --arch=x86_64 \
  --runtime-ref=org.gnome.Platform/x86_64/50 \
  --sdk-ref=org.freedesktop.Sdk/x86_64/25.08
```

Packaging intentionally refuses to start unless both the artifact/output
filesystem and the staging filesystem have free space equal to three
dereferenced allocated build copies plus a 1 GiB reserve. This covers the
independent staging tree, OSTree export, and final bundle without hard-linking
or mutating the tested source artifact.

On the 2026-08-22 Linux parity checkout, the tested tree measured
3,312,885,760 dereferenced allocated bytes (2,960,449,536 bytes from `du`
before dereferencing the five CEF library symlinks). The gate therefore
required 11,012,399,104 free bytes. The output filesystem had only
7,876,071,424 free bytes, so packaging stopped before a complete Flatpak could
be produced. A local Flatpak install, permission inspection, and 45-second
installed launch are consequently still unverified for that checkout. After
freeing space, run the command above, then exercise the same install lane used
by CI:

```bash
bundle=packages/app-core/platforms/electrobun/artifacts/Eliza-2.0.3-beta.7-linux-x86_64.flatpak
flatpak install --user --noninteractive -y --reinstall "$bundle"
flatpak info --user --show-permissions ai.elizaos.app
timeout 45s xvfb-run --auto-servernum \
  --server-args="-screen 0 1280x900x24 -nolisten tcp" \
  flatpak run ai.elizaos.app
```

The expected `timeout` exit is `124`; any earlier exit fails the liveness
contract. The installed permission output must still match the allowlist
above.

## Flathub is not yet eligible

The YAML manifests in this directory are retained only as evidence of the
retired CLI-based experiment. They install the `elizaos` command-line package,
not the Electrobun desktop application. The store manifest also requires
network access while building. Do not submit either manifest to Flathub or
treat a successful build as desktop acceptance.

`bun run --cwd packages/app-core build:flatpak:store` deliberately fails
closed. Before enabling it, all of the following must be true:

1. A human maintainer has resolved Flathub's generative-AI submission policy
   for this repository and obtained any required exception.
2. The manifest builds the real Electrobun application and all dependencies
   offline from immutable, checksum-pinned sources.
3. The selected reverse-DNS app ID is controlled and verified by the publisher.
4. Current AppStream metadata, screenshots, permissions, and portal behavior
   pass Flathub review and the official linter.
5. A human authors and submits the Flathub application materials. Automation
   may test the repository artifact, but it must not generate or submit the
   application on that person's behalf.

The two retired manifests are:

- `ai.elizaos.App.store.yml`: locked-down CLI experiment; not Flathub-ready.
- `ai.elizaos.App.yml`: host-access CLI experiment; not intended for Flathub.
