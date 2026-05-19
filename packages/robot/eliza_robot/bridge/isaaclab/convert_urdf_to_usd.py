"""Convert AiNex URDF to USD for IsaacLab import.

Usage:
    python -m bridge.isaaclab.convert_urdf_to_usd [--urdf PATH] [--out PATH]

Requires Isaac Sim Python environment with omni.isaac.lab available.
Falls back to a standalone validation mode when Isaac is not available.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent.parent
DEFAULT_URDF = ROOT_DIR / "bridge" / "generated" / "ainex.urdf"
DEFAULT_USD = ROOT_DIR / "bridge" / "generated" / "ainex.usd"


def _validate_urdf(urdf_path: Path) -> bool:
    """Basic XML validation of the URDF file."""
    import xml.etree.ElementTree as ET

    tree = ET.parse(str(urdf_path))
    root = tree.getroot()
    if root.tag != "robot":
        print(f"ERROR: root element is '{root.tag}', expected 'robot'")
        return False

    joints = root.findall("joint")
    links = root.findall("link")
    revolute = [j for j in joints if j.get("type") == "revolute"]
    print(f"URDF validation: {len(links)} links, {len(joints)} joints ({len(revolute)} revolute)")

    if len(revolute) < 24:
        print(f"WARNING: expected 24 revolute joints, found {len(revolute)}")

    return True


def _convert_with_isaac(urdf_path: Path, usd_path: Path) -> bool:
    """Convert URDF to USD using Isaac Sim's URDF importer."""
    try:
        from omni.isaac.lab.sim.converters import UrdfConverter, UrdfConverterCfg
    except ImportError:
        try:
            from omni.isaac.lab.utils.assets import UrdfConverter, UrdfConverterCfg
        except ImportError:
            print("ERROR: Could not import IsaacLab URDF converter.")
            print("Ensure you are running in an Isaac Sim Python environment.")
            return False

    cfg = UrdfConverterCfg(
        asset_path=str(urdf_path),
        usd_dir=str(usd_path.parent),
        usd_file_name=usd_path.name,
        fix_base=False,
        make_instanceable=False,
        force_usd_conversion=True,
    )

    converter = UrdfConverter(cfg)
    print(f"USD file generated: {converter.usd_path}")
    return True


def _convert_standalone(urdf_path: Path, usd_path: Path) -> bool:
    """Standalone conversion using urdf2usd or similar tools."""
    # Try using Isaac Sim's standalone script
    isaac_sim_path = os.environ.get("ISAAC_SIM_PATH", "")
    if isaac_sim_path:
        script = Path(isaac_sim_path) / "exts" / "omni.isaac.urdf" / "scripts" / "urdf_to_usd.py"
        if script.exists():
            import subprocess

            result = subprocess.run(
                [
                    sys.executable,
                    str(script),
                    "--urdf_path",
                    str(urdf_path),
                    "--output_path",
                    str(usd_path),
                ],
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                print(f"USD file generated via standalone script: {usd_path}")
                return True
            print(f"Standalone conversion failed: {result.stderr}")

    print("No Isaac Sim conversion tools available.")
    print("To convert manually:")
    print(f"  1. Open Isaac Sim")
    print(f"  2. Use URDF Importer extension")
    print(f"  3. Import: {urdf_path}")
    print(f"  4. Save as: {usd_path}")
    return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert AiNex URDF to USD for IsaacLab")
    parser.add_argument(
        "--urdf",
        type=str,
        default=str(DEFAULT_URDF),
        help="input URDF path",
    )
    parser.add_argument(
        "--out",
        type=str,
        default=str(DEFAULT_USD),
        help="output USD path",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="only validate URDF without converting",
    )
    args = parser.parse_args()

    urdf_path = Path(args.urdf)
    usd_path = Path(args.out)

    if not urdf_path.exists():
        print(f"ERROR: URDF file not found: {urdf_path}")
        print("Run ./bridge/scripts/prepare_ainex_urdf.sh first.")
        raise SystemExit(1)

    if not _validate_urdf(urdf_path):
        raise SystemExit(1)

    if args.validate_only:
        print("Validation passed.")
        raise SystemExit(0)

    usd_path.parent.mkdir(parents=True, exist_ok=True)

    # Try Isaac Lab converter first, then standalone.
    if _convert_with_isaac(urdf_path, usd_path):
        raise SystemExit(0)

    if _convert_standalone(urdf_path, usd_path):
        raise SystemExit(0)

    raise SystemExit(1)


if __name__ == "__main__":
    main()
