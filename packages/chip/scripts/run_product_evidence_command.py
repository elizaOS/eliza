#!/usr/bin/env python3
"""List or run repo-local evidence commands declared in artifact manifests."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFESTS = [
    "board/fpga/artifact-manifest.yaml",
    "board/kicad/e1-demo/artifact-manifest.yaml",
    "board/kicad/e1-phone/artifact-manifest.yaml",
    "docs/manufacturing/artifact-manifest.yaml",
    "package/artifact-manifest.yaml",
]


def load_manifest(path: Path) -> dict:
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, dict):
        raise SystemExit(f"{path.relative_to(ROOT)} must be a YAML mapping")
    return data


def collect_commands(manifest_paths: list[str]) -> dict[str, str]:
    commands: dict[str, str] = {}
    for manifest_path in manifest_paths:
        path = ROOT / manifest_path
        if not path.is_file():
            raise SystemExit(f"missing manifest: {manifest_path}")
        manifest = load_manifest(path)
        manifest_name = str(manifest.get("manifest") or manifest_path)
        groups = manifest.get("artifact_groups", {})
        if not isinstance(groups, dict):
            continue
        for group_name, group in groups.items():
            if not isinstance(group, dict):
                continue
            group_commands = group.get("cli_commands", {})
            if not isinstance(group_commands, dict):
                continue
            for command_name, command in group_commands.items():
                if not isinstance(command, str) or not command.strip():
                    continue
                command_id = f"{manifest_name}.{group_name}.{command_name}"
                commands[command_id] = command
    return dict(sorted(commands.items()))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="List or run local evidence commands from product artifact manifests."
    )
    parser.add_argument(
        "--manifest",
        action="append",
        dest="manifests",
        help="manifest path to read; may be repeated",
    )
    parser.add_argument("--list", action="store_true", help="list available command ids")
    parser.add_argument("--command-id", help="run one command id from --list")
    parser.add_argument("--dry-run", action="store_true", help="print the selected command only")
    args = parser.parse_args()

    commands = collect_commands(args.manifests or DEFAULT_MANIFESTS)
    if args.list or not args.command_id:
        for command_id, command_text in commands.items():
            print(f"{command_id}: {command_text}")
        return 0

    command_id = str(args.command_id)
    selected_command = commands.get(command_id)
    if selected_command is None:
        print(f"unknown evidence command id: {command_id}", file=sys.stderr)
        print("run with --list to see available commands", file=sys.stderr)
        return 2

    print(selected_command)
    if args.dry_run:
        return 0
    return subprocess.run(selected_command, cwd=ROOT, shell=True, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
