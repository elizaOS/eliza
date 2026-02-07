"""ZCA CLI client wrapper."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import subprocess
from dataclasses import dataclass
from typing import Any, TypeVar

from elizaos_plugin_zalouser.config import DEFAULT_TIMEOUT_MS, ZCA_BINARY
from elizaos_plugin_zalouser.error import InvalidArgumentError, SendError
from elizaos_plugin_zalouser.types import ZaloFriend, ZaloGroup, ZaloUserInfo

logger = logging.getLogger(__name__)

T = TypeVar("T")


@dataclass
class ZcaRunOptions:
    """Options for running ZCA commands."""

    profile: str | None = None
    cwd: str | None = None
    timeout_ms: int | None = None


@dataclass
class ZcaResult:
    """Result from a ZCA command execution."""

    ok: bool
    stdout: str
    stderr: str
    exit_code: int


def _build_args(args: list[str], options: ZcaRunOptions | None = None) -> list[str]:
    """Build command arguments with profile flag."""
    import os

    result: list[str] = []

    # Profile flag comes first
    if options and options.profile:
        result.extend(["--profile", options.profile])
    elif profile := os.environ.get("ZCA_PROFILE"):
        result.extend(["--profile", profile])

    result.extend(args)
    return result


def _strip_ansi(text: str) -> str:
    """Strip ANSI escape codes from a string."""
    return re.sub(r"\x1B\[[0-9;]*[a-zA-Z]", "", text)


def parse_json_output(stdout: str, model: type[T] | None = None) -> T | dict[str, Any] | list[Any] | None:
    """Parse JSON from ZCA output, handling ANSI codes and log prefixes."""
    # Try direct parse first
    try:
        data = json.loads(stdout)
        if model:
            return model.model_validate(data)  # type: ignore[attr-defined]
        return data  # type: ignore[return-value]
    except (json.JSONDecodeError, Exception):
        pass

    # Try with ANSI stripped
    cleaned = _strip_ansi(stdout)
    try:
        data = json.loads(cleaned)
        if model:
            return model.model_validate(data)  # type: ignore[attr-defined]
        return data  # type: ignore[return-value]
    except (json.JSONDecodeError, Exception):
        pass

    # Try to find JSON in output (may have log prefixes)
    for i, line in enumerate(cleaned.split("\n")):
        trimmed = line.strip()
        if trimmed.startswith("{") or trimmed.startswith("["):
            try:
                data = json.loads(trimmed)
                if model:
                    return model.model_validate(data)  # type: ignore[attr-defined]
                return data  # type: ignore[return-value]
            except (json.JSONDecodeError, Exception):
                pass

            # Try from this line to end
            json_candidate = "\n".join(cleaned.split("\n")[i:]).strip()
            try:
                data = json.loads(json_candidate)
                if model:
                    return model.model_validate(data)  # type: ignore[attr-defined]
                return data  # type: ignore[return-value]
            except (json.JSONDecodeError, Exception):
                pass

    return None


async def run_zca(args: list[str], options: ZcaRunOptions | None = None) -> ZcaResult:
    """Run a ZCA CLI command."""
    options = options or ZcaRunOptions()
    full_args = _build_args(args, options)
    timeout_s = (options.timeout_ms or DEFAULT_TIMEOUT_MS) / 1000

    try:
        proc = await asyncio.create_subprocess_exec(
            ZCA_BINARY,
            *full_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=options.cwd,
        )

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(), timeout=timeout_s
            )
            return ZcaResult(
                ok=proc.returncode == 0,
                stdout=stdout_bytes.decode().strip(),
                stderr=stderr_bytes.decode().strip(),
                exit_code=proc.returncode or 1,
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return ZcaResult(
                ok=False,
                stdout="",
                stderr="Command timed out",
                exit_code=124,
            )
    except FileNotFoundError:
        return ZcaResult(
            ok=False,
            stdout="",
            stderr=f"{ZCA_BINARY} not found in PATH",
            exit_code=1,
        )
    except Exception as e:
        return ZcaResult(
            ok=False,
            stdout="",
            stderr=str(e),
            exit_code=1,
        )


async def check_zca_installed() -> bool:
    """Check if zca-cli is installed."""
    result = await run_zca(["--version"], ZcaRunOptions(timeout_ms=5000))
    return result.ok


async def check_zca_authenticated(profile: str | None = None) -> bool:
    """Check if authenticated for a profile."""
    result = await run_zca(
        ["auth", "status"],
        ZcaRunOptions(profile=profile, timeout_ms=5000),
    )
    return result.ok


async def get_zca_user_info(profile: str | None = None) -> ZaloUserInfo | None:
    """Get authenticated user info."""
    result = await run_zca(
        ["me", "info", "-j"],
        ZcaRunOptions(profile=profile, timeout_ms=10000),
    )

    if not result.ok:
        return None

    data = parse_json_output(result.stdout)
    if data and isinstance(data, dict):
        return ZaloUserInfo.model_validate(data)
    return None


async def list_friends(profile: str | None = None, query: str | None = None) -> list[ZaloFriend]:
    """List friends."""
    args = ["friend", "find", query] if query and query.strip() else ["friend", "list", "-j"]
    result = await run_zca(args, ZcaRunOptions(profile=profile, timeout_ms=15000))

    if not result.ok:
        return []

    data = parse_json_output(result.stdout)
    if data and isinstance(data, list):
        return [ZaloFriend.model_validate(item) for item in data]
    return []


async def list_groups(profile: str | None = None) -> list[ZaloGroup]:
    """List groups."""
    result = await run_zca(
        ["group", "list", "-j"],
        ZcaRunOptions(profile=profile, timeout_ms=15000),
    )

    if not result.ok:
        return []

    data = parse_json_output(result.stdout)
    if data and isinstance(data, list):
        return [ZaloGroup.model_validate(item) for item in data]
    return []


def _extract_message_id(stdout: str) -> str | None:
    """Extract message ID from ZCA output."""
    # Try message_id pattern
    match = re.search(r"message[_\s]?id[:\s]+(\S+)", stdout, re.IGNORECASE)
    if match:
        return match.group(1)

    # Return first word if it looks like an ID
    first_word = stdout.strip().split()[0] if stdout.strip() else None
    if first_word and re.match(r"^[a-zA-Z0-9_-]+$", first_word):
        return first_word

    return None


async def send_message(
    thread_id: str,
    text: str,
    profile: str | None = None,
    is_group: bool = False,
) -> tuple[bool, str | None, str | None]:
    """Send a text message. Returns (ok, message_id, error)."""
    if not thread_id or not thread_id.strip():
        raise InvalidArgumentError("No thread ID provided")

    truncated = text[:2000] if len(text) > 2000 else text
    args = ["msg", "send", thread_id.strip(), truncated]
    if is_group:
        args.append("-g")

    result = await run_zca(args, ZcaRunOptions(profile=profile))

    if result.ok:
        return (True, _extract_message_id(result.stdout), None)
    return (False, None, result.stderr or "Failed to send message")


async def send_image(
    thread_id: str,
    image_url: str,
    caption: str | None = None,
    profile: str | None = None,
    is_group: bool = False,
) -> tuple[bool, str | None, str | None]:
    """Send an image message. Returns (ok, message_id, error)."""
    args = ["msg", "image", thread_id.strip(), "-u", image_url.strip()]
    if caption:
        args.extend(["-m", caption[:2000]])
    if is_group:
        args.append("-g")

    result = await run_zca(args, ZcaRunOptions(profile=profile))

    if result.ok:
        return (True, _extract_message_id(result.stdout), None)
    return (False, None, result.stderr or "Failed to send image")


async def send_link(
    thread_id: str,
    url: str,
    profile: str | None = None,
    is_group: bool = False,
) -> tuple[bool, str | None, str | None]:
    """Send a link message. Returns (ok, message_id, error)."""
    args = ["msg", "link", thread_id.strip(), url.strip()]
    if is_group:
        args.append("-g")

    result = await run_zca(args, ZcaRunOptions(profile=profile))

    if result.ok:
        return (True, _extract_message_id(result.stdout), None)
    return (False, None, result.stderr or "Failed to send link")
