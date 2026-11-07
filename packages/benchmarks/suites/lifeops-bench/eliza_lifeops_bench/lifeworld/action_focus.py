"""LifeWorld focus action semantics."""

from __future__ import annotations
import re
from copy import deepcopy
from typing import Any, cast
from .world import LifeWorld
from .entities import EntityKind
from .entities import FocusBlock
from .action_common import (
    UnsupportedAction,
    _shift_iso,
    _string_list,
    _synthetic_id,
    _try_parse_iso,
)

_FOCUS_SUBACTION_BY_NAME = {
    "BLOCK_BLOCK": "block",
    "BLOCK_UNBLOCK": "unblock",
    "BLOCK_LIST_ACTIVE": "list_active",
    "BLOCK_RELEASE": "release",
    "BLOCK_STATUS": "status",
    "BLOCK_REQUEST_PERMISSION": "request_permission",
}


_FOCUS_HOSTNAME_RE = re.compile(
    r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?",
    flags=re.IGNORECASE,
)


_FOCUS_PACKAGE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}")


def _focus_subaction(kw: dict[str, Any], name: str) -> str:
    raw = kw.get("subaction") or kw.get("action") or _FOCUS_SUBACTION_BY_NAME.get(name)
    if raw is None and name == "BLOCK":
        raw = "block"
    if raw not in {
        "block",
        "unblock",
        "list_active",
        "release",
        "status",
        "request_permission",
    }:
        raise UnsupportedAction(f"unsupported action in execute path: BLOCK/{raw}")
    return cast(str, raw)


def _focus_targets(kw: dict[str, Any]) -> tuple[list[str], list[str]]:
    raw_hostnames = [
        *_string_list(kw.get("hostnames")),
        *_string_list(kw.get("hostname")),
        *_string_list(kw.get("websites")),
    ]
    raw_packages = [
        *_string_list(kw.get("packageNames")),
        *_string_list(kw.get("package_names")),
        *_string_list(kw.get("apps")),
        *_string_list(kw.get("bundle_ids")),
        *_string_list(kw.get("bundle_id")),
        *_string_list(kw.get("app_name")),
        *_string_list(kw.get("identifier")),
    ]
    hostnames = sorted({item.casefold().rstrip(".") for item in raw_hostnames})
    package_names = sorted(set(raw_packages))
    invalid_hosts = [
        hostname
        for hostname in hostnames
        if _FOCUS_HOSTNAME_RE.fullmatch(hostname) is None
    ]
    invalid_packages = [
        package_name
        for package_name in package_names
        if _FOCUS_PACKAGE_RE.fullmatch(package_name) is None
    ]
    if invalid_hosts:
        raise ValueError(f"BLOCK has invalid hostnames: {invalid_hosts}")
    if invalid_packages:
        raise ValueError(f"BLOCK has invalid package names: {invalid_packages}")
    return hostnames, package_names


def _focus_schedule(
    kw: dict[str, Any],
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    raw_schedule = kw.get("schedule")
    if raw_schedule is not None and not isinstance(raw_schedule, dict):
        raise ValueError("BLOCK schedule must be an object")
    schedule = deepcopy(raw_schedule) if isinstance(raw_schedule, dict) else None
    if schedule is not None:
        weekdays = schedule.get("weekdays")
        if not isinstance(weekdays, list) or not weekdays:
            raise ValueError("BLOCK schedule.weekdays must be a non-empty list")
        if any(
            isinstance(day, bool) or not isinstance(day, int) or not 1 <= day <= 7
            for day in weekdays
        ):
            raise ValueError(
                "BLOCK schedule weekdays must be integers from 1 through 7"
            )
        for field in ("start", "end"):
            value = schedule.get(field)
            if (
                not isinstance(value, str)
                or re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value) is None
            ):
                raise ValueError(f"BLOCK schedule.{field} must be HH:MM")
        schedule["weekdays"] = sorted(set(weekdays))

    raw_exceptions = kw.get("exceptions", [])
    if not isinstance(raw_exceptions, list) or any(
        not isinstance(item, dict) for item in raw_exceptions
    ):
        raise ValueError("BLOCK exceptions must be a list of objects")
    return schedule, [deepcopy(item) for item in raw_exceptions]


def _focus_effective_status(block: FocusBlock, now_iso: str) -> str:
    if block.status != "active" or block.expires_at is None:
        return block.status
    expires_at = _try_parse_iso(block.expires_at)
    now = _try_parse_iso(now_iso)
    if expires_at is None or now is None:
        raise ValueError(f"focus block {block.id} has an invalid timestamp")
    return "expired" if expires_at <= now else "active"


