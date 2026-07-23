"""Owns the Claude subscription gateway for one benchmark cohort.

The readiness file is a short-lived secret handoff: it is validated, read once,
and removed before any harness starts. Only a harness-specific bearer token is
passed to each worker, while the redacted audit remains as campaign evidence.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlparse


GATEWAY_PACKAGE = "claude-subscription-gateway"
DEFAULT_START_TIMEOUT_SECONDS = 60.0
DEFAULT_STOP_TIMEOUT_SECONDS = 30.0
FORBIDDEN_UPSTREAM_ENV: frozenset[str] = frozenset(
    {
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AWS_API_KEY",
        "ANTHROPIC_AWS_AUTH",
        "ANTHROPIC_AWS_BASE_URL",
        "ANTHROPIC_AWS_WORKSPACE_ID",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_BEDROCK_BASE_URL",
        "ANTHROPIC_BEDROCK_MANTLE_API_KEY",
        "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
        "ANTHROPIC_CUSTOM_HEADERS",
        "ANTHROPIC_FEDERATION_RULE_ID",
        "ANTHROPIC_FOUNDRY_API_KEY",
        "ANTHROPIC_FOUNDRY_BASE_URL",
        "ANTHROPIC_FOUNDRY_RESOURCE",
        "ANTHROPIC_IDENTITY_TOKEN",
        "ANTHROPIC_IDENTITY_TOKEN_FILE",
        "ANTHROPIC_PROFILE",
        "ANTHROPIC_SCOPE",
        "ANTHROPIC_SERVICE_ACCOUNT_ID",
        "ANTHROPIC_UNIX_SOCKET",
        "ANTHROPIC_VERTEX_BASE_URL",
        "ANTHROPIC_VERTEX_PROJECT_ID",
        "AWS_ACCESS_KEY_ID",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_CONFIG_FILE",
        "AWS_CONTAINER_CREDENTIALS_FULL_URI",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        "AWS_DEFAULT_PROFILE",
        "AWS_PROFILE",
        "AWS_ROLE_ARN",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_SHARED_CREDENTIALS_FILE",
        "AWS_WEB_IDENTITY_TOKEN_FILE",
        "AZURE_API_KEY",
        "AZURE_CLIENT_CERTIFICATE_PATH",
        "AZURE_CLIENT_ID",
        "AZURE_CLIENT_SECRET",
        "AZURE_OPENAI_API_KEY",
        "AZURE_TENANT_ID",
        "BEDROCK_AUTH",
        "CLAUDE_CODE_USE_ANTHROPIC_AWS",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_CCR_V2",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_USE_GATEWAY",
        "CLAUDE_CODE_USE_MANTLE",
        "CLAUDE_CODE_USE_VERTEX",
        "CLOUD_ML_REGION",
        "FOUNDRY_AUTH",
        "GCLOUD_PROJECT",
        "GOOGLE_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "VERTEX_AUTH",
    }
)
EXPECTED_TRANSPORT: dict[str, Any] = {
    "provider": "claude-agent-sdk",
    "sdk_version": "0.3.200",
    "credential_policy": "claude-code-oauth-only",
    "fresh_session_per_request": True,
    "tool_execution": "capture-only",
    "response_modes": ["json", "sse"],
}


class GatewayLifecycleError(RuntimeError):
    """Reports a redacted process/readiness contract failure."""

    def __init__(self, message: str, *, code: str = "gateway_lifecycle_error") -> None:
        super().__init__(message)
        self.code = code


class GatewayPauseStatus(StrEnum):
    PAUSED = "paused"
    PAUSED_UNKNOWN = "paused_unknown"


@dataclass(frozen=True)
class GatewayPauseState:
    """An unresolved, redacted quota state recovered from the public audit."""

    status: GatewayPauseStatus
    retry_at: str | None
    pause_reason: str
    affected_harnesses: tuple[str, ...]
    active_records: int


class GatewayProcess(Protocol):
    pid: int
    returncode: int | None

    def poll(self) -> int | None: ...

    def terminate(self) -> None: ...

    def kill(self) -> None: ...

    def wait(self, timeout: float | None = None) -> int: ...


PopenFactory = Callable[..., GatewayProcess]
AuthStatusRunner = Callable[..., subprocess.CompletedProcess[str]]


@dataclass(frozen=True)
class GatewayReadiness:
    origin: str
    base_url: str
    health_url: str
    transport: Mapping[str, Any]
    harness_tokens: Mapping[str, str]
    linked_pool_selectable: bool
    ambient_keychain_required: bool


@dataclass
class ClaudeSubscriptionGatewayProcess:
    """A running gateway plus its non-secret evidence locations."""

    process: GatewayProcess
    readiness: GatewayReadiness
    ready_file: Path
    audit_file: Path
    stdout_file: Path
    stderr_file: Path
    content_contract_file: Path | None
    _replay_file: Path
    _hmac_key_file: Path
    _stdout_handle: Any
    _stderr_handle: Any
    _stop_timeout_seconds: float = DEFAULT_STOP_TIMEOUT_SECONDS
    _closed: bool = False

    def env_for_harness(self, harness: str) -> dict[str, str]:
        normalized = _normalize_harness(harness)
        token = self.readiness.harness_tokens.get(normalized)
        if not isinstance(token, str) or not token:
            raise GatewayLifecycleError(
                f"Gateway readiness omitted the {normalized} harness lane"
            )
        return {
            "CLAUDE_SUBSCRIPTION_GATEWAY_URL": self.readiness.origin,
            "CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN": token,
            "BENCHMARK_BASE_URL": self.readiness.base_url,
            "OPENAI_BASE_URL": self.readiness.base_url,
            "OPENAI_API_KEY": token,
        }

    def close(self) -> Path:
        if self._closed:
            return self.audit_file
        self._closed = True
        try:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=self._stop_timeout_seconds)
                except subprocess.TimeoutExpired:
                    # error-policy:J6 a stuck evidence flush cannot leave the
                    # credential-bearing gateway process alive indefinitely.
                    self.process.kill()
                    self.process.wait(timeout=self._stop_timeout_seconds)
                    raise GatewayLifecycleError(
                        "Claude subscription gateway did not stop within its deadline"
                    )
            return_code = self.process.poll()
            if return_code not in (0, None):
                raise GatewayLifecycleError(
                    "Claude subscription gateway exited unsuccessfully; inspect "
                    f"{self.stderr_file}"
                )
            if not self.audit_file.is_file():
                raise GatewayLifecycleError(
                    "Claude subscription gateway stopped without its redacted audit"
                )
            if stat.S_IMODE(self.audit_file.stat().st_mode) != 0o600:
                raise GatewayLifecycleError(
                    "Claude subscription gateway audit permissions are not 0600"
                )
            _assert_private_if_present(self._replay_file, "replay checkpoint")
            _assert_private_if_present(self._hmac_key_file, "replay HMAC key")
            return self.audit_file
        finally:
            self.ready_file.unlink(missing_ok=True)
            if self.content_contract_file is not None:
                self.content_contract_file.unlink(missing_ok=True)
            self._stdout_handle.close()
            self._stderr_handle.close()

    def cleanup_private_checkpoint(self) -> None:
        """Remove replay secrets only after the cohort is durably successful."""

        if not self._closed:
            raise GatewayLifecycleError(
                "Gateway checkpoint cleanup requires a closed gateway"
            )
        self._replay_file.unlink(missing_ok=True)
        self._hmac_key_file.unlink(missing_ok=True)
        try:
            self._replay_file.parent.rmdir()
        except OSError:
            # error-policy:J6 the shared namespace directory may retain other
            # private evidence; successful secret-file removal is sufficient.
            pass

    def __enter__(self) -> ClaudeSubscriptionGatewayProcess:
        return self

    def __exit__(self, _exc_type: object, _exc: object, _traceback: object) -> None:
        self.close()


def start_claude_subscription_gateway(
    *,
    workspace_root: Path,
    run_group_id: str,
    harnesses: tuple[str, ...],
    start_timeout_seconds: float = DEFAULT_START_TIMEOUT_SECONDS,
    stop_timeout_seconds: float = DEFAULT_STOP_TIMEOUT_SECONDS,
    popen_factory: PopenFactory = subprocess.Popen,
    auth_status_runner: AuthStatusRunner = subprocess.run,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    content_attestation_contract: Mapping[str, Any] | None = None,
    benchmark_namespace: str | None = None,
    replay_file: Path | None = None,
    hmac_key_file: Path | None = None,
    storage_root: Path | None = None,
    minimum_free_bytes: int | None = None,
) -> ClaudeSubscriptionGatewayProcess:
    """Start an OAuth-only gateway and consume its one-time readiness secret."""

    normalized_harnesses = tuple(
        dict.fromkeys(_normalize_harness(harness) for harness in harnesses)
    )
    if not normalized_harnesses:
        raise ValueError("At least one harness is required for the gateway")
    if start_timeout_seconds <= 0 or stop_timeout_seconds <= 0:
        raise ValueError("Gateway lifecycle deadlines must be positive")
    normalized_namespace = (benchmark_namespace or run_group_id).strip()
    if not normalized_namespace:
        raise ValueError("Gateway benchmark namespace must be non-empty")
    if (storage_root is None) != (minimum_free_bytes is None):
        raise ValueError(
            "Gateway storage_root and minimum_free_bytes must be supplied together"
        )
    if (
        minimum_free_bytes is not None
        and (
            isinstance(minimum_free_bytes, bool)
            or not isinstance(minimum_free_bytes, int)
            or minimum_free_bytes < 0
        )
    ):
        raise ValueError("Gateway minimum_free_bytes must be a non-negative integer")

    package_root = workspace_root / "benchmarks" / GATEWAY_PACKAGE
    if not package_root.is_dir():
        raise GatewayLifecycleError(
            f"Claude subscription gateway package is missing at {package_root}"
        )
    process_root = (
        workspace_root
        / "benchmarks"
        / "benchmark_results"
        / run_group_id
        / "subscription-gateway"
    )
    process_root.mkdir(parents=True, exist_ok=True)
    ready_file = process_root / "readiness.json"
    audit_file = process_root / "audit.jsonl"
    stdout_file = process_root / "stdout.log"
    stderr_file = process_root / "stderr.log"
    content_contract_file = (
        process_root / "content-attestation-contract.json"
        if content_attestation_contract is not None
        else None
    )
    private_replay_file = replay_file or Path(f"{audit_file}.responses.jsonl")
    private_hmac_key_file = hmac_key_file or Path(
        f"{private_replay_file}.hmac-key"
    )
    private_replay_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    private_replay_file.parent.chmod(0o700)
    _assert_private_if_present(private_replay_file, "replay checkpoint")
    _assert_private_if_present(private_hmac_key_file, "replay HMAC key")
    ready_file.unlink(missing_ok=True)
    _assert_private_if_present(audit_file, "redacted audit")
    command = [
        "bun",
        "--no-env-file",
        str(package_root / "src" / "cli.ts"),
        "--ready-file",
        str(ready_file),
        "--audit-file",
        str(audit_file),
        "--benchmark-namespace",
        normalized_namespace,
        "--replay-file",
        str(private_replay_file),
        "--hmac-key-file",
        str(private_hmac_key_file),
    ]
    if storage_root is not None and minimum_free_bytes is not None:
        command.extend(
            [
                "--storage-root",
                str(storage_root),
                "--minimum-free-bytes",
                str(minimum_free_bytes),
            ]
        )
    if content_contract_file is not None:
        command.extend(
            ["--content-contract-file", str(content_contract_file)]
        )
    process_env = {
        key: value
        for key, value in os.environ.items()
        if key.upper() not in FORBIDDEN_UPSTREAM_ENV
    }
    stdout_handle: Any | None = None
    stderr_handle: Any | None = None
    process: GatewayProcess | None = None
    try:
        # Gateway process output may echo credential-adjacent diagnostics, so
        # the logs are private regardless of the operator's umask. The mode
        # argument only applies at creation; fchmod also covers a log file a
        # pre-hardening run left behind with wider permissions (process_root
        # is reused across runs and the handles append).
        stdout_handle = os.fdopen(
            os.open(stdout_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600),
            "ab",
        )
        os.fchmod(stdout_handle.fileno(), 0o600)
        stderr_handle = os.fdopen(
            os.open(stderr_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600),
            "ab",
        )
        os.fchmod(stderr_handle.fileno(), 0o600)
        if content_contract_file is not None:
            try:
                descriptor = os.open(
                    content_contract_file,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                )
                with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                    json.dump(
                        dict(content_attestation_contract or {}),
                        handle,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                    handle.write("\n")
                content_contract_file.chmod(0o600)
            except (OSError, TypeError, ValueError) as error:
                # error-policy:J2 invalid startup evidence cannot degrade to an
                # unattested gateway; retain a controlled lifecycle cause.
                raise GatewayLifecycleError(
                    "Claude subscription gateway content contract could not be staged",
                    code="gateway_content_contract_invalid",
                ) from error
        process = popen_factory(
            command,
            cwd=workspace_root.parent,
            env=process_env,
            stdin=subprocess.DEVNULL,
            stdout=stdout_handle,
            stderr=stderr_handle,
        )
        readiness = _wait_for_readiness(
            process=process,
            ready_file=ready_file,
            expected_harnesses=normalized_harnesses,
            timeout_seconds=start_timeout_seconds,
            monotonic=monotonic,
            sleep=sleep,
        )
        if readiness.ambient_keychain_required:
            _assert_claude_subscription_authenticated(
                environment=process_env,
                runner=auth_status_runner,
            )
        ready_file.unlink(missing_ok=True)
        if content_contract_file is not None:
            content_contract_file.unlink(missing_ok=True)
        return ClaudeSubscriptionGatewayProcess(
            process=process,
            readiness=readiness,
            ready_file=ready_file,
            audit_file=audit_file,
            stdout_file=stdout_file,
            stderr_file=stderr_file,
            content_contract_file=content_contract_file,
            _replay_file=private_replay_file,
            _hmac_key_file=private_hmac_key_file,
            _stdout_handle=stdout_handle,
            _stderr_handle=stderr_handle,
            _stop_timeout_seconds=stop_timeout_seconds,
        )
    except Exception:
        # error-policy:J1 startup is the process boundary; terminate before
        # surfacing a redacted lifecycle error to the campaign coordinator.
        ready_file.unlink(missing_ok=True)
        if content_contract_file is not None:
            content_contract_file.unlink(missing_ok=True)
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=stop_timeout_seconds)
            except subprocess.TimeoutExpired:
                # error-policy:J6 startup teardown escalates to a hard kill only
                # after the bounded graceful stop failed.
                process.kill()
                process.wait(timeout=stop_timeout_seconds)
        if stdout_handle is not None:
            stdout_handle.close()
        if stderr_handle is not None:
            stderr_handle.close()
        raise


def read_gateway_pause_state(audit_file: Path) -> GatewayPauseState | None:
    """Read unresolved pause rows from a validated append-only audit.

    A later success for the same logical key resolves an earlier pause. The
    private response journal is deliberately never read by the orchestrator.
    """

    if not audit_file.is_file():
        raise GatewayLifecycleError(
            "Claude subscription gateway audit is missing",
            code="gateway_audit_missing",
    )
    _assert_private_if_present(audit_file, "redacted audit")
    active: dict[str, tuple[str, str | None, str]] = {}
    invalid_pause_records = 0

    def visit_record(record: Mapping[str, Any]) -> None:
        nonlocal invalid_pause_records
        logical_key = record.get("logical_key_sha256")
        if not isinstance(logical_key, str) or not logical_key:
            invalid_pause_records += 1
            return
        status = record.get("status")
        if status == "succeeded":
            active.pop(logical_key, None)
            return
        if status != "paused":
            return
        harness = record.get("harness")
        reason = record.get("pause_reason")
        retry_at_raw = record.get("retry_at")
        if not isinstance(harness, str) or not harness.strip():
            invalid_pause_records += 1
            return
        normalized_harness = harness.strip().lower()
        if (
            record.get("error_code") == "subscription_rate_limited"
            and reason == "rate_limit"
        ):
            try:
                retry_at = _normalize_retry_at(retry_at_raw)
            except GatewayLifecycleError:
                invalid_pause_records += 1
                return
        elif (
            record.get("error_code") == "subscription_rate_limited"
            and reason == "rate_limit_unknown"
            and retry_at_raw is None
        ):
            retry_at = None
        elif (
            record.get("error_code") == "insufficient_storage"
            and reason == "storage_reserve"
            and retry_at_raw is None
        ):
            retry_at = None
        else:
            invalid_pause_records += 1
            return
        existing = active.get(logical_key)
        if existing is None and (
            len(active) >= 3
            or any(value[0] == normalized_harness for value in active.values())
        ):
            invalid_pause_records += 1
            return
        active[logical_key] = (
            normalized_harness,
            retry_at,
            str(reason),
        )

    from .subscription_provenance import scan_subscription_gateway_audit

    try:
        diagnostics = scan_subscription_gateway_audit(audit_file, visit_record)
    except OSError as error:
        raise GatewayLifecycleError(
            "Claude subscription gateway audit is unreadable",
            code="gateway_audit_unreadable",
        ) from error
    if (
        diagnostics.get("audit_file_exists") is not True
        or diagnostics.get("audit_read_error") is not False
        or diagnostics.get("audit_chain_mode") != "sha256-chain-v2"
        or diagnostics.get("invalid_json_lines") != 0
        or diagnostics.get("oversized_json_lines") != 0
        or diagnostics.get("invalid_contract_records") != 0
        or diagnostics.get("invalid_chain_records") != 0
        or diagnostics.get("audit_ignored_torn_tail_bytes") != 0
        or diagnostics.get("audit_ignored_torn_tail_oversized") is not False
        or invalid_pause_records != 0
    ):
        raise GatewayLifecycleError(
            "Claude subscription gateway audit failed integrity validation",
            code="gateway_audit_invalid",
        )
    if not active:
        return None
    values = tuple(active.values())
    harnesses = tuple(sorted({value[0] for value in values}))
    if any(value[2] == "storage_reserve" for value in values):
        return GatewayPauseState(
            status=GatewayPauseStatus.PAUSED_UNKNOWN,
            retry_at=None,
            pause_reason="storage_reserve",
            affected_harnesses=harnesses,
            active_records=len(values),
        )
    if any(value[1] is None for value in values):
        return GatewayPauseState(
            status=GatewayPauseStatus.PAUSED_UNKNOWN,
            retry_at=None,
            pause_reason="rate_limit_unknown",
            affected_harnesses=harnesses,
            active_records=len(values),
        )
    retry_at = max(str(value[1]) for value in values)
    return GatewayPauseState(
        status=GatewayPauseStatus.PAUSED,
        retry_at=retry_at,
        pause_reason="rate_limit",
        affected_harnesses=harnesses,
        active_records=len(values),
    )


def _normalize_retry_at(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GatewayLifecycleError(
            "Known gateway quota pause omitted retry_at",
            code="gateway_pause_invalid",
        )
    normalized = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise GatewayLifecycleError(
            "Gateway retry_at is not valid ISO-8601",
            code="gateway_pause_invalid",
        ) from error
    if parsed.tzinfo is None:
        raise GatewayLifecycleError(
            "Gateway retry_at must include a timezone",
            code="gateway_pause_invalid",
        )
    return parsed.astimezone(UTC).isoformat()


def _assert_private_if_present(path: Path, label: str) -> None:
    if path.exists() and stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise GatewayLifecycleError(
            f"Claude subscription gateway {label} permissions are not 0600"
        )


def _assert_claude_subscription_authenticated(
    *,
    environment: Mapping[str, str],
    runner: AuthStatusRunner,
) -> None:
    """Require a logged-in claude.ai subscription before any worker starts."""

    try:
        result = runner(
            ["claude", "auth", "status", "--json"],
            env=dict(environment),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=15.0,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        # error-policy:J2 the CLI authentication check is an external process
        # boundary; retain the cause while emitting only a fixed classification.
        raise GatewayLifecycleError(
            "Claude subscription authentication status is unavailable",
            code="claude_auth_status_unavailable",
        ) from error
    if result.returncode != 0:
        raise GatewayLifecycleError(
            "Claude subscription authentication status failed",
            code="claude_auth_status_failed",
        )
    try:
        payload = json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError) as error:
        # error-policy:J3 auth status is untrusted subprocess output; malformed
        # JSON is an explicit invalid signal and never falls back to readiness.
        raise GatewayLifecycleError(
            "Claude subscription authentication status is invalid",
            code="claude_auth_status_invalid",
        ) from error
    if not isinstance(payload, dict):
        raise GatewayLifecycleError(
            "Claude subscription authentication status is invalid",
            code="claude_auth_status_invalid",
        )
    subscription_type = payload.get("subscriptionType")
    if (
        payload.get("loggedIn") is not True
        or payload.get("authMethod") != "claude.ai"
        or not isinstance(subscription_type, str)
        or not subscription_type.strip()
    ):
        raise GatewayLifecycleError(
            "Claude Code is not authenticated with a claude.ai subscription",
            code="claude_subscription_not_authenticated",
        )


def _wait_for_readiness(
    *,
    process: GatewayProcess,
    ready_file: Path,
    expected_harnesses: tuple[str, ...],
    timeout_seconds: float,
    monotonic: Callable[[], float],
    sleep: Callable[[float], None],
) -> GatewayReadiness:
    deadline = monotonic() + timeout_seconds
    while monotonic() < deadline:
        return_code = process.poll()
        if return_code is not None:
            raise GatewayLifecycleError(
                "Claude subscription gateway exited before readiness"
            )
        if ready_file.is_file():
            return _parse_readiness(
                ready_file,
                expected_pid=process.pid,
                expected_harnesses=expected_harnesses,
            )
        sleep(0.05)
    raise GatewayLifecycleError(
        "Claude subscription gateway did not become ready within its deadline"
    )


def _parse_readiness(
    path: Path,
    *,
    expected_pid: int,
    expected_harnesses: tuple[str, ...],
) -> GatewayReadiness:
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise GatewayLifecycleError("Gateway readiness permissions are not 0600")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        # error-policy:J3 readiness is untrusted child-process output; an
        # unreadable payload is explicit invalid evidence.
        raise GatewayLifecycleError("Gateway readiness is not valid JSON") from error
    if not isinstance(payload, dict):
        raise GatewayLifecycleError("Gateway readiness must be a JSON object")
    if (
        payload.get("schema_version") != 1
        or payload.get("status") != "ready"
        or payload.get("pid") != expected_pid
    ):
        raise GatewayLifecycleError("Gateway readiness identity is invalid")

    origin = _require_loopback_url(payload.get("origin"), suffix="")
    base_url = _require_loopback_url(payload.get("base_url"), suffix="/v1")
    health_url = _require_loopback_url(payload.get("health_url"), suffix="/health")
    origin_parts = urlparse(origin)
    for candidate in (base_url, health_url):
        parts = urlparse(candidate)
        if (parts.scheme, parts.hostname, parts.port) != (
            origin_parts.scheme,
            origin_parts.hostname,
            origin_parts.port,
        ):
            raise GatewayLifecycleError(
                "Gateway readiness URLs do not share one loopback origin"
            )

    transport = payload.get("transport")
    if transport != EXPECTED_TRANSPORT:
        raise GatewayLifecycleError("Gateway readiness transport contract is invalid")
    tokens = payload.get("harness_tokens")
    if not isinstance(tokens, dict):
        raise GatewayLifecycleError("Gateway readiness omitted harness bearer lanes")
    normalized_tokens: dict[str, str] = {}
    for harness in expected_harnesses:
        token = tokens.get(harness)
        if not isinstance(token, str) or len(token) < 32:
            raise GatewayLifecycleError(
                f"Gateway readiness has an invalid {harness} bearer lane"
            )
        normalized_tokens[harness] = token
    if len(set(normalized_tokens.values())) != len(normalized_tokens):
        raise GatewayLifecycleError("Gateway harness bearer lanes are not unique")
    credential_readiness = payload.get("credential_readiness")
    if not isinstance(credential_readiness, dict):
        raise GatewayLifecycleError(
            "Gateway readiness omitted credential availability"
        )
    linked_pool_selectable = credential_readiness.get("linked_pool_selectable")
    ambient_keychain_required = credential_readiness.get(
        "ambient_keychain_required"
    )
    if (
        not isinstance(linked_pool_selectable, bool)
        or not isinstance(ambient_keychain_required, bool)
        or linked_pool_selectable == ambient_keychain_required
    ):
        raise GatewayLifecycleError(
            "Gateway readiness credential availability is invalid"
        )
    return GatewayReadiness(
        origin=origin,
        base_url=base_url,
        health_url=health_url,
        transport=dict(transport),
        harness_tokens=normalized_tokens,
        linked_pool_selectable=linked_pool_selectable,
        ambient_keychain_required=ambient_keychain_required,
    )


def _require_loopback_url(value: object, *, suffix: str) -> str:
    if not isinstance(value, str) or not value:
        raise GatewayLifecycleError("Gateway readiness contains an invalid URL")
    parsed = urlparse(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "::1"}
        or parsed.port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path.rstrip("/") != suffix.rstrip("/")
    ):
        raise GatewayLifecycleError("Gateway readiness URL is not loopback-only")
    return value.rstrip("/") if not suffix else value


def _normalize_harness(value: str) -> str:
    normalized = value.strip().lower()
    if normalized not in {"eliza", "hermes", "openclaw"}:
        raise ValueError(f"Unsupported Claude subscription harness: {value}")
    return normalized
