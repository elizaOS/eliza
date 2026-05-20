#!/usr/bin/env sh
set -eu

RUN_MODE="${OPENLANE_RUN_MODE:-release}"
CONFIG="${OPENLANE_CONFIG:-}"
IMAGE="${OPENLANE_IMAGE:-ghcr.io/efabless/openlane2:2.4.0.dev1}"
TIMEOUT_SECONDS="${OPENLANE_TIMEOUT_SECONDS:-}"
REPO_DIR="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
PDK_ROOT_HOST="${PDK_ROOT:-$REPO_DIR/external/pdks}"
LOCK_DIR="${OPENLANE_LOCK_DIR:-$REPO_DIR/.openlane-run.lock}"
DOCKER_CID_FILE="$LOCK_DIR/docker.cid"

usage() {
    cat <<'EOF'
Usage: scripts/run_openlane.sh [--release|--exploratory|--smoke] [--config PATH]

Release mode uses fail-closed OpenLane configs and is the only mode suitable for
signoff evidence. Exploratory and smoke runs are blocked evidence until
scripts/check_pd_signoff.py passes against a selected complete run.
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --release)
            RUN_MODE="release"
            ;;
        --exploratory)
            RUN_MODE="exploratory"
            ;;
        --smoke)
            RUN_MODE="smoke"
            ;;
        --config)
            shift
            if [ "$#" -eq 0 ]; then
                echo "--config requires a path" >&2
                exit 2
            fi
            CONFIG="$1"
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "Unknown OpenLane wrapper argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

if [ -z "$CONFIG" ]; then
    case "$RUN_MODE" in
        release) CONFIG="pd/openlane/config.sky130.json" ;;
        exploratory) CONFIG="pd/openlane/config.sky130.exploratory.json" ;;
        smoke) CONFIG="pd/openlane/config.pd-smoke.sky130.json" ;;
        *)
            echo "Unknown OPENLANE_RUN_MODE: $RUN_MODE" >&2
            exit 2
            ;;
    esac
elif [ -z "${OPENLANE_RUN_MODE:-}" ]; then
    case "$CONFIG" in
        *exploratory.json) RUN_MODE="exploratory" ;;
        *config.pd-smoke.*.json) RUN_MODE="smoke" ;;
    esac
fi

active_openlane_containers() {
    if ! command -v docker >/dev/null 2>&1; then
        return 0
    fi
    docker ps \
        --filter "label=eliza.openlane=1" \
        --filter "label=eliza.repo=$REPO_DIR" \
        --format '{{.ID}} {{.Status}} {{.Names}}' 2>/dev/null || true
}

cleanup() {
    if [ -f "$DOCKER_CID_FILE" ] && command -v docker >/dev/null 2>&1; then
        docker rm -f "$(cat "$DOCKER_CID_FILE")" >/dev/null 2>&1 || true
    fi
    rm -rf "$LOCK_DIR"
}

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    if [ -f "$LOCK_DIR/pid" ] && kill -0 "$(cat "$LOCK_DIR/pid")" 2>/dev/null; then
        echo "OpenLane run already active under pid $(cat "$LOCK_DIR/pid")."
        echo "Remove $LOCK_DIR only after confirming no OpenLane/Docker flow is running."
        exit 3
    fi
    active_containers="$(active_openlane_containers)"
    if [ -n "$active_containers" ]; then
        echo "OpenLane Docker container already active for $REPO_DIR:"
        echo "$active_containers"
        echo "Stop the container before removing stale lock $LOCK_DIR."
        exit 3
    fi
    echo "Removing stale OpenLane lock: $LOCK_DIR"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR"
fi
printf '%s\n' "$$" > "$LOCK_DIR/pid"
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$LOCK_DIR/started_at"
printf '%s\n' "$CONFIG" > "$LOCK_DIR/config"
printf '%s\n' "$IMAGE" > "$LOCK_DIR/image"
trap cleanup EXIT INT TERM

active_containers="$(active_openlane_containers)"
if [ -n "$active_containers" ]; then
    echo "OpenLane Docker container already active for $REPO_DIR:"
    echo "$active_containers"
    exit 3
fi

cd "$REPO_DIR"

echo "OpenLane wrapper mode: $RUN_MODE"
echo "OpenLane wrapper config: $CONFIG"

