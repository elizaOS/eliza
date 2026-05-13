#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors

"""Phase 0 VM-harness input + assertion driver.

Drives the in-VM guest over **SSH** (port 2222 forwarded by boot.sh) and
captures screenshots via QMP. We dropped the virtio-serial path because
QEMU's `wait=off` chardev returns EOF to the guest as soon as the host
client disconnects, and inject.py is a short-lived one-shot per call —
the listener never actually got the data.

SSH-based path: each command opens a fresh SSH session against the eliza
user, runs the in-VM action (wtype / grim / a wait loop over the
manifest path), and exits. The listener service still exists for /dev/
virtio-ports compatibility but the smoke harness no longer depends on it.

Usage:
  inject.py screenshot <output-png>             # via QMP
  inject.py wait-port <port> <seconds>          # TCP open probe
  inject.py type "<text>"                       # wtype via SSH
  inject.py submit                              # Return key via SSH
  inject.py wait-for <selector> <timeout-ms>    # poll ~/.eliza/apps/<slug>/manifest.json via SSH
  inject.py guest-screenshot <tag>              # grim via SSH → /var/tmp/usbeliza-screenshots
  inject.py ping                                # SSH true (verifies session)
  inject.py click "<selector>"                  # Phase 1 placeholder

Exit codes:
  0 — assertion passed
  2 — usage error
  3 — assertion failed
  4 — VM not reachable
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
QMP_SOCK = REPO_ROOT / "vm/snapshots/qmp.sock"
INPUT_SOCK = REPO_ROOT / "vm/snapshots/input.sock"  # unused now; kept for compatibility
SSH_KEY = REPO_ROOT / "vm/.ssh/usbeliza_dev_ed25519"
SSH_PORT = 2222
SSH_USER = "eliza"
SSH_HOST = "127.0.0.1"


def _ssh(cmd: str, *, timeout: int = 30) -> int:
    """Run `cmd` in the guest via SSH. Returns the remote exit code."""
    if not SSH_KEY.exists():
        sys.exit(f"error: SSH key missing at {SSH_KEY}; run `just vm-build-base` to regenerate.")
    args = [
        "ssh",
        "-i",
        str(SSH_KEY),
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "LogLevel=ERROR",
        "-o",
        f"ConnectTimeout={timeout}",
        "-p",
        str(SSH_PORT),
        f"{SSH_USER}@{SSH_HOST}",
        cmd,
    ]
    return subprocess.run(args, check=False).returncode


def _shquote(text: str) -> str:
    """Single-quote escape for safe shell embedding."""
    return "'" + text.replace("'", "'\\''") + "'"


def _qmp_command(method: str, args: dict | None = None) -> dict:
    """Send a single QMP command and return the JSON response."""
    if not QMP_SOCK.exists():
        sys.exit(f"error: QMP socket not present at {QMP_SOCK}; is the VM up?")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.connect(str(QMP_SOCK))
        sock_file = sock.makefile("rwb")
        # QMP greeting.
        sock_file.readline()
        # Capabilities handshake.
        sock_file.write(b'{"execute":"qmp_capabilities"}\n')
        sock_file.flush()
        sock_file.readline()
        # Real command.
        payload = {"execute": method}
        if args is not None:
            payload["arguments"] = args
        sock_file.write((json.dumps(payload) + "\n").encode("utf-8"))
        sock_file.flush()
        return json.loads(sock_file.readline().decode("utf-8"))


def cmd_screenshot(output: Path) -> int:
    """Capture a PNG via QMP `screendump`."""
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    response = _qmp_command(
        "screendump",
        {"filename": str(output), "format": "png"},
    )
    if "error" in response:
        print(f"QMP error: {response['error']}", file=sys.stderr)
        return 4
    print(f"screenshot saved to {output}")
    return 0


def cmd_type(text: str) -> int:
    """Type `text` into the focused Wayland window via wtype (over SSH).

    Auto-detects the running wayland-N socket inside the guest and exports
    WAYLAND_DISPLAY accordingly — sway picked wayland-0 or wayland-1
    depending on whether PAM scrubbed the env we tried to pin earlier.
    """
    quoted = _shquote(text)
    remote = (
        "export XDG_RUNTIME_DIR=/run/user/1000; "
        "for s in $XDG_RUNTIME_DIR/wayland-[0-9]*; do "
        '  [ -S "$s" ] && export WAYLAND_DISPLAY=$(basename "$s") && break; '
        "done; "
        f"wtype {quoted}"
    )
    return _ssh(remote)


def cmd_submit() -> int:
    """Press Return in the focused window."""
    remote = (
        "export XDG_RUNTIME_DIR=/run/user/1000; "
        "for s in $XDG_RUNTIME_DIR/wayland-[0-9]*; do "
        '  [ -S "$s" ] && export WAYLAND_DISPLAY=$(basename "$s") && break; '
        "done; "
        "wtype -k Return"
    )
    return _ssh(remote)


def cmd_wait_for(selector: str, timeout_ms: int) -> int:
    """Poll the guest filesystem for the selector marker."""
    deadline_s = max(1, timeout_ms // 1000)
    if selector.startswith("file:"):
        target = selector.removeprefix("file:")
    else:
        target = f"/home/eliza/.eliza/apps/{selector}/manifest.json"
    remote = (
        f"deadline=$(({deadline_s} + $(date +%s))); "
        f'while [ "$(date +%s)" -lt "$deadline" ]; do '
        f'  [ -f {_shquote(target)} ] && exit 0; '
        f"  sleep 1; "
        f"done; "
        f"exit 3"
    )
    return _ssh(remote, timeout=deadline_s + 10)


def cmd_guest_screenshot(tag: str) -> int:
    """grim → /var/tmp/usbeliza-screenshots/<ts>-<tag>.png inside the guest."""
    safe_tag = "".join(c for c in tag if c.isalnum() or c in "-_") or "screen"
    remote = (
        "sudo install -d -m 0777 /var/tmp/usbeliza-screenshots && "
        "export XDG_RUNTIME_DIR=/run/user/1000 && "
        "for s in $XDG_RUNTIME_DIR/wayland-[0-9]*; do "
        '  [ -S "$s" ] && export WAYLAND_DISPLAY=$(basename "$s") && break; '
        "done && "
        f"grim /var/tmp/usbeliza-screenshots/$(date +%s)-{safe_tag}.png"
    )
    return _ssh(remote)


def cmd_ping() -> int:
    """Verify SSH session is alive."""
    return _ssh("true")


def cmd_click(_selector: str) -> int:
    """Phase 0 placeholder. Webview-level click lands when CDP is wired."""
    sys.stderr.write("click is a Phase 1 affordance; no-op for now\n")
    return 0


def cmd_wait_port(port: int, deadline_seconds: int) -> int:
    """Wait up to `deadline_seconds` for `localhost:<port>` to accept connections.

    Used to probe SSH (forwarded as 2222 in boot.sh) so callers know the VM is up.
    """
    deadline = time.time() + deadline_seconds
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=2):
                return 0
        except (ConnectionRefusedError, socket.timeout, OSError):
            time.sleep(1)
    return 3


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        sys.stderr.write(__doc__ or "")
        return 2

    command = argv[1]
    if command == "screenshot":
        if len(argv) != 3:
            return 2
        return cmd_screenshot(Path(argv[2]))
    if command == "wait-port":
        if len(argv) != 4:
            return 2
        return cmd_wait_port(int(argv[2]), int(argv[3]))
    if command == "type":
        if len(argv) != 3:
            return 2
        return cmd_type(argv[2])
    if command == "submit":
        if len(argv) != 2:
            return 2
        return cmd_submit()
    if command == "wait-for":
        if len(argv) != 4:
            return 2
        return cmd_wait_for(argv[2], int(argv[3]))
    if command == "guest-screenshot":
        if len(argv) != 3:
            return 2
        return cmd_guest_screenshot(argv[2])
    if command == "ping":
        if len(argv) != 2:
            return 2
        return cmd_ping()
    if command == "click":
        if len(argv) != 3:
            return 2
        return cmd_click(argv[2])

    sys.stderr.write(f"unknown command: {command}\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
