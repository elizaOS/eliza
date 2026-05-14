# shellcheck shell=ash

PREREQS=""

prereqs() { echo "$PREREQS"; }

case "${1:-}" in
prereqs)
    prereqs
    exit 0
    ;;
esac

REPARTITIONING_ERROR_FLAG_FILE=/run/repartitioning-failed

log() {
    echo "$(date "+%H:%M:%S.%3N") $*"
}

set_partition_error_reason() {
    echo "$1" >"${REPARTITIONING_ERROR_FLAG_FILE}"
}