def _focus_block_projection(block: FocusBlock, now_iso: str) -> dict[str, Any]:
    return {
        "id": block.id,
        "hostnames": list(block.hostnames),
        "packageNames": list(block.package_names),
        "status": block.status,
        "effectiveStatus": _focus_effective_status(block, now_iso),
        "mode": block.mode,
        "durationMinutes": block.duration_minutes,
        "schedule": deepcopy(block.schedule),
        "exceptions": deepcopy(block.exceptions),
        "policy": block.policy,
        "permissionRequestId": block.permission_request_id,
        "createdAt": block.created_at,
        "updatedAt": block.updated_at,
        "expiresAt": block.expires_at,
        "releasedAt": block.released_at,
        "releaseReason": block.release_reason,
    }


def _u_block(world: LifeWorld, kw: dict[str, Any], name: str) -> dict[str, Any]:
    """Apply the BLOCK family against typed focus rules and approval requests."""
    subaction = _focus_subaction(kw, name)
    operation = f"BLOCK/{subaction}"

    if subaction == "list_active":
        include_scheduled = kw.get("includeScheduled") is True
        blocks = [
            block
            for block in world.focus_blocks.values()
            if _focus_effective_status(block, world.now_iso) == "active"
            or (include_scheduled and block.status == "scheduled")
        ]
        blocks.sort(key=lambda item: item.id)
        return {
            "ok": True,
            "effect": "none",
            "operation": operation,
            "count": len(blocks),
            "blocks": [
                _focus_block_projection(block, world.now_iso) for block in blocks
            ],
        }

    if subaction == "status":
        rule_id = kw.get("ruleId") or kw.get("rule_id") or kw.get("id")
        if rule_id is not None and (
            not isinstance(rule_id, str) or not rule_id.strip()
        ):
            raise ValueError("BLOCK/status ruleId must be a non-empty string")
        if isinstance(rule_id, str):
            block = world.focus_blocks.get(rule_id)
            return {
                "ok": True,
                "effect": "none",
                "operation": operation,
                "found": block is not None,
                "block": (
                    _focus_block_projection(block, world.now_iso)
                    if block is not None
                    else None
                ),
            }
        scope = kw.get("scope")
        if scope not in {None, "active_focus"}:
            raise ValueError(f"BLOCK/status has unsupported scope: {scope!r}")
        blocks = sorted(world.focus_blocks.values(), key=lambda item: item.id)
        return {
            "ok": True,
            "effect": "none",
            "operation": operation,
            "scope": scope or "all",
            "blocks": [
                _focus_block_projection(block, world.now_iso) for block in blocks
            ],
        }

    hostnames, package_names = _focus_targets(kw)
    if subaction in {"block", "request_permission"} and not (
        hostnames or package_names
    ):
        raise ValueError(f"BLOCK/{subaction} requires hostnames or packageNames")

    mode_raw = kw.get("mode")
    if mode_raw is not None and (not isinstance(mode_raw, str) or not mode_raw.strip()):
        raise ValueError("BLOCK mode must be a non-empty string")
    mode = mode_raw.strip() if isinstance(mode_raw, str) else None

    if subaction == "request_permission":
        reason_raw = kw.get("reason") or kw.get("intent")
        if not isinstance(reason_raw, str) or not reason_raw.strip():
            raise ValueError("BLOCK/request_permission requires a reason")
        reason = reason_raw.strip()
        confirmation_required = kw.get("confirmationRequired", True)
        no_bypass = kw.get("noBypass", False)
        if not isinstance(confirmation_required, bool) or not isinstance(
            no_bypass, bool
        ):
            raise ValueError(
                "BLOCK permission flags confirmationRequired/noBypass must be booleans"
            )
        request_id_raw = kw.get("requestId") or kw.get("request_id")
        if request_id_raw is not None and (
            not isinstance(request_id_raw, str) or not request_id_raw.strip()
        ):
            raise ValueError("BLOCK requestId must be a non-empty string")
        request_id = (
            request_id_raw.strip()
            if isinstance(request_id_raw, str)
            else _synthetic_id(
                "focus_permission",
                {
                    "hostnames": hostnames,
                    "packageNames": package_names,
                    "reason": reason,
                    "mode": mode,
                    "confirmationRequired": confirmation_required,
                    "noBypass": no_bypass,
                },
            )
        )
        request, replayed = world.create_focus_permission_request(
            request_id=request_id,
            hostnames=hostnames,
            package_names=package_names,
            reason=reason,
            confirmation_required=confirmation_required,
            no_bypass=no_bypass,
            mode=mode,
        )
        return {
            "ok": True,
            "effect": "none" if replayed else "applied",
            "operation": operation,
            "replayed": replayed,
            "request": {
                "id": request.id,
                "status": request.status,
                "hostnames": list(request.hostnames),
                "packageNames": list(request.package_names),
                "reason": request.reason,
                "mode": request.mode,
                "confirmationRequired": request.confirmation_required,
                "noBypass": request.no_bypass,
                "createdAt": request.created_at,
            },
        }

    if subaction == "block":
        if kw.get("confirmed") is False:
            raise PermissionError("BLOCK/block requires confirmation")
        duration_raw = kw.get("durationMinutes")
        if duration_raw is not None and (
            isinstance(duration_raw, bool)
            or not isinstance(duration_raw, int)
            or duration_raw <= 0
        ):
            raise ValueError("BLOCK durationMinutes must be a positive integer")
        duration_minutes = cast(int | None, duration_raw)
        schedule, exceptions = _focus_schedule(kw)
        policy_raw = kw.get("policy")
        if policy_raw is not None and (
            not isinstance(policy_raw, str) or not policy_raw.strip()
        ):
            raise ValueError("BLOCK policy must be a non-empty string")
        policy = policy_raw.strip() if isinstance(policy_raw, str) else None
        matching_permission = next(
            (
                request
                for request in sorted(
                    world.focus_permission_requests.values(),
                    key=lambda item: item.id,
                )
                if request.hostnames == hostnames
                and request.package_names == package_names
                and request.mode == mode
                and request.status in {"pending", "approved"}
            ),
            None,
        )
        if (mode == "harsh" or kw.get("noBypass") is True) and (
            matching_permission is None or kw.get("confirmed") is not True
        ):
            raise PermissionError(
                "BLOCK harsh/no-bypass rules require a matching permission request "
                "and confirmed=True"
            )
        block_id_raw = kw.get("ruleId") or kw.get("rule_id") or kw.get("id")
        if block_id_raw is not None and (
            not isinstance(block_id_raw, str) or not block_id_raw.strip()
        ):
            raise ValueError("BLOCK ruleId must be a non-empty string")
        identity = {
            "hostnames": hostnames,
            "packageNames": package_names,
            "mode": mode,
            "durationMinutes": duration_minutes,
            "schedule": schedule,
            "exceptions": exceptions,
            "policy": policy,
            "permissionRequestId": (
                matching_permission.id if matching_permission is not None else None
            ),
        }
        block_id = (
            block_id_raw.strip()
            if isinstance(block_id_raw, str)
            else _synthetic_id("focus_rule", identity)
        )
        block, replayed = world.create_focus_block(
            block_id=block_id,
            hostnames=hostnames,
            package_names=package_names,
            status="scheduled" if schedule is not None else "active",
            mode=mode,
            duration_minutes=duration_minutes,
            schedule=schedule,
            exceptions=exceptions,
            policy=policy,
            permission_request_id=(
                matching_permission.id if matching_permission is not None else None
            ),
            expires_at=(
                _shift_iso(world.now_iso, minutes=duration_minutes)
                if duration_minutes is not None
                else None
            ),
        )
        if matching_permission is not None and matching_permission.status == "pending":
            world.update(
                EntityKind.FOCUS_PERMISSION_REQUEST,
                matching_permission.id,
                status="approved",
                updated_at=world.now_iso,
            )
        return {
            "ok": True,
            "effect": "none" if replayed else "applied",
            "operation": operation,
            "replayed": replayed,
            "block": _focus_block_projection(block, world.now_iso),
        }

    if kw.get("confirmed") is not True:
        raise PermissionError(f"BLOCK/{subaction} requires confirmed=True")
    rule_id = kw.get("ruleId") or kw.get("rule_id") or kw.get("id")
    if rule_id is not None and (not isinstance(rule_id, str) or not rule_id.strip()):
        raise ValueError(f"BLOCK/{subaction} ruleId must be a non-empty string")
    if isinstance(rule_id, str) and (hostnames or package_names):
        raise ValueError(
            f"BLOCK/{subaction} accepts either ruleId or explicit targets, not both"
        )
    if isinstance(rule_id, str):
        matching_ids = [rule_id]
    elif hostnames or package_names:
        matching_ids = sorted(
            block.id
            for block in world.focus_blocks.values()
            if set(block.hostnames).intersection(hostnames)
            or set(block.package_names).intersection(package_names)
        )
    else:
        matching_ids = sorted(
            block.id
            for block in world.focus_blocks.values()
            if block.status in {"active", "scheduled"}
        )
    if not matching_ids:
        raise KeyError(f"BLOCK/{subaction} matched no focus rules")
    reason_raw = kw.get("reason") or kw.get("intent") or subaction
    if not isinstance(reason_raw, str) or not reason_raw.strip():
        raise ValueError(f"BLOCK/{subaction} reason must be a non-empty string")
    released, replayed = world.release_focus_blocks(
        matching_ids,
        reason=reason_raw.strip(),
    )
    return {
        "ok": True,
        "effect": "applied" if released else "none",
        "operation": operation,
        "replayed": not released and bool(replayed),
        "released": [
            _focus_block_projection(block, world.now_iso) for block in released
        ],
        "alreadyReleased": [
            _focus_block_projection(block, world.now_iso) for block in replayed
        ],
    }
