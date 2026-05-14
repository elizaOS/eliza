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
#   TAILS_BUILD_OPTIONS — passed through to Tails' build (defaults to
#                "ignorechanges" since the mounted tree carries our
#                milady overlay commits).
set -euo pipefail

STAGE="${MT_STAGE:-build}"
SRC=/build
OUT=/out
ACNG_PORT=3142
ACNG_URL="http://127.0.0.1:${ACNG_PORT}"

echo "=== milady-tails containerized build ==="
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
# tree shipped in the milady-tails variant does not. If there's no repo,
# make a throwaway one — then both delivery shapes build identically.
if [ ! -d .git ]; then
    echo "no .git in source tree — initializing a throwaway repo for the build"
    git init -q
    git add -A
    git -c user.email='build@milady-tails' -c user.name='milady-tails' \
        commit -q -m 'milady-tails build snapshot'
fi

# auto/config + auto/build want git metadata the Rakefile normally
# exports. With the repo guaranteed above, these are always available.
GIT_COMMIT="$(git rev-parse HEAD)"
GIT_REF="$(git symbolic-ref -q HEAD || echo refs/heads/stable)"
export GIT_COMMIT GIT_REF
export BASE_BRANCH_GIT_COMMIT="${GIT_COMMIT}"
echo "git: HEAD=${GIT_COMMIT} ref=${GIT_REF}"

# Tails' build refuses a dirty git tree unless told otherwise. In the
# container the mounted source may legitimately carry our milady
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
trap 'kill "${ACNG_PID}" 2>/dev/null || true' EXIT
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

# Make Tails' helper scripts (apt-snapshots-serials, etc.) findable.
export PATH="${SRC}/auto/scripts:${SRC}/bin:${PATH}"

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
    # Restore config/ to the committed state (see the note in the full-build
    # path below). Safe here — it never touches chroot/. A failure here is
    # load-bearing (stale config = broken chroot), so do not swallow it.
    git checkout -- config/
    echo "=== lb config (refresh config tree) ==="
    lb config
    echo
    echo "=== lb binary (incremental — squashfs + ISO only) ==="
    lb binary
    copy_iso
    exit 0
fi

# ── STAGE=config / build — full pipeline ─────────────────────────────
# Start from a clean slate so every full build is reproducible and we
# never resume a half-built chroot. apt-cacher-ng keeps the re-download
# cheap, so a clean build is not a slow build.
echo "=== lb clean --purge ==="
lb clean --purge

# Restore config/ to the committed state. This is required, not cosmetic,
# because Tails' build mutates tracked files in config/ and assumes a
# fresh checkout each time (its CI clones anew; we build from a persistent
# tree):
#   - auto/clean (invoked by `lb clean`) deletes tracked package-list
#     files it treats as disposable — tails-installer.list,
#     tails-000-standard.list, tails-iuk.list, whisperback.list, etc.
#     Left deleted, the next build's chroot is missing whole package sets
#     (this is what made gdisk/mtools — tails-installer's deps — vanish).
#   - auto/config rewrites config/chroot_sources/*.chroot in place with
#     dated snapshot-mirror URLs; left dirty, the regex won't re-match and
#     you silently get the previous run's stale APT snapshot serial.
echo "=== restore config/ to committed state ==="
git checkout -- config/

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
