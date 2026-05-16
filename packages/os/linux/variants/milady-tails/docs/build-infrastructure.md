# Build infrastructure — the containerized elizaOS Live build

elizaOS Live builds its ISO in a **plain Docker container**. Any host
with Docker — Linux, macOS, Windows/WSL2, CI — runs `just build` and
gets the same ISO. There is no Vagrant, no libvirt, no VM, and no
host-specific setup beyond Docker itself.

## Why not Tails' own build system

Tails upstream builds inside a Vagrant + libvirt VM (`rake build` drives
`vagrant up` → a `vmdb2`-built builder box → `lb config && lb build`
inside the VM). We tried that path first. It failed on a deep stack of
host-specific problems — builder-box interface naming on Trixie hosts,
missing `ifupdown`/`dhcp-client` in the minimal debootstrap variant, a
`vagrant-libvirt` IP-discovery race, and finally a host bridge↔dnsmasq
DHCP failure with no documented fix. After ~6.5 hours and five genuine
builder-box fixes, the conclusion was that **Vagrant is the wrong tool
for a multi-dev team** — a contributor on macOS, or a different Linux,
or CI, hits an entirely different set of host problems.

The containerized build eliminates all of it: no bridge, no dnsmasq, no
DHCP, no VM. The container *is* the build environment. The five
builder-box fixes became moot (they were fixing the VM, and there is no
VM) — but they were genuine Trixie-compat bugs, kept as commits on the
Tails source for a possible upstream MR.

## How it works

```
build.sh ──┬── docker build ──> elizaos-tails-builder image
           │     (Dockerfile: Debian Trixie + live-build deps +
           │      Tails' own live-build fork + apt-cacher-ng)
           │
           └── docker run --privileged ──> build-iso.sh (entrypoint)
                 │
                 ├── start apt-cacher-ng on 127.0.0.1:3142
                 ├── git checkout -- config/   (restore Tails tree)
                 ├── lb clean --purge
                 ├── lb config                (runs Tails' auto/config)
                 └── lb build                 (runs Tails' auto/build)
                       └── ISO ──> /out/
```

### The pieces

- **`Dockerfile`** — Debian Trixie (pinned by digest), the live-build
  runtime + Tails build-script dependency set (mirrors what Tails
  installs in its own builder box, minus the VM-orchestration layer),
  `ikiwiki` pinned from Debian forky (Tails' website build needs a
  newer ikiwiki than Trixie ships), and `apt-cacher-ng`. It bakes in
  **Tails' own live-build fork** (`submodules/live-build`) — modern
  Debian live-build rejects Tails' `lb config` arguments, so the fork
  is mandatory.
- **`build.sh`** — the one-command wrapper. Builds the image, ensures
  the apt-cacher-ng cache volume exists, runs the container with the
  Tails source bind-mounted at `/build` and `out/` at `/out`.
- **`build-iso.sh`** — the container entrypoint. Runs Tails' own
  `auto/config && auto/build` (via `lb config` / `lb build`) inside the
  mounted source. See "Why each step" below.
- **`acng.conf`** — apt-cacher-ng config inherited from the upstream live-build workflow.

### Why apt-cacher-ng is *required*, not just an optimization

A Tails chroot hook sets the chroot's `/etc/resolv.conf` to
`nameserver 127.0.0.1` — the final Tails system resolves DNS through a
local Tor resolver. At **build** time there is no Tor, so the chroot
cannot resolve hostnames. But later chroot hooks still run `apt-get
install` *inside* that chroot. apt-cacher-ng runs in the container
(where DNS works) and the chroot's apt reaches it **by IP**
(`127.0.0.1:3142`), sidestepping chroot DNS entirely. This is exactly
what Tails' own build VM does (`Rakefile`:
`INTERNAL_HTTP_PROXY = 'http://127.0.0.1:3142'`). As a bonus, the cache
(a Docker named volume) persists across builds, so rebuilds skip the
network.

### Why `git checkout -- config/` after `lb clean`

