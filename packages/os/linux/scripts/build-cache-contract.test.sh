#!/usr/bin/env bash
# Contract test for build.sh's Docker builder-cache switch. Uses a fake Docker
# binary so the test proves command construction without building an image.
#
# The canonical Tails-derived builder is amd64-only. This test also proves
# unsupported architectures fail before Docker is invoked.

set -euo pipefail

ARCH="amd64"
SNAPSHOT_JSON='{"debian":"2026072704","debian-security":"2026072704","torproject":"2026050704"}'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
CREATED_OUT=0
if [ ! -e "${ROOT}/out" ]; then
    CREATED_OUT=1
fi

cleanup() {
    rm -rf "${TMP}"
    if [ "${CREATED_OUT}" = "1" ]; then
        rm -rf "${ROOT}/out"
    fi
}
trap cleanup EXIT

mkdir -p \
    "${TMP}/bin" \
    "${TMP}/tails/config" \
    "${TMP}/tails/debian"
printf 'tails (7.8) UNRELEASED; urgency=medium\n' >"${TMP}/tails/debian/changelog"
git init -q "${TMP}/tails/submodules/live-build"
git -C "${TMP}/tails/submodules/live-build" config user.email iso-build@example.invalid
git -C "${TMP}/tails/submodules/live-build" config user.name "ISO build contract"
printf 'fake live-build checkout\n' >"${TMP}/tails/submodules/live-build/README"
git -C "${TMP}/tails/submodules/live-build" add README
git -C "${TMP}/tails/submodules/live-build" commit -q -m pinned
LIVE_BUILD_TEST_REF="$(
    git -C "${TMP}/tails/submodules/live-build" rev-parse HEAD
)"

cat >"${TMP}/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"${DOCKER_LOG}"

case "${1:-}" in
    build)
        exit 0
        ;;
    buildx)
        case "${2:-}" in
            version|build)
                exit 0
                ;;
        esac
        ;;
    volume)
        case "${2:-}" in
            inspect|create)
                exit 0
                ;;
        esac
        ;;
    run)
        exit 0
        ;;
esac

echo "unexpected fake docker invocation: $*" >&2
exit 64
SH
chmod +x "${TMP}/bin/docker"

run_build_with_log() {
    local log="$1"
    shift
    : >"${log}"
    (
        cd "${ROOT}"
        env \
            PATH="${TMP}/bin:${PATH}" \
            TAILS_SRC="${TMP}/tails" \
            TAILS_LIVE_BUILD_REF="${LIVE_BUILD_TEST_REF}" \
            DOCKER_LOG="${log}" \
            APT_SNAPSHOTS_SERIALS="${SNAPSHOT_JSON}" \
            "$@" \
            ./build.sh config
    ) >/dev/null
}

plain_log="${TMP}/plain.log"
run_build_with_log "${plain_log}" ELIZAOS_DOCKER_BUILDX_GHA_CACHE=0
grep -Fqx "build --platform linux/${ARCH} --build-arg TARGETARCH=${ARCH} -t elizaos-builder-${ARCH} ${ROOT}" "${plain_log}"
if grep -Fq "buildx build" "${plain_log}"; then
    echo "build.sh used buildx while ELIZAOS_DOCKER_BUILDX_GHA_CACHE=0" >&2
    exit 1
fi
if grep -Fq -- "--cache-from" "${plain_log}"; then
    echo "build.sh passed cache flags while ELIZAOS_DOCKER_BUILDX_GHA_CACHE=0" >&2
    exit 1
fi

cache_log="${TMP}/cache.log"
run_build_with_log \
    "${cache_log}" \
    ELIZAOS_DOCKER_BUILDX_GHA_CACHE=1 \
    ELIZAOS_DOCKER_BUILDX_CACHE_SCOPE=contract-scope
grep -Fqx "buildx version" "${cache_log}"
grep -Fqx "buildx build --platform linux/${ARCH} --build-arg TARGETARCH=${ARCH} -t elizaos-builder-${ARCH} --load --cache-from type=gha,scope=contract-scope --cache-to type=gha,scope=contract-scope,mode=max ${ROOT}" "${cache_log}"

grep -Fq -- "-e APT_SNAPSHOTS_SERIALS=${SNAPSHOT_JSON}" "${plain_log}"
grep -Fq -- "-e TAILS_CUSTOM_APT_SUITE=7.8" "${plain_log}"

custom_apt_sources="$(
    cd "${ROOT}/tails"
    TAILS_CUSTOM_APT_SUITE=7.8 auto/scripts/tails-custom-apt-sources
)"
grep -Fqx "deb http://deb.tails.boum.org/ 7.8 main contrib non-free" \
    <<<"${custom_apt_sources}"
if grep -Fq " stable " <<<"${custom_apt_sources}"; then
    echo "explicit custom package suite unexpectedly retained moving stable" >&2
    exit 1
fi

unsupported_log="${TMP}/unsupported-docker.log"
unsupported_output="${TMP}/unsupported-output.log"
: >"${unsupported_log}"
if (
    cd "${ROOT}"
    env \
        PATH="${TMP}/bin:${PATH}" \
        TAILS_SRC="${TMP}/tails" \
        TAILS_LIVE_BUILD_REF="${LIVE_BUILD_TEST_REF}" \
        DOCKER_LOG="${unsupported_log}" \
        ELIZAOS_ARCH=arm64 \
        ./build.sh config
) >"${unsupported_output}" 2>&1; then
    echo "build.sh accepted unsupported arm64 ISO target" >&2
    exit 1
fi
grep -Fq "canonical Tails-derived ISO currently supports amd64 only" "${unsupported_output}"
test ! -s "${unsupported_log}"

echo "build.sh Docker cache contract OK"
