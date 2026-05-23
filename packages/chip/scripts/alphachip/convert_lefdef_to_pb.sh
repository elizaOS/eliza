#!/usr/bin/env bash
set -eu

REPO_DIR="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
IMAGE="${OPENLANE_IMAGE:-ghcr.io/efabless/openlane2:2.4.0.dev1}"
OUT_DIR="${ALPHACHIP_OUT_DIR:-/tmp/e1-alphachip/e1_handoff}"
DESIGN="${ALPHACHIP_DESIGN:-}"
DEF_FILE=""
NET_SIZE_THRESHOLD="${NET_SIZE_THRESHOLD:-300}"
LEFS=""

usage() {
    cat <<'EOF'
Usage: scripts/alphachip/convert_lefdef_to_pb.sh --def PATH [--design NAME] [--out-dir PATH] [--lef PATH ...]

Converts a placed LEF/DEF design to Circuit Training protobuf and init.plc using
TILOS MacroPlacement's OpenDB Tcl exporter. Runs OpenROAD inside the OpenLane
Docker image.

If --lef is omitted, the wrapper uses the local SKY130A sky130_fd_sc_hd nominal
tech LEF and standard-cell LEF from external/pdks/volare.
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --def)
            shift
            DEF_FILE="${1:-}"
            ;;
        --design)
            shift
            DESIGN="${1:-}"
            ;;
        --out-dir)
            shift
            OUT_DIR="${1:-}"
            ;;
        --lef)
            shift
            LEFS="${LEFS}${LEFS:+
}${1:-}"
            ;;
        --net-size-threshold)
            shift
            NET_SIZE_THRESHOLD="${1:-}"
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

if [ -z "$DEF_FILE" ]; then
    echo "--def is required" >&2
    usage >&2
    exit 2
fi

if [ -z "$DESIGN" ]; then
    DESIGN="$(awk '/^DESIGN / {print $2; exit}' "$DEF_FILE" | tr -d ';')"
fi
if [ -z "$DESIGN" ]; then
    echo "Could not infer design name from DEF; pass --design." >&2
    exit 2
fi

if [ -z "$LEFS" ]; then
    PDK_SKY130A="$(find "$REPO_DIR/external/pdks/volare/sky130/versions" -path '*/sky130A' -type d | sort | tail -1)"
    TECH_LEF="$PDK_SKY130A/libs.ref/sky130_fd_sc_hd/techlef/sky130_fd_sc_hd__nom.tlef"
    STD_LEF="$PDK_SKY130A/libs.ref/sky130_fd_sc_hd/lef/sky130_fd_sc_hd.lef"
    EF_LEF="$PDK_SKY130A/libs.ref/sky130_fd_sc_hd/lef/sky130_ef_sc_hd.lef"
    LEFS="$TECH_LEF
$STD_LEF
$EF_LEF"
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "Missing Docker image: $IMAGE" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"