Tails' build mutates tracked files in `config/` and assumes a fresh
checkout every time (its CI clones anew; we build from a persistent
tree). `auto/clean` (invoked by `lb clean`) **deletes** tracked
package-list files it treats as disposable — `tails-installer.list`,
`tails-000-standard.list`, etc. — and `auto/config` rewrites
`config/chroot_sources/*.chroot` in place with dated snapshot-mirror
URLs. Left dirty, the next build's chroot is missing whole package sets
and gets a stale APT snapshot serial. Restoring `config/` to the
committed state before each build fixes both.

### The `.git` requirement

Tails' build assumes it runs inside a git checkout (`auto/config` calls
`git_current_commit` / `git_current_branch`, and our `config/` restore
uses `git checkout`). A real Tails clone has `.git`; the vendored
`tails/` tree shipped in this variant does not. `build-iso.sh` `git
init`s a throwaway repo when `.git` is absent, so the build works
identically whether built from a clone or the vendored copy.

## Usage

```
just config        # ~1 min go/no-go — does Tails' config tree process?
just build         # full clean ISO → out/  (~1–1.5 h cold, faster cached)
just build-fast    # same, low-compression squashfs (faster, larger ISO)
just build-cool    # low-CPU demo build; skips docs, caps Docker+squashfs to 2 CPUs
just build-demo    # fastest full demo build; skips bundled offline website/docs
just binary        # ~10 min incremental — squashfs + ISO only, reusing chroot/
just binary-cool   # low-CPU incremental rebuild
just nspawn        # seconds — boot the built chroot for non-GUI sanity checks
just boot          # boot the latest ISO in QEMU
just clean         # remove build artifacts
just cache-clean   # drop the apt-cacher-ng cache volume
```

`build.sh` also accepts Docker resource caps directly:

```
ELIZAOS_BUILD_CPUS=2 ./build.sh build
ELIZAOS_MKSQUASHFS_PROCESSORS=2 ./build.sh build
ELIZAOS_BUILD_CPUS=2 ELIZAOS_BUILD_MEMORY=8g ./build.sh binary
ELIZAOS_SKIP_WEBSITE=1 MT_FAST=1 ./build.sh build
```

The CPU cap is the safest knob when the same laptop is also running
Android Studio, Gradle, AOSP, or app builds. The squashfs processor cap
keeps the final compression step from spawning one worker per host CPU.
The memory cap is optional; set it only if the host needs a hard Docker
ceiling.

The three dev-loop speeds:
1. **App work** (the elizaOS desktop) — develop the app on your host
   with normal hot-reload. Never touches the ISO.
2. **OS-level config** (branding, hooks, units) — `just nspawn` boots
   the built `chroot/` in seconds for non-GUI sanity.
3. **Full integration test** — `just binary` (~10 min) for a fresh ISO
   reusing the chroot, or `just build` for a clean one.

## Tails Trixie-compat fixes

Getting the build to run cleanly surfaced **6 genuine latent bugs** in
Tails' `stable` branch, all exposed by a clean Trixie build. They live
as commits on the Tails source:

1–4. Builder-box fixes (interface naming, `ifupdown`, `isc-dhcp-client`,
`qemu-guest-agent`) — moot for the container build but real Trixie-compat
bugs in Tails' Vagrant builder box.
5. `domain.qemu_use_agent` in the Vagrantfile — same.
6. **`gdisk` + `mtools` restored to `tails-common.list`** — the
   `partitioning` initramfs hook `copy_exec`s `sgdisk` and `mlabel`, but
   a 2015 commit removed those packages on the theory that Tails
   Installer's `.deb` would pull them transitively. A clean build proves
   nothing pulls them anymore. This one is load-bearing — without it the
   build fails at the `22-plymouth` hook.

All 6 are upstream-worthy. Whether to file an MR with Tails is an open
question for v1.0.

## Known limitation: the `.img` step

`auto/build`'s final step, `create-usb-image-from-iso`, generates an
optional `.img` USB image and needs UDisks (a D-Bus daemon + GI
bindings) that the container doesn't carry. It runs *after* the `.iso`
is fully built. `build-iso.sh` treats a `lb build` failure with the
`.iso` present as success — the `.iso` is the deliverable and is fine
for QEMU testing and isohybrid USB writes. Generating the `.img`
properly (UDisks-in-container, or a separate step) is revisited if/when
Phase 10 bare-metal work needs it.
