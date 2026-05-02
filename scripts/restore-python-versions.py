#!/usr/bin/env python3
"""
Restore Python package dependency constraints after publishing.

This script restores flexible version constraints for local development.
It changes strict version constraints back to minimum versions.

Usage: python scripts/restore-python-versions.py [--dry-run]
"""

import argparse
import re
from pathlib import Path

# Default minimum version constraint for elizaos packages
DEFAULT_MIN_VERSION = ">=1.0.0"


def discover_package_dirs(workspace_root: Path) -> list[Path]:
    """Auto-discover Python package directories."""
    dirs = []

    # Core package
    core_path = workspace_root / "packages" / "python"
    if (core_path / "pyproject.toml").exists():
        dirs.append(core_path)

    # Plugin packages
    plugins_path = workspace_root / "plugins"
    if plugins_path.exists():
        for plugin_dir in sorted(plugins_path.iterdir()):
            python_dir = plugin_dir / "python"
            if (python_dir / "pyproject.toml").exists():
                dirs.append(python_dir)

    return dirs


def get_elizaos_package_names(workspace_root: Path) -> set[str]:
    """Get all elizaos package names from pyproject.toml files."""
    names = set()
    for pkg_dir in discover_package_dirs(workspace_root):
        pyproject = pkg_dir / "pyproject.toml"
        if pyproject.exists():
            content = pyproject.read_text()
            match = re.search(r'^name\s*=\s*"([^"]+)"', content, re.MULTILINE)
            if match:
                name = match.group(1)
                if name.startswith("elizaos"):
                    names.add(name)
    return names


def restore_pyproject_dependencies(
    pyproject_path: Path, elizaos_packages: set[str], dry_run: bool
) -> int:
    """Restore flexible dependency constraints in pyproject.toml."""
    if not pyproject_path.exists():
        return 0

    content = pyproject_path.read_text()
    original = content
    changes = 0

    # Restore dependencies to default constraints
    for pkg in elizaos_packages:
        # Match patterns like "elizaos>=2.0.0a1" or "elizaos==2.0.0"
        pattern = rf'("{pkg})([><=!~]+)([^"]+)"'

        def restore_constraint(m: re.Match) -> str:
            nonlocal changes
            pkg_name = m.group(1)
            current_constraint = m.group(2) + m.group(3)

            # Only change if different from default
            if current_constraint != DEFAULT_MIN_VERSION:
                changes += 1
                return f'{pkg_name}{DEFAULT_MIN_VERSION}"'
            return m.group(0)

        content = re.sub(pattern, restore_constraint, content)

    if content != original:
        print(f"  Restored {changes} dependency constraints in {pyproject_path}")
        if not dry_run:
            pyproject_path.write_text(content)
        return changes
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="Restore Python package dependency constraints"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be changed without modifying files",
    )
    parser.add_argument("--verbose", action="store_true", help="Show detailed output")
    args = parser.parse_args()

    print("🐍 Restoring Python package dependency constraints\n")

    if args.dry_run:
        print("🏃 Dry run mode - no files will be modified\n")

    workspace_root = Path(__file__).parent.parent

    # Auto-discover packages
    package_dirs = discover_package_dirs(workspace_root)
    elizaos_packages = get_elizaos_package_names(workspace_root)

    print(f"📂 Found {len(package_dirs)} Python packages")
    print(f"🏷️  Found {len(elizaos_packages)} elizaos package names\n")

    total_deps = 0

    for pkg_dir in package_dirs:
        pyproject = pkg_dir / "pyproject.toml"
        pkg_dir_rel = pkg_dir.relative_to(workspace_root)

        deps_restored = restore_pyproject_dependencies(
            pyproject, elizaos_packages, args.dry_run
        )
        if deps_restored > 0:
            print(f"📦 {pkg_dir_rel}")
        total_deps += deps_restored

    print(f"\n✅ Done! Restored {total_deps} dependency constraints.")

    if args.dry_run:
        print("\n💡 Run without --dry-run to apply changes.")


if __name__ == "__main__":
    main()
