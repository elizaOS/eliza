#!/usr/bin/env bash
# Contract test for build.sh's Docker builder-cache switch. Uses a fake Docker
# binary so the test proves command construction without building an image.
#
# Arch-parametric: build.sh derives its platform/tag strings from ELIZAOS_ARCH,
# and the CI job env exports it (arm64 on the arm64 leg) — so the expected
# invocations below must be built from the same variable, not amd64 literals.
# Hardcoded amd64 expectations made this test fail (silently, inside the
# static-smoke set -e chain) on every non-amd64 runner.

set -euo pipefail

ARCH="${ELIZAOS_ARCH:-amd64}"
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

mkdir -p "${TMP}/bin" "${TMP}/tails/config" "${TMP}/tails/submodules/live-build"
printf 'fake live-build checkout\n' >"${TMP}/tails/submodules/live-build/README"

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
            DOCKER_LOG="${log}" \
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

echo "build.sh Docker cache contract OK"
