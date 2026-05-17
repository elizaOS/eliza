#!/bin/bash
# Container entrypoint: run Tails' own build inside the mounted source.
#
# This is just `auto/config && auto/build` — the same steps Tails'
# Rakefile + Vagrant wrapper drives, minus the VM. The container IS
# the build environment.
#
# Env knobs (pass with `docker run -e`):
#   MT_STAGE   — "config" stops after `lb config` (go/no-go test);
#                "build" (default) does a full clean ISO build;
#                "binary" does an incremental rebuild — `lb binary`
#                against the existing chroot/, skipping debootstrap +
#                package install (the ~40-min part). Use it after
#                editing overlay files for a fresh ISO in ~10 min.
#   MT_FAST    — "1" builds the squashfs at low compression (fast, but
#                a bigger ISO). For dev iteration; release builds omit
#                it to get Tails' default max-compression squashfs.
#   ELIZAOS_BUILD_CPUS / ELIZAOS_MKSQUASHFS_PROCESSORS
#              — cap Docker CPU quota and mksquashfs worker count for
#                hot laptops / parallel Android or AOSP work.
#   ELIZAOS_SKIP_WEBSITE
#              — "1" installs a tiny local offline-docs placeholder
#                instead of rebuilding Tails' website.
#   TAILS_BUILD_OPTIONS — passed through to Tails' build (defaults to
#                "ignorechanges" since the mounted tree carries our
#                elizaOS overlay commits).
set -euo pipefail

STAGE="${MT_STAGE:-build}"
SRC=/build
OUT=/out
ACNG_PORT=3142
ACNG_URL="http://127.0.0.1:${ACNG_PORT}"
ACNG_PID=""
GENERATED_SUBMODULES=()
GENERATED_GIT=0
GENERATED_GIT_COMMITTED=0
BINARY_APT_HOOK_BACKUP=""
TAILS_WORKAROUNDS_URL="${TAILS_WORKAROUNDS_URL:-https://gitlab.tails.boum.org/tails/workarounds.git}"
TAILS_WORKAROUNDS_REF="${TAILS_WORKAROUNDS_REF:-6701bfe3c41f4a676262a00b0e79d480d403caa1}"
TAILS_TORBROWSER_LAUNCHER_URL="${TAILS_TORBROWSER_LAUNCHER_URL:-https://gitlab.tails.boum.org/tails/torbrowser-launcher.git}"
TAILS_TORBROWSER_LAUNCHER_REF="${TAILS_TORBROWSER_LAUNCHER_REF:-9d2ea22d21f653e29169bb68ad250c674f533042}"