run_maybe_timeout() {
    if [ -n "$TIMEOUT_SECONDS" ]; then
        python3 "$REPO_DIR/scripts/run_with_timeout.py" \
            --timeout-seconds "$TIMEOUT_SECONDS" \
            --label openlane \
            -- "$@"
    else
        "$@"
    fi
}

diagnose_latest_run() {
    python3 "$REPO_DIR/scripts/diagnose_openlane_run.py" \
        --run-root "$REPO_DIR/pd/openlane/runs" || true
}

copy_docker_runs() {
    cid_file=$1
    if [ ! -s "$cid_file" ] || ! command -v docker >/dev/null 2>&1; then
        return 0
    fi
    if find "$REPO_DIR/pd/openlane/runs" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep . >/dev/null 2>&1; then
        echo "OpenLane run artifacts are already visible through the bind mount."
        return 0
    fi
    cid="$(cat "$cid_file")"
    if ! docker container inspect "$cid" >/dev/null 2>&1; then
        return 0
    fi
    mkdir -p "$REPO_DIR/pd/openlane/runs"
    echo "Copying OpenLane run artifacts from Docker container $cid to pd/openlane/runs"
    docker cp "$cid:/work/pd/openlane/runs/." "$REPO_DIR/pd/openlane/runs/" >/dev/null 2>&1 || {
        if find "$REPO_DIR/pd/openlane/runs" -mindepth 1 -maxdepth 1 -type d | grep . >/dev/null 2>&1; then
            echo "OpenLane run artifacts are already visible through the bind mount."
        else
            echo "No OpenLane run artifacts were available to copy from container $cid."
        fi
    }
}

normalize_docker_outputs() {
    return 0
}

run_and_diagnose() {
    set +e
    run_maybe_timeout "$@"
    status=$?
    set -e
    if [ "$status" -ne 0 ]; then
        echo "OpenLane command exited with status $status; diagnosing latest run directory."
        diagnose_latest_run
    fi
    return "$status"
}

run_docker_and_diagnose() {
    rm -f "$DOCKER_CID_FILE"
    set +e
    run_maybe_timeout docker run \
        --cidfile "$DOCKER_CID_FILE" \
        --label "eliza.openlane=1" \
        --label "eliza.repo=$REPO_DIR" \
        -v "$REPO_DIR:/work" \
        -w /work \
        -e "PDK_ROOT=$pdk_root_container" \
        "$IMAGE" openlane --pdk-root "$pdk_root_container" "$CONFIG"
    status=$?
    set -e
    copy_docker_runs "$DOCKER_CID_FILE"
    normalize_docker_outputs
    if [ "$status" -ne 0 ]; then
        echo "OpenLane Docker command exited with status $status; diagnosing latest run directory."
        diagnose_latest_run
    fi
    return "$status"
}

if command -v openlane >/dev/null 2>&1; then
    echo "OpenLane wrapper command: openlane $CONFIG"
    run_and_diagnose openlane "$CONFIG"
elif command -v flow.tcl >/dev/null 2>&1; then
    case "$CONFIG" in
        */config.json|config.json)
            echo "OpenLane wrapper command: flow.tcl -design pd/openlane"
            run_and_diagnose flow.tcl -design pd/openlane
            ;;
        *)
            echo "Legacy flow.tcl cannot select $CONFIG reliably. Use OpenLane 2 or set OPENLANE_CONFIG=pd/openlane/config.json."
            exit 1
            ;;
    esac
else
    if ! command -v docker >/dev/null 2>&1; then
        echo "OpenLane missing and docker is not on PATH."
        echo "Install OpenLane 2, or install Docker and run: OPENLANE_IMAGE=$IMAGE scripts/install_openlane_image.sh"
        exit 1
    fi
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
        echo "OpenLane missing and Docker image is not installed: $IMAGE"
        echo "Install it with: OPENLANE_IMAGE=$IMAGE scripts/install_openlane_image.sh"
        echo "Then rerun: OPENLANE_CONFIG=$CONFIG make openlane"
        exit 1
    fi
    case "$PDK_ROOT_HOST" in
        "$REPO_DIR"/external/pdks) pdk_root_container="/work/external/pdks" ;;
        *) pdk_root_container="$PDK_ROOT_HOST" ;;
    esac
    echo "OpenLane wrapper command: docker run -v $REPO_DIR:/work -w /work -e PDK_ROOT=$pdk_root_container $IMAGE openlane --pdk-root $pdk_root_container $CONFIG"
    run_docker_and_diagnose
fi
