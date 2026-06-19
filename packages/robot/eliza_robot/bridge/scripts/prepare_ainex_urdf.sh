#!/usr/bin/env bash
set -euo pipefail

# Export AiNex xacro -> URDF and optionally validate joint structure.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
XACRO_FILE="$ROOT_DIR/ros_ws_src/ainex_simulations/ainex_description/urdf/ainex.xacro"
OUT_DIR="$ROOT_DIR/bridge/generated"
OUT_URDF="$OUT_DIR/ainex.urdf"
MESH_SRC="$ROOT_DIR/ros_ws_src/ainex_simulations/ainex_description/meshes"
MESH_DST="$OUT_DIR/meshes"

mkdir -p "$OUT_DIR"

# ---- xacro export ----
if command -v xacro >/dev/null 2>&1; then
  echo "Generating URDF from xacro..."
  xacro "$XACRO_FILE" -o "$OUT_URDF"
  echo "Generated: $OUT_URDF"
else
  echo "xacro not found. Attempting to find pre-built URDF..." >&2
  FALLBACK="$ROOT_DIR/ros_ws_src/ainex_simulations/ainex_description/urdf/ainex.urdf"
  if [ -f "$FALLBACK" ]; then
    cp "$FALLBACK" "$OUT_URDF"
    echo "Copied fallback URDF: $OUT_URDF"
  else
    echo "No xacro command and no fallback URDF found." >&2
    echo "Source your ROS environment or generate URDF manually." >&2
    exit 1
  fi
fi

# ---- copy meshes ----
if [ -d "$MESH_SRC" ]; then
  echo "Copying mesh assets..."
  mkdir -p "$MESH_DST"
  cp -r "$MESH_SRC"/* "$MESH_DST"/
  echo "Meshes copied to: $MESH_DST"
else
  echo "Warning: mesh source directory not found at $MESH_SRC" >&2
fi

# ---- fix mesh paths in URDF ----
# Replace package:// URIs with relative paths for standalone use.
if [ -f "$OUT_URDF" ]; then
  echo "Patching mesh paths for standalone use..."
  sed -i 's|package://ainex_description/meshes/|meshes/|g' "$OUT_URDF"
  echo "Mesh paths patched."
fi

# ---- validate ----
if python3 -c "import xml.etree.ElementTree" 2>/dev/null; then
  echo "Validating URDF structure..."
  python3 - "$OUT_URDF" <<'PY'
import sys
import xml.etree.ElementTree as ET

tree = ET.parse(sys.argv[1])
root = tree.getroot()
joints = root.findall("joint")
links = root.findall("link")
print(f"  Links: {len(links)}")
print(f"  Joints: {len(joints)}")

revolute = [j for j in joints if j.get("type") == "revolute"]
fixed = [j for j in joints if j.get("type") == "fixed"]
print(f"  Revolute joints: {len(revolute)}")
print(f"  Fixed joints: {len(fixed)}")

for j in revolute:
    name = j.get("name")
    limit = j.find("limit")
    if limit is not None:
        lo = limit.get("lower", "N/A")
        hi = limit.get("upper", "N/A")
        effort = limit.get("effort", "N/A")
        print(f"    {name}: [{lo}, {hi}] effort={effort}")
PY
  echo "Validation complete."
fi

echo "urdf_export=PASS"
