"""Inspect GLB structure and compute bounding box without external deps."""
import json
import struct
import numpy as np
from pathlib import Path

GLB_PATH = Path(__file__).parent.parent / "saffron_sentinel.glb"


def parse_glb(path: Path) -> tuple[dict, bytes]:
    """Parse GLB binary and return (json_chunk, binary_chunk)."""
    with open(path, "rb") as f:
        magic, version, total_length = struct.unpack("<III", f.read(12))
        assert magic == 0x46546C67, "Not a GLB file"

        json_chunk_len, json_chunk_type = struct.unpack("<II", f.read(8))
        assert json_chunk_type == 0x4E4F534A, "First chunk must be JSON"
        json_data = json.loads(f.read(json_chunk_len).decode("utf-8"))

        bin_chunk = b""
        remaining = f.read()
        if len(remaining) >= 8:
            bin_chunk_len, bin_chunk_type = struct.unpack("<II", remaining[:8])
            if bin_chunk_type == 0x004E4942:
                bin_chunk = remaining[8:8 + bin_chunk_len]

    return json_data, bin_chunk


def get_accessor_data(json_data: dict, bin_chunk: bytes, accessor_idx: int) -> np.ndarray:
    """Read accessor data from binary chunk."""
    accessor = json_data["accessors"][accessor_idx]
    bv_idx = accessor.get("bufferView")
    if bv_idx is None:
        return np.array([])

    bv = json_data["bufferViews"][bv_idx]
    offset = bv.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    count = accessor["count"]

    component_type = accessor["componentType"]
    dtype_map = {5120: np.int8, 5121: np.uint8, 5122: np.int16,
                 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
    dtype = dtype_map[component_type]

    type_map = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4,
                "MAT2": 4, "MAT3": 9, "MAT4": 16}
    n_components = type_map[accessor["type"]]

    n_bytes = count * n_components * np.dtype(dtype).itemsize
    raw = bin_chunk[offset:offset + n_bytes]
    return np.frombuffer(raw, dtype=dtype).reshape(count, n_components)


def compute_full_bbox(json_data: dict, bin_chunk: bytes) -> tuple[np.ndarray, np.ndarray]:
    """Compute world bounding box by iterating all mesh primitives."""
    all_min = np.full(3, np.inf)
    all_max = np.full(3, -np.inf)

    for mesh in json_data.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            attrs = primitive.get("attributes", {})
            if "POSITION" not in attrs:
                continue
            acc_idx = attrs["POSITION"]
            accessor = json_data["accessors"][acc_idx]
            mn = accessor.get("min")
            mx = accessor.get("max")
            if mn and mx:
                all_min = np.minimum(all_min, mn)
                all_max = np.maximum(all_max, mx)
            else:
                try:
                    verts = get_accessor_data(json_data, bin_chunk, acc_idx)
                    if len(verts):
                        all_min = np.minimum(all_min, verts.min(axis=0))
                        all_max = np.maximum(all_max, verts.max(axis=0))
                except Exception:
                    pass

    return all_min, all_max


if __name__ == "__main__":
    print(f"Inspecting {GLB_PATH}")
    json_data, bin_chunk = parse_glb(GLB_PATH)

    print(f"  asset version: {json_data.get('asset', {}).get('version', '?')}")
    print(f"  meshes: {len(json_data.get('meshes', []))}")
    print(f"  nodes: {len(json_data.get('nodes', []))}")
    print(f"  materials: {len(json_data.get('materials', []))}")
    print(f"  binary chunk: {len(bin_chunk) / 1024:.1f} KB")

    mn, mx = compute_full_bbox(json_data, bin_chunk)
    size = mx - mn
    print(f"\nBounding box (GLB native units):")
    print(f"  min: {mn}")
    print(f"  max: {mx}")
    print(f"  size X={size[0]:.4f}  Y={size[1]:.4f}  Z={size[2]:.4f}")

    # ASIMOV-1 height reference: robot is ~1.7m tall, pelvis at ~0.63m
    asimov_height_m = 1.70
    if size[1] > 0 and size[2] > 0:
        # Meshy usually outputs Y-up models
        glb_height = max(size[1], size[2])
        scale_to_asimov = asimov_height_m / glb_height
        print(f"\nTo match ASIMOV-1 height ({asimov_height_m}m):")
        print(f"  GLB longest vertical dim = {glb_height:.4f}")
        print(f"  scale factor = {scale_to_asimov:.4f}")

    # List node names (body part labels if any)
    nodes = json_data.get("nodes", [])
    print(f"\nNode names (first 20):")
    for n in nodes[:20]:
        print(f"  {n.get('name', '(unnamed)')}")
