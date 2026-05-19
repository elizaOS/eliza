#!/usr/bin/env sh
# Compute SHA256 digests for the EDA tools and PDK assets used by each
# OpenLane run. Emits a single JSON object on stdout whose keys match the
# tool-digest fields required by pd/signoff/run-manifest.schema.json:
#
#   openlane_image_digest, volare_pdk_digest, klayout_digest, magic_digest,
#   netgen_digest, openroad_digest, yosys_digest, abc_digest,
#   antenna_deck_digest
#
# When a tool or asset is not present locally the value is recorded as the
# literal string "unavailable" and a sibling <tool>_unavailable_reason field
# is emitted. Closes Workstream E reproducibility blocker (H-4) from
# packages/chip/research/00_integration_shortlist.md.
#
# Usage:
#   scripts/record_tool_digests.sh [--out path/to/digests.json]
#
# Environment overrides:
#   OPENLANE_IMAGE        Docker reference whose digest is captured.
#   VOLARE_PDK_ROOT       Directory of the pinned Volare PDK snapshot.
#   ANTENNA_DECK          Path to the antenna-check deck used at signoff.
set -eu

OUT_FILE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --out)
            shift
            OUT_FILE="${1:-}"
            ;;
        --help|-h)
            sed -n '2,28p' "$0"
            exit 0
            ;;
        *)
            printf 'unknown argument: %s\n' "$1" >&2
            exit 2
            ;;
    esac
    shift || true
done

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"

if [ -d "$repo_dir/tools/bin" ]; then
    PATH="$repo_dir/tools/bin:$PATH"
fi
if [ -d "$repo_dir/.venv/bin" ]; then
    PATH="$repo_dir/.venv/bin:$PATH"
fi
if [ -d "$repo_dir/external/oss-cad-suite/bin" ]; then
    PATH="$repo_dir/external/oss-cad-suite/bin:$PATH"
fi

OPENLANE_IMAGE="${OPENLANE_IMAGE:-ghcr.io/efabless/openlane2:2.4.0.dev1}"
VOLARE_PDK_ROOT="${VOLARE_PDK_ROOT:-$repo_dir/external/pdks/volare/sky130/versions/0fe599b2afb6708d281543108caf8310912f54af}"
ANTENNA_DECK="${ANTENNA_DECK:-$repo_dir/pd/openlane/antenna.tcl}"

sha256_of_file() {
    file="$1"
    if [ ! -f "$file" ]; then
        printf ''
        return 1
    fi
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file" | awk '{print $1}'
    else
        printf ''
        return 1
    fi
}

sha256_of_tree() {
    tree="$1"
    if [ ! -d "$tree" ]; then
        printf ''
        return 1
    fi
    if command -v sha256sum >/dev/null 2>&1; then
        find "$tree" -type f -print0 \
            | LC_ALL=C sort -z \
            | xargs -0 sha256sum 2>/dev/null \
            | sha256sum \
            | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        find "$tree" -type f -print0 \
            | LC_ALL=C sort -z \
            | xargs -0 shasum -a 256 2>/dev/null \
            | shasum -a 256 \
            | awk '{print $1}'
    else
        printf ''
        return 1
    fi
}

sha256_of_image() {
    image="$1"
    if ! command -v docker >/dev/null 2>&1; then
        printf ''
        return 1
    fi
    digest="$(docker inspect --format '{{index .Id}}' "$image" 2>/dev/null || true)"
    case "$digest" in
        sha256:*)
            printf '%s' "${digest#sha256:}"
            ;;
        *)
            printf ''
            return 1
            ;;
    esac
}

sha256_of_binary() {
    binary="$1"
    path="$(command -v "$binary" 2>/dev/null || true)"
    if [ -z "$path" ]; then
        printf ''
        return 1
    fi
    if [ -L "$path" ]; then
        resolved="$(readlink -f "$path" 2>/dev/null || true)"
        if [ -n "$resolved" ]; then
            path="$resolved"
        fi
    fi
    sha256_of_file "$path"
}

emit() {
    field="$1"
    value="$2"
    reason="${3:-}"
    if [ -n "$value" ]; then
        printf '  "%s": "sha256:%s"' "$field" "$value"
    else
        printf '  "%s": "unavailable"' "$field"
        if [ -n "$reason" ]; then
            printf ',\n  "%s_unavailable_reason": "%s"' "${field%_digest}" "$reason"
        fi
    fi
}

OPENLANE_DIGEST="$(sha256_of_image "$OPENLANE_IMAGE" || printf '')"
VOLARE_DIGEST="$(sha256_of_tree "$VOLARE_PDK_ROOT" || printf '')"
KLAYOUT_DIGEST="$(sha256_of_binary klayout || printf '')"
MAGIC_DIGEST="$(sha256_of_binary magic || printf '')"
NETGEN_DIGEST="$(sha256_of_binary netgen || printf '')"
OPENROAD_DIGEST="$(sha256_of_binary openroad || printf '')"
YOSYS_DIGEST="$(sha256_of_binary yosys || printf '')"
ABC_DIGEST="$(sha256_of_binary yosys-abc || printf '')"
if [ -z "$ABC_DIGEST" ]; then
    ABC_DIGEST="$(sha256_of_binary abc || printf '')"
fi
ANTENNA_DIGEST="$(sha256_of_file "$ANTENNA_DECK" || printf '')"

{
    printf '{\n'
    emit openlane_image_digest "$OPENLANE_DIGEST" "docker image not pulled locally"
    printf ',\n'
    emit volare_pdk_digest "$VOLARE_DIGEST" "Volare PDK snapshot not present at $VOLARE_PDK_ROOT"
    printf ',\n'
    emit klayout_digest "$KLAYOUT_DIGEST" "klayout binary not on PATH"
    printf ',\n'
    emit magic_digest "$MAGIC_DIGEST" "magic binary not on PATH"
    printf ',\n'
    emit netgen_digest "$NETGEN_DIGEST" "netgen binary not on PATH"
    printf ',\n'
    emit openroad_digest "$OPENROAD_DIGEST" "openroad binary not on PATH"
    printf ',\n'
    emit yosys_digest "$YOSYS_DIGEST" "yosys binary not on PATH"
    printf ',\n'
    emit abc_digest "$ABC_DIGEST" "yosys-abc / abc binary not on PATH"
    printf ',\n'
    emit antenna_deck_digest "$ANTENNA_DIGEST" "antenna deck not present at $ANTENNA_DECK"
    printf '\n}\n'
} | if [ -n "$OUT_FILE" ]; then
    mkdir -p "$(dirname "$OUT_FILE")"
    tee "$OUT_FILE"
else
    cat
fi