TMP_MOUNT_FLAG=""
TMP_MOUNT_VOLUME=""
case "$OUT_DIR" in
    /tmp/e1-alphachip/*|/tmp/e1-alphachip)
        TMP_MOUNT_FLAG="-v"
        TMP_MOUNT_VOLUME="/tmp/e1-alphachip:/tmp/e1-alphachip"
        ;;
    "$REPO_DIR"/*)
        ;;
    *)
        echo "Output path must be under the repo or /tmp/e1-alphachip for Docker mounting: $OUT_DIR" >&2
        exit 2
        ;;
esac

to_container_path() {
    case "$1" in
        "$REPO_DIR"/*) printf '/work/%s' "${1#"$REPO_DIR"/}" ;;
        /tmp/e1-alphachip/*|/tmp/e1-alphachip) printf '%s' "$1" ;;
        *) printf '%s' "$1" ;;
    esac
}

DEF_CONTAINER="$(to_container_path "$(CDPATH=; cd -- "$(dirname -- "$DEF_FILE")" && pwd)/$(basename -- "$DEF_FILE")")"
OUT_CONTAINER="$(to_container_path "$(CDPATH=; cd -- "$OUT_DIR" && pwd)")"
LEF_ARGS=""
printf '%s\n' "$LEFS" > "$OUT_DIR/lef_files.txt"
while IFS= read -r lef; do
    [ -n "$lef" ] || continue
    abs_lef="$(CDPATH=; cd -- "$(dirname -- "$lef")" && pwd)/$(basename -- "$lef")"
    LEF_ARGS="${LEF_ARGS} --lef $(to_container_path "$abs_lef")"
done < "$OUT_DIR/lef_files.txt"

cat > "$OUT_DIR/convert_lefdef_to_pb.tcl" <<EOF
set out_pb "$OUT_CONTAINER/$DESIGN.pb.txt"
EOF
while IFS= read -r lef; do
    [ -n "$lef" ] || continue
    abs_lef="$(CDPATH=; cd -- "$(dirname -- "$lef")" && pwd)/$(basename -- "$lef")"
    printf 'read_lef "%s"\n' "$(to_container_path "$abs_lef")" >> "$OUT_DIR/convert_lefdef_to_pb.tcl"
done < "$OUT_DIR/lef_files.txt"
# Locate the TILOS MacroPlacement OpenDB protobuf exporter. The repo lives
# under external/repos/tilos-macroplacement/payload in this checkout; an older
# layout used external/MacroPlacement. Resolve to a repo-relative path so it
# maps correctly into the /work mount.
GEN_PB_OR=""
for cand in \
    "external/repos/tilos-macroplacement/payload/CodeElements/FormatTranslators/src/gen_pb_or.tcl" \
    "external/MacroPlacement/CodeElements/FormatTranslators/src/gen_pb_or.tcl"; do
    if [ -f "$REPO_DIR/$cand" ]; then
        GEN_PB_OR="$cand"
        break
    fi
done
if [ -z "$GEN_PB_OR" ]; then
    echo "Could not find gen_pb_or.tcl under external/. TILOS MacroPlacement exporter missing." >&2
    exit 1
fi

cat >> "$OUT_DIR/convert_lefdef_to_pb.tcl" <<EOF
read_def "$DEF_CONTAINER"
source "/work/$GEN_PB_OR"
gen_pb_netlist \$out_pb
exit
EOF

if [ -n "$TMP_MOUNT_FLAG" ]; then
    docker run --rm \
        -v "$REPO_DIR:/work" \
        "$TMP_MOUNT_FLAG" "$TMP_MOUNT_VOLUME" \
        -w /work \
        "$IMAGE" \
        openroad "$(to_container_path "$OUT_DIR/convert_lefdef_to_pb.tcl")"
else
    docker run --rm \
        -v "$REPO_DIR:/work" \
        -w /work \
        "$IMAGE" \
        openroad "$(to_container_path "$OUT_DIR/convert_lefdef_to_pb.tcl")"
fi

if [ ! -s "$OUT_DIR/$DESIGN.pb.txt" ]; then
    echo "Failed to generate protobuf: $OUT_DIR/$DESIGN.pb.txt" >&2
    exit 1
fi

sed -i \
    -e 's/placeholder: "macro"/placeholder: "MACRO"/g' \
    -e 's/placeholder: "stdcell"/placeholder: "STDCELL"/g' \
    -e 's/placeholder: "port"/placeholder: "PORT"/g' \
    -e 's/placeholder: "top"/placeholder: "TOP"/g' \
    -e 's/placeholder: "bottom"/placeholder: "BOTTOM"/g' \
    -e 's/placeholder: "left"/placeholder: "LEFT"/g' \
    -e 's/placeholder: "right"/placeholder: "RIGHT"/g' \
    "$OUT_DIR/$DESIGN.pb.txt"

cat > "$OUT_DIR/gen_init_plc.py" <<'PY'
import argparse

parser = argparse.ArgumentParser()
parser.add_argument("pb_file")
parser.add_argument("plc_file")
args = parser.parse_args()

nodes = []
current = None
key = None

def finish_node():
    if current and current.get("name") != "__metadata__":
        nodes.append(current)

with open(args.pb_file) as fp:
    for raw in fp:
        words = raw.split()
        if not words:
            continue
        if words[0] == "node":
            finish_node()
            current = {
                "id": len(nodes),
                "name": None,
                "height": 0.0,
                "width": 0.0,
                "weight": 0.0,
                "x": -1.0,
                "y": -1.0,
                "type": None,
                "side": None,
                "orientation": "N",
            }
        elif current is None:
            continue
        elif words[0] == "name:":
            current["name"] = words[1].strip('"')
        elif words[0] == "key:":
            key = words[1].strip('"')
        elif words[0] == "placeholder:" and key in current:
            current[key] = words[1].strip('"')
        elif words[0] == "f:" and key in current:
            current[key] = float(words[1])
finish_node()

hard_area = 0.0
soft_area = 0.0
hard_count = 0
soft_count = 0

with open(args.plc_file, "w") as fp:
    for node in nodes:
        if node["type"] in ("PORT", "port"):
            fp.write(f'{node["id"]} {node["x"]:.3f} {node["y"]:.3f} - 1\n')
    for node in nodes:
        if node["type"] == "MACRO":
            fp.write(f'{node["id"]} {node["x"]:.3f} {node["y"]:.3f} {node["orientation"] or "N"} 0\n')
            hard_area += node["height"] * node["width"]
            hard_count += 1
    for node in nodes:
        if node["type"] == "macro":
            fp.write(f'{node["id"]} {node["x"]:.3f} {node["y"]:.3f} {node["orientation"] or "N"} 0\n')
            soft_area += node["height"] * node["width"]
            soft_count += 1
    fp.write(f"# HARD MACRO AREA: {hard_area}\n")
    fp.write(f"# SOFT MACRO AREA: {soft_area}\n")
    fp.write(f"# Area: {hard_area + soft_area}\n")
    fp.write(f"# SOFT MACRO COUNT: {soft_count}\n")
    fp.write(f"# HARD MACRO COUNT: {hard_count}\n")
PY

python3 "$OUT_DIR/gen_init_plc.py" "$OUT_DIR/$DESIGN.pb.txt" "$OUT_DIR/$DESIGN.init.plc"

echo "Generated:"
echo "  $OUT_DIR/$DESIGN.pb.txt"
echo "  $OUT_DIR/$DESIGN.init.plc"
