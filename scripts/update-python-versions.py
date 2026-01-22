#!/usr/bin/env python3
"""
Update Python package versions before publishing to PyPI.

This script:
1. Updates version in pyproject.toml for all Python packages
2. Updates __version__ in __init__.py files
3. Updates dependency constraints to match the release version

Usage: python scripts/update-python-versions.py <version> [--dry-run]
Example: python scripts/update-python-versions.py 2.0.0-alpha.1 --dry-run
"""

import argparse
import re
import sys
from pathlib import Path

# ElizaOS Python packages that can be dependencies (auto-discovered)
# These are package names that appear in dependencies
ELIZAOS_PACKAGE_PREFIXES = ["elizaos", "elizaos-plugin-"]


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


def normalize_version(version: str) -> str:
    """Convert version to PEP 440 compatible format.

    - 2.0.0-alpha.1 -> 2.0.0a1
    - 2.0.0-beta.2 -> 2.0.0b2
    - 2.0.0 -> 2.0.0
    """
    # Handle alpha/beta/rc prereleases
    version = re.sub(r"-alpha\.?(\d+)?", lambda m: f"a{m.group(1) or '0'}", version)
    version = re.sub(r"-beta\.?(\d+)?", lambda m: f"b{m.group(1) or '0'}", version)
    version = re.sub(r"-rc\.?(\d+)?", lambda m: f"rc{m.group(1) or '0'}", version)
    return version


def update_pyproject_version(pyproject_path: Path, version: str, dry_run: bool) -> bool:
    """Update version in pyproject.toml."""
    if not pyproject_path.exists():
        return False

    content = pyproject_path.read_text()
    original = content

    # Update version = "x.y.z"
    content = re.sub(
        r'^version\s*=\s*"[^"]*"',
        f'version = "{version}"',
        content,
        flags=re.MULTILINE,
    )

    if content != original:
        print(f"  Updated version in {pyproject_path}")
        if not dry_run:
            pyproject_path.write_text(content)
        return True
    return False


def update_pyproject_dependencies(
    pyproject_path: Path, version: str, elizaos_packages: set[str], dry_run: bool
) -> int:
    """Update elizaos dependency constraints in pyproject.toml."""
    if not pyproject_path.exists():
        return 0

    content = pyproject_path.read_text()
    original = content
    changes = 0

    # Update dependencies like "elizaos>=1.0.0" to "elizaos>=2.0.0"
    for pkg in elizaos_packages:
        # Match patterns like "elizaos>=1.0.0" or "elizaos-plugin-mcp>=2.0.0"
        pattern = rf'("{pkg})([><=!~]+)([^"]+)"'

        def replace_version(m: re.Match) -> str:
            nonlocal changes
            pkg_name = m.group(1)
            operator = m.group(2)
            # Keep the same operator, just update the version
            if operator in [">=", "~=", "=="]:
                changes += 1
                return f'{pkg_name}{operator}{version}"'
            return m.group(0)

        content = re.sub(pattern, replace_version, content)

    if content != original:
        print(f"  Updated {changes} dependency constraints in {pyproject_path}")
        if not dry_run:
            pyproject_path.write_text(content)
        return changes
    return 0


def update_init_version(package_dir: Path, version: str, dry_run: bool) -> bool:
    """Update __version__ in __init__.py files."""
    # Find __init__.py files that might contain __version__
    init_files = list(package_dir.glob("*/__init__.py"))
    updated = False

    for init_file in init_files:
        content = init_file.read_text()
        original = content

        # Update __version__ = "x.y.z"
        content = re.sub(
            r'^__version__\s*=\s*["\'][^"\']*["\']',
            f'__version__ = "{version}"',
            content,
            flags=re.MULTILINE,
        )

        if content != original:
            print(f"  Updated __version__ in {init_file}")
            if not dry_run:
                init_file.write_text(content)
            updated = True

    return updated


def main():
    parser = argparse.ArgumentParser(
        description="Update Python package versions for publishing"
    )
    parser.add_argument("version", help="Version to set (e.g., 2.0.0 or 2.0.0-alpha.1)")
    parser.add_argument(
        "--dry-run", action="store_true", help="Show what would be changed without modifying files"
    )
    parser.add_argument(
        "--verbose", action="store_true", help="Show detailed output"
    )
    args = parser.parse_args()

    # Normalize version to PEP 440
    version = normalize_version(args.version)
    print(f"🐍 Updating Python packages to version {version}")
    if args.version != version:
        print(f"   (normalized from {args.version})")
    print()

    if args.dry_run:
        print("🏃 Dry run mode - no files will be modified\n")

    workspace_root = Path(__file__).parent.parent

    # Auto-discover packages
    package_dirs = discover_package_dirs(workspace_root)
    elizaos_packages = get_elizaos_package_names(workspace_root)

    print(f"📂 Found {len(package_dirs)} Python packages")
    print(f"🏷️  Found {len(elizaos_packages)} elizaos package names\n")

    total_packages = 0
    total_deps = 0

    for pkg_dir in package_dirs:
        pyproject = pkg_dir / "pyproject.toml"
        pkg_dir_rel = pkg_dir.relative_to(workspace_root)

        print(f"📦 {pkg_dir_rel}")

        # Update package version
        if update_pyproject_version(pyproject, version, args.dry_run):
            total_packages += 1

        # Update dependencies
        deps_updated = update_pyproject_dependencies(
            pyproject, version, elizaos_packages, args.dry_run
        )
        total_deps += deps_updated

        # Update __init__.py __version__
        update_init_version(pkg_dir, version, args.dry_run)

    print(f"\n✅ Done! Updated {total_packages} packages and {total_deps} dependency constraints.")

    if args.dry_run:
        print("\n💡 Run without --dry-run to apply changes.")


if __name__ == "__main__":
    main()
