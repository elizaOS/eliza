#!/usr/bin/env python3
"""Run pinned speech tooling in an explicit writable consumer workspace."""
import argparse
import fcntl
from pathlib import Path
import subprocess
import sys

source = Path(__file__).resolve().parent
commands = ('acquire-downloads', 'make-lexicon', 'build-no-espeak', 'verify-source',
            'strip-runtime', 'prepare-assets', 'assemble-runtime', 'install-generated')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--workspace', required=True)
parser.add_argument('command', choices=commands)
args, forwarded = parser.parse_known_args()
workspace = Path(args.workspace).resolve()
if workspace == source or workspace.is_relative_to(source) or source.is_relative_to(workspace):
    parser.error('Workspace must be separate from the pinned tooling source')
workspace.mkdir(parents=True, exist_ok=True)
lock = workspace / '.tooling.lock'
if lock.is_symlink():
    raise ValueError('Workspace lock must not be a symlink')
with lock.open('a') as handle:
    # One command owns each staging directory; parallel ABIs use separate workspaces.
    fcntl.flock(handle, fcntl.LOCK_EX)
    for item in source.iterdir():
        if item.name == 'run.py' or item.suffix not in ('.py', '.json', '.patch'):
            continue
        if not item.is_file() or item.is_symlink():
            raise ValueError('Tooling input must be a regular file')
        target = workspace / item.name
        if target.is_symlink():
            raise ValueError('Tooling destination must not be a symlink')
        target.write_bytes(item.read_bytes())
    subprocess.run([sys.executable, str(workspace / (args.command + '.py')), *forwarded], check=True)