cleanup() {
    if [ -n "${ACNG_PID}" ]; then
        kill "${ACNG_PID}" 2>/dev/null || true
    fi
    if [ -n "${BINARY_APT_HOOK_BACKUP}" ] && [ -e "${BINARY_APT_HOOK_BACKUP}" ]; then
        mv -f "${BINARY_APT_HOOK_BACKUP}" "${BINARY_APT_HOOK_BACKUP%.elizaos-binary-disabled}" 2>/dev/null || true
    fi
    for generated in "${GENERATED_SUBMODULES[@]}"; do
        rm -rf "${generated}"
    done
    if [ "${GENERATED_GIT}" = "1" ] && [ -d "${SRC}/.git" ]; then
        if [ "${GENERATED_GIT_COMMITTED}" = "1" ]; then
            git -C "${SRC}" checkout -- config/ po/*.po po/tails.pot 2>/dev/null || true
            rm -rf \
                "${SRC}/config/binary_debian-installer-includes" \
                "${SRC}/config/binary_debian-installer" \
                "${SRC}/config/binary_grub" \
                "${SRC}/config/binary_local-debs" \
                "${SRC}/config/binary_local-packageslists" \
                "${SRC}/config/binary_local-udebs" \
                "${SRC}/config/binary_syslinux" \
                "${SRC}/config/chroot_local-includes/etc/amnesia" \
                "${SRC}/config/chroot_local-includes/etc/os-release" \
                "${SRC}/config/chroot_local-includes/etc/tails" \
                "${SRC}/config/chroot_local-includes/tmp/submodules" \
                "${SRC}/config/chroot_sources/tails.chroot" \
                "${SRC}/config/includes" \
                "${SRC}/config/templates"
            rm -f \
                "${SRC}/config/chroot_local-includes/etc/apparmor.d/torbrowser.Browser.firefox"
            rm -rf \
                "${SRC}/config/chroot_local-includes/etc/apparmor.d/tunables/torbrowser"
        fi
        rm -rf "${SRC}/.git"
    fi
    rm -rf "${SRC}/tmp"
}

ensure_submodule_checkout() {
    local path="$1"
    local url="$2"
    local ref="$3"

    if [ -d "${path}" ] && find "${path}" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
        return
    fi

    echo "missing ${path} — fetching ${ref} from ${url}"
    rm -rf "${path}"
    mkdir -p "$(dirname "${path}")"
    git init -q "${path}"
    git -C "${path}" remote add origin "${url}"
    git -C "${path}" fetch --depth 1 origin "${ref}"
    git -C "${path}" checkout -q FETCH_HEAD
    GENERATED_SUBMODULES+=("${path}")
}

trap cleanup EXIT

echo "=== elizaOS Live containerized build ==="
echo "stage:   ${STAGE}"
echo "fast:    ${MT_FAST:-0}"
echo "source:  ${SRC}"
echo "output:  ${OUT}"
echo "lb:      $(command -v lb) ($(lb --version 2>&1 | head -1))"
echo

cd "${SRC}"

# The Tails source may be a real clone bind-mounted from the host — its
# files owned by the host uid while we run as root, so git's "dubious
# ownership" guard trips and auto/config silently gets empty git info.
# Mark it safe. Harmless for the throwaway-repo case below.
git config --global --add safe.directory "${SRC}"
git config --global --add safe.directory "${SRC}/submodules/live-build"

# Tails' build assumes it runs inside a git checkout: auto/config calls
# git_current_commit / git_current_branch, and our config/ restore (below)
# uses `git checkout`. A real Tails clone has .git; the vendored tails/
# tree shipped in this elizaOS Live variant does not. If git cannot see
# a worktree, make a throwaway repo — then both delivery shapes build
# identically. Use git itself for detection: submodules and linked
# worktrees commonly have a .git file, not a .git directory.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "no .git in source tree — initializing a throwaway repo for the build"
    GENERATED_GIT=1
    for generated in submodules/tails-workarounds submodules/torbrowser-launcher config/chroot_local-includes/tmp/submodules; do
        if [ -d "${generated}" ] && [ ! -e "${generated}/.keep" ]; then
            rm -rf "${generated}"
        fi
    done
    build_branch="$(head -n1 config/base_branch 2>/dev/null || echo stable)"
    git init -q -b "${build_branch}"
    git add -A
    git -c user.email='build@elizaos' -c user.name='elizaOS Live' \
        commit -q -m 'elizaOS Live build snapshot'
    GENERATED_GIT_COMMITTED=1
    # Tails' APT mirror helpers use release tags to decide whether a
    # changelog version has been published. A vendored source snapshot has
    # no tag history, so seed the previous release tag from debian/changelog.
    previous_release_tag="$(dpkg-parsechangelog --offset 1 --count 1 -SVersion | tr '~' '-')"
    if [ -n "${previous_release_tag}" ]; then
        git tag "${previous_release_tag}"
    fi
fi

# auto/config + auto/build want git metadata the Rakefile normally
# exports. With the repo guaranteed above, these are always available.
GIT_COMMIT="$(git rev-parse HEAD)"
GIT_REF="$(git symbolic-ref -q HEAD || echo refs/heads/stable)"
export GIT_COMMIT GIT_REF
export BASE_BRANCH_GIT_COMMIT="${GIT_COMMIT}"
echo "git: HEAD=${GIT_COMMIT} ref=${GIT_REF}"

# Tails' build refuses a dirty git tree unless told otherwise. In the
# container the mounted source may legitimately carry our elizaOS
# overlay commits — allow it.
export TAILS_BUILD_OPTIONS="${TAILS_BUILD_OPTIONS:-ignorechanges}"

# ── apt-cacher-ng: the chroot's apt proxy ────────────────────────────
# This proxy is REQUIRED, not just a speed-up. A Tails chroot hook sets
# the chroot's resolv.conf to "nameserver 127.0.0.1" (the final system
# resolves DNS through Tor). At build time there is no Tor, so the
# chroot cannot resolve hostnames — yet later hooks still run apt-get
# inside that chroot. Pointing apt at this proxy *by IP* sidesteps
# chroot DNS entirely: apt-cacher-ng runs here in the container, where
# DNS works, and does the real fetching. This is exactly what Tails'
# build VM does (Rakefile: INTERNAL_HTTP_PROXY = 'http://127.0.0.1:3142').
echo "=== starting apt-cacher-ng on ${ACNG_URL} ==="
/usr/sbin/apt-cacher-ng -c /etc/apt-cacher-ng ForeGround=1 &
ACNG_PID=$!
acng_up=false
for _ in {1..30}; do
    if curl -s -o /dev/null "${ACNG_URL}/"; then
        acng_up=true
        echo "apt-cacher-ng: up (pid ${ACNG_PID})"
        break
    fi
    sleep 1
done
if ! "${acng_up}"; then
    echo "ERROR: apt-cacher-ng never came up on ${ACNG_URL}" >&2
    exit 1
fi

# live-build, debootstrap and apt all honour http_proxy; live-build
# additionally writes it into the chroot's apt config (lb_chroot_apt),
# which is what makes apt work inside the DNS-less chroot. Tails' own
# build-tails wrapper does exactly this one line. TAILS_PROXY_TYPE is
# read by Tails hooks (e.g. 10-tbb) — "vmproxy" tells them the proxy is
# a local apt-cacher-ng that supports the /HTTPS/// remap.
export http_proxy="${ACNG_URL}"
export https_proxy="${ACNG_URL}"
export TAILS_PROXY="${ACNG_URL}"
export TAILS_PROXY_TYPE="vmproxy"
export TAILS_ACNG_PROXY="${ACNG_URL}"

# Tails' auto/build runs under `set -u` and references env vars that
# the Rakefile normally exports (EXPORTED_VARIABLES). Running it
# directly (no Rakefile) leaves them unset → "unbound variable" abort.
# Provide the rest with the same safe defaults an unconfigured Rakefile
# build would have. Empty = feature off; we want a plain online,
# disk-based build with no Jenkins and no website cache.
export JENKINS_URL="${JENKINS_URL:-}"
export APT_SNAPSHOTS_SERIALS="${APT_SNAPSHOTS_SERIALS:-}"
export TAILS_BUILD_FAILURE_RESCUE="${TAILS_BUILD_FAILURE_RESCUE:-}"
export TAILS_DATE_OFFSET="${TAILS_DATE_OFFSET:-}"
export TAILS_OFFLINE_MODE="${TAILS_OFFLINE_MODE:-}"
export TAILS_RAM_BUILD="${TAILS_RAM_BUILD:-}"
export TAILS_WEBSITE_CACHE="${TAILS_WEBSITE_CACHE:-no}"
export FEATURE_BRANCH_GIT_COMMIT="${FEATURE_BRANCH_GIT_COMMIT:-}"

# ── dev speed: squashfs compression ──────────────────────────────────
# auto/build does `: ${MKSQUASHFS_OPTIONS:='-comp zstd -Xcompression-level 22 ...'}`
# — it only fills in its max-compression default when this is unset/empty,
# so the non-fast path is simply to leave it alone. MT_FAST pre-sets a
# level-1 variant: much faster mksquashfs, larger ISO.
if [ "${MT_FAST:-}" = "1" ]; then
    export MKSQUASHFS_OPTIONS="-comp zstd -Xcompression-level 1 -b 1024K -no-exports"
    echo "MT_FAST=1: low-compression squashfs (faster build, larger ISO)"
fi
squashfs_processors="${ELIZAOS_MKSQUASHFS_PROCESSORS:-${ELIZAOS_BUILD_CPUS:-}}"
if [ "${STAGE}" = "binary" ] && [ -n "${squashfs_processors}" ]; then
    if [[ "${squashfs_processors}" =~ ^[0-9]+$ ]] && [ "${squashfs_processors}" -gt 0 ]; then
        MKSQUASHFS_OPTIONS="${MKSQUASHFS_OPTIONS:-} -processors ${squashfs_processors}"
        export MKSQUASHFS_OPTIONS
    else
        echo "W: ignoring non-integer ELIZAOS_MKSQUASHFS_PROCESSORS=${squashfs_processors}" >&2
    fi
fi

# Make Tails' helper scripts (apt-snapshots-serials, etc.) findable.
export PATH="${SRC}/auto/scripts:${SRC}/bin:${PATH}"

if [ "${STAGE}" = "build" ]; then
    ensure_submodule_checkout \
        submodules/tails-workarounds \
        "${TAILS_WORKAROUNDS_URL}" \
        "${TAILS_WORKAROUNDS_REF}"
    ensure_submodule_checkout \
        submodules/torbrowser-launcher \
        "${TAILS_TORBROWSER_LAUNCHER_URL}" \
        "${TAILS_TORBROWSER_LAUNCHER_REF}"
fi

# ── copy the finished ISO out ────────────────────────────────────────
copy_iso() {
    echo
    echo "=== copy ISO to ${OUT} ==="
    mkdir -p "${OUT}"
    local iso
    iso="$(find "${SRC}" -maxdepth 1 -name '*.iso' -print -quit)"
    if [ -n "${iso}" ]; then
        cp -v "${iso}" "${OUT}/"
        echo "ISO ready: ${OUT}/$(basename "${iso}")"
    else
        echo "ERROR: build finished but no .iso found in ${SRC}" >&2
        exit 1
    fi
}

restore_config_tree_if_requested() {
    if [ "${ELIZAOS_RESTORE_CONFIG:-0}" != "1" ]; then
        echo "=== skip git checkout -- config/ (set ELIZAOS_RESTORE_CONFIG=1 for a clean upstream reset) ==="
        return
    fi

    echo "=== restore config/ to committed state ==="
    git checkout -- config/
}

# ── STAGE=binary — incremental rebuild ───────────────────────────────
# Skip debootstrap + package install; rebuild only the squashfs + ISO
# from the chroot/ a previous full build left behind. For fast dev
# iteration after editing overlay files (rsync them into chroot/ first,
# or edit config/ and let lb binary pick them up).
if [ "${STAGE}" = "binary" ]; then
    if [ ! -d chroot ]; then
        echo "ERROR: STAGE=binary needs an existing chroot/ — run a full build first" >&2
        exit 1
    fi
    # Historically this restored config/ to a clean upstream state before
    # lb config. In this variant, config/ also carries the elizaOS overlay,
    # so doing that by default would destroy local branding/runtime edits.
    restore_config_tree_if_requested
    echo "=== lb config (refresh config tree) ==="
    lb config
    echo "=== clear stale binary-stage artifacts ==="
    rm -rf binary binary.iso binary.img binary.contents binary.files \
        binary.packages binary.tmp chroot.tmp .stage/binary*
    # lb binary may install small helper packages such as squashfs-tools in
    # the copied chroot. Tails' Additional Software apt hook logs under
    # /run/live-additional-software, which can be absent in a reused chroot.
    # In an incremental binary-only run, live-build skips the chroot mount
    # stages because the full build already completed them. The chroot is no
    # longer mounted, though, and Tails' apt hook still reads /proc/cmdline
    # during the small dependency install/remove that binary_rootfs performs.
    mkdir -p chroot/run/live-additional-software
    : > chroot/run/live-additional-software/log
    mkdir -p chroot/proc
    : > chroot/proc/cmdline
    # The final rootfs is the copied chroot/chroot. The outer chroot is only
    # live-build's build environment for mksquashfs, so disable Tails'
    # runtime Additional Software apt hooks there while binary_rootfs installs
    # and removes its helper dependency.
    binary_apt_hook="chroot/etc/apt/apt.conf.d/80tails-additional-software"
    BINARY_APT_HOOK_BACKUP="${binary_apt_hook}.elizaos-binary-disabled"
    if [ -e "${BINARY_APT_HOOK_BACKUP}" ] && [ ! -e "${binary_apt_hook}" ]; then
        mv -f "${BINARY_APT_HOOK_BACKUP}" "${binary_apt_hook}"
    fi
    if [ -f "${binary_apt_hook}" ]; then
        mv -f "${binary_apt_hook}" "${BINARY_APT_HOOK_BACKUP}"
    fi
    echo
    echo "=== lb binary (incremental — squashfs + ISO only) ==="
    lb_rc=0
    lb binary || lb_rc=$?
    if [ -e "${BINARY_APT_HOOK_BACKUP}" ]; then
        mv -f "${BINARY_APT_HOOK_BACKUP}" "${binary_apt_hook}"
    fi
    BINARY_APT_HOOK_BACKUP=""
    if [ "${lb_rc}" -ne 0 ]; then
        exit "${lb_rc}"
    fi
    copy_iso
    exit 0
fi

# ── STAGE=config / build — full pipeline ─────────────────────────────
# Start from a clean slate so every full build is reproducible and we
# never resume a half-built chroot. apt-cacher-ng keeps the re-download
# cheap, so a clean build is not a slow build.
echo "=== lb clean --purge ==="
lb clean --purge

# Optionally restore config/ to the committed state. Tails' build mutates
# tracked files in config/ and assumes a fresh checkout each time (its CI
# clones anew; we build from a persistent tree):
#   - auto/clean (invoked by `lb clean`) deletes tracked package-list
#     files it treats as disposable — tails-installer.list,
#     tails-000-standard.list, tails-iuk.list, whisperback.list, etc.
#     Left deleted, the next build's chroot is missing whole package sets
#     (this is what made gdisk/mtools — tails-installer's deps — vanish).
#   - auto/config rewrites config/chroot_sources/*.chroot in place with
#     dated snapshot-mirror URLs; left dirty, the regex won't re-match and
#     you silently get the previous run's stale APT snapshot serial.
#
# But config/ also contains elizaOS' local overlay. A blind checkout here
# is destructive while iterating on branding, services, and persistence.
restore_config_tree_if_requested

echo
echo "=== lb config ==="
# auto/config is run automatically by `lb config`
lb config

if [ "${STAGE}" = "config" ]; then
    echo
    echo "=== STAGE=config — stopping after lb config (go/no-go test) ==="
    echo "config tree:"
    ls -la config/ 2>/dev/null | head -20
    echo
    echo "lb config completed successfully."
    exit 0
fi

echo
echo "=== lb build (this is the long one — ~1-2h cold, faster cached) ==="
# auto/build's final step, create-usb-image-from-iso, builds an optional
# .img USB image — it needs UDisks (a D-Bus daemon + GI bindings) the
# container doesn't carry. Crucially it runs *after* the .iso is fully
# built and renamed. So a nonzero `lb build` with the .iso present means
# only that optional post-step failed; the .iso is the deliverable and is
# fine for QEMU testing and isohybrid USB writes. (Generating the .img is
# revisited if/when Phase 10 bare-metal work needs it.)
lb_rc=0
lb build || lb_rc=$?
if [ "${lb_rc}" -ne 0 ]; then
    if ls "${SRC}"/*.iso >/dev/null 2>&1; then
        echo "NOTE: lb build's optional post-ISO .img step failed (no UDisks"
        echo "      in the container) — the .iso built fine, continuing."
    else
        echo "ERROR: lb build failed (rc=${lb_rc}) and produced no .iso" >&2
        exit 1
    fi
fi

copy_iso
