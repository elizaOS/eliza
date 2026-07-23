"""Exercises the secret handoff and teardown contract around the gateway CLI."""

from __future__ import annotations

import json
import re
import stat
import subprocess
from pathlib import Path
from typing import Any

import pytest

from benchmarks.orchestrator.subscription_gateway import (
    EXPECTED_TRANSPORT,
    FORBIDDEN_UPSTREAM_ENV,
    GatewayLifecycleError,
    start_claude_subscription_gateway,
)


TOKENS = {
    "eliza": "e" * 64,
    "hermes": "h" * 64,
    "openclaw": "o" * 64,
}

CONTENT_CONTRACT = {
    "schema_version": 1,
    "contract_id": "test_contract_v1",
    "system_hint": "reviewed hint",
    "public_user_turns": ["reviewed turn"],
    "forbidden_text_by_category": {"scenario_ids": ["hidden_id"]},
    "observed_text_by_category": {"workspace_paths": ["/workspace"]},
}


def _authenticated_status(
    *_args: object, **_kwargs: object
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=["claude", "auth", "status", "--json"],
        returncode=0,
        stdout=json.dumps(
            {
                "loggedIn": True,
                "authMethod": "claude.ai",
                "subscriptionType": "max",
            }
        ),
        stderr="",
    )


class FakeGatewayProcess:
    pid = 4312

    def __init__(self, *, audit_file: Path, write_audit: bool = True) -> None:
        self.returncode: int | None = None
        self.audit_file = audit_file
        self.write_audit = write_audit
        self.terminated = False
        self.killed = False

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        if self.write_audit:
            self.audit_file.write_text("", encoding="utf-8")
            self.audit_file.chmod(0o600)
        self.returncode = 0

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        if self.returncode is None:
            raise subprocess.TimeoutExpired("fake-gateway", 1)
        return self.returncode


def _write_readiness(
    path: Path,
    *,
    mode: int = 0o600,
    linked_pool_selectable: bool = False,
) -> None:
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "status": "ready",
                "pid": FakeGatewayProcess.pid,
                "origin": "http://127.0.0.1:43123",
                "base_url": "http://127.0.0.1:43123/v1",
                "health_url": "http://127.0.0.1:43123/health",
                "transport": EXPECTED_TRANSPORT,
                "harness_tokens": TOKENS,
                "credential_readiness": {
                    "linked_pool_selectable": linked_pool_selectable,
                    "ambient_keychain_required": not linked_pool_selectable,
                },
            }
        ),
        encoding="utf-8",
    )
    path.chmod(mode)


def _workspace(tmp_path: Path) -> Path:
    workspace = tmp_path / "packages"
    (workspace / "benchmarks" / "claude-subscription-gateway").mkdir(parents=True)
    return workspace


def test_gateway_consumes_readiness_and_scopes_each_worker_token(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = _workspace(tmp_path)
    captured: dict[str, Any] = {}
    monkeypatch.setenv("ANTHROPIC_API_KEY", "must-not-reach-sdk")

    def popen(command: list[str], **kwargs: Any) -> FakeGatewayProcess:
        captured["command"] = command
        captured["env"] = kwargs["env"]
        ready_file = Path(command[command.index("--ready-file") + 1])
        audit_file = Path(command[command.index("--audit-file") + 1])
        _write_readiness(ready_file)
        return FakeGatewayProcess(audit_file=audit_file)

    gateway = start_claude_subscription_gateway(
        workspace_root=workspace,
        run_group_id="rg_action_calling",
        harnesses=("eliza", "hermes", "openclaw"),
        popen_factory=popen,
        auth_status_runner=_authenticated_status,
    )

    assert not gateway.ready_file.exists()
    assert stat.S_IMODE(gateway.stdout_file.stat().st_mode) in {0o600, 0o644}
    assert FORBIDDEN_UPSTREAM_ENV.isdisjoint(captured["env"])
    assert captured["command"][:3] == [
        "bun",
        "--no-env-file",
        str(
            workspace / "benchmarks" / "claude-subscription-gateway" / "src" / "cli.ts"
        ),
    ]
    hermes_env = gateway.env_for_harness("hermes")
    assert hermes_env["OPENAI_API_KEY"] == TOKENS["hermes"]
    assert TOKENS["eliza"] not in hermes_env.values()
    assert TOKENS["openclaw"] not in hermes_env.values()

    audit_file = gateway.close()

    assert audit_file.is_file()
    assert gateway.process.terminated is True
    assert stat.S_IMODE(audit_file.stat().st_mode) == 0o600


def test_gateway_content_contract_is_private_and_ephemeral(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    observed_contract: dict[str, object] = {}

    def popen(command: list[str], **_kwargs: Any) -> FakeGatewayProcess:
        contract_file = Path(command[command.index("--content-contract-file") + 1])
        observed_contract["path"] = contract_file
        observed_contract["mode"] = stat.S_IMODE(contract_file.stat().st_mode)
        observed_contract["value"] = json.loads(contract_file.read_text())
        ready_file = Path(command[command.index("--ready-file") + 1])
        audit_file = Path(command[command.index("--audit-file") + 1])
        _write_readiness(ready_file)
        return FakeGatewayProcess(audit_file=audit_file)

    gateway = start_claude_subscription_gateway(
        workspace_root=workspace,
        run_group_id="rg_content_contract",
        harnesses=("eliza",),
        popen_factory=popen,
        auth_status_runner=_authenticated_status,
        content_attestation_contract=CONTENT_CONTRACT,
    )

    contract_path = observed_contract["path"]
    assert isinstance(contract_path, Path)
    assert observed_contract["mode"] == 0o600
    assert observed_contract["value"] == CONTENT_CONTRACT
    assert not contract_path.exists()
    gateway.close()


def test_gateway_auth_failure_never_leaves_raw_content_contract(
    tmp_path: Path,
) -> None:
    workspace = _workspace(tmp_path)

    def unauthenticated(
        *_args: object, **_kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            [],
            0,
            stdout=json.dumps({"loggedIn": False, "authMethod": "none"}),
            stderr="",
        )

    def popen(command: list[str], **_kwargs: Any) -> FakeGatewayProcess:
        ready_file = Path(command[command.index("--ready-file") + 1])
        audit_file = Path(command[command.index("--audit-file") + 1])
        _write_readiness(ready_file)
        return FakeGatewayProcess(audit_file=audit_file)

    with pytest.raises(GatewayLifecycleError):
        start_claude_subscription_gateway(
            workspace_root=workspace,
            run_group_id="rg_contract_auth_failure",
            harnesses=("eliza",),
            popen_factory=popen,
            auth_status_runner=unauthenticated,
            content_attestation_contract=CONTENT_CONTRACT,
        )

    contract_path = (
        workspace
        / "benchmarks"
        / "benchmark_results"
        / "rg_contract_auth_failure"
        / "subscription-gateway"
        / "content-attestation-contract.json"
    )
    assert not contract_path.exists()


def test_gateway_spawn_failure_deletes_staged_content_contract(
    tmp_path: Path,
) -> None:
    workspace = _workspace(tmp_path)
    observed_path: Path | None = None

    def failed_popen(command: list[str], **_kwargs: Any) -> FakeGatewayProcess:
        nonlocal observed_path
        observed_path = Path(command[command.index("--content-contract-file") + 1])
        assert observed_path.is_file()
        raise OSError("spawn failed")

    with pytest.raises(OSError, match="spawn failed"):
        start_claude_subscription_gateway(
            workspace_root=workspace,
            run_group_id="rg_contract_spawn_failure",
            harnesses=("eliza",),
            popen_factory=failed_popen,
            auth_status_runner=_authenticated_status,
            content_attestation_contract=CONTENT_CONTRACT,
        )

    assert observed_path is not None
    assert not observed_path.exists()


def test_gateway_log_open_failure_never_stages_content_contract(
    tmp_path: Path,
) -> None:
    workspace = _workspace(tmp_path)
    process_root = (
        workspace
        / "benchmarks"
        / "benchmark_results"
        / "rg_contract_log_failure"
        / "subscription-gateway"
    )
    (process_root / "stdout.log").mkdir(parents=True)

    with pytest.raises(OSError):
        start_claude_subscription_gateway(
            workspace_root=workspace,
            run_group_id="rg_contract_log_failure",
            harnesses=("eliza",),
            auth_status_runner=_authenticated_status,
            content_attestation_contract=CONTENT_CONTRACT,
        )

    assert not (process_root / "content-attestation-contract.json").exists()


def test_gateway_rejects_non_private_readiness_and_stops_process(
    tmp_path: Path,
) -> None:
    workspace = _workspace(tmp_path)
    created: list[FakeGatewayProcess] = []

    def popen(command: list[str], **_kwargs: Any) -> FakeGatewayProcess:
        ready_file = Path(command[command.index("--ready-file") + 1])
        audit_file = Path(command[command.index("--audit-file") + 1])
        _write_readiness(ready_file, mode=0o644)
        process = FakeGatewayProcess(audit_file=audit_file)
        created.append(process)
        return process

    with pytest.raises(GatewayLifecycleError, match="permissions"):
        start_claude_subscription_gateway(
            workspace_root=workspace,
            run_group_id="rg_bad_mode",
            harnesses=("eliza",),
            popen_factory=popen,
            auth_status_runner=_authenticated_status,
        )

    assert created[0].terminated is True


def test_gateway_close_requires_redacted_audit(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)

    def popen(command: list[str], **_kwargs: Any) -> FakeGatewayProcess:
        ready_file = Path(command[command.index("--ready-file") + 1])
        audit_file = Path(command[command.index("--audit-file") + 1])
        _write_readiness(ready_file)
        return FakeGatewayProcess(audit_file=audit_file, write_audit=False)

    gateway = start_claude_subscription_gateway(
        workspace_root=workspace,
        run_group_id="rg_missing_audit",
        harnesses=("openclaw",),
        popen_factory=popen,
        auth_status_runner=_authenticated_status,
    )

    with pytest.raises(GatewayLifecycleError, match="without its redacted audit"):
        gateway.close()


def test_gateway_requires_supported_harness(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="Unsupported"):
        start_claude_subscription_gateway(
            workspace_root=_workspace(tmp_path),
            run_group_id="rg_bad_harness",
            harnesses=("smithers",),
        )


def test_orchestrator_billing_env_denylist_matches_gateway_source() -> None:
    gateway_source = (
        Path(__file__).resolve().parents[2]
        / "claude-subscription-gateway"
        / "src"
        / "claude-completion.ts"
    ).read_text(encoding="utf-8")
    declaration = gateway_source.split(
        "export const FORBIDDEN_API_BILLING_ENV_NAMES = Object.freeze([",
        1,
    )[1].split("]);", 1)[0]
    exported_names = set(re.findall(r'"([A-Z0-9_]+)"', declaration))

    assert exported_names == FORBIDDEN_UPSTREAM_ENV


@pytest.mark.parametrize(
    ("payload", "returncode", "expected_code"),
    [
        (
            {
                "loggedIn": False,
                "authMethod": "none",
                "subscriptionType": None,
            },
            0,
            "claude_subscription_not_authenticated",
        ),
        (
            {"loggedIn": True, "authMethod": "apiKey"},
            0,
            "claude_subscription_not_authenticated",
        ),
        (None, 0, "claude_auth_status_invalid"),
        ({}, 1, "claude_auth_status_failed"),
    ],
)
def test_gateway_stops_before_workers_when_required_ambient_auth_is_not_ready(
    tmp_path: Path,
    payload: object,
    returncode: int,
    expected_code: str,
) -> None:
    workspace = _workspace(tmp_path)
    spawned: list[FakeGatewayProcess] = []

    def auth_status(
        *_args: object, **_kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        stdout = "not-json" if payload is None else json.dumps(payload)
        return subprocess.CompletedProcess(
            [], returncode, stdout=stdout, stderr="secret"
        )

    def popen(command: list[str], **_kwargs: object) -> FakeGatewayProcess:
        ready_file = Path(command[command.index("--ready-file") + 1])
        audit_file = Path(command[command.index("--audit-file") + 1])
        _write_readiness(ready_file)
        process = FakeGatewayProcess(audit_file=audit_file)
        spawned.append(process)
        return process

    with pytest.raises(GatewayLifecycleError) as caught:
        start_claude_subscription_gateway(
            workspace_root=workspace,
            run_group_id="rg_auth_not_ready",
            harnesses=("eliza",),
            popen_factory=popen,
            auth_status_runner=auth_status,
        )

    assert caught.value.code == expected_code
    assert "secret" not in str(caught.value)
    assert len(spawned) == 1
    assert spawned[0].terminated is True


def test_linked_pool_readiness_skips_ambient_auth_probe(
    tmp_path: Path,
) -> None:
    workspace = _workspace(tmp_path)

    def popen(command: list[str], **_kwargs: object) -> FakeGatewayProcess:
        ready_file = Path(command[command.index("--ready-file") + 1])
        audit_file = Path(command[command.index("--audit-file") + 1])
        _write_readiness(ready_file, linked_pool_selectable=True)
        return FakeGatewayProcess(audit_file=audit_file)

    gateway = start_claude_subscription_gateway(
        workspace_root=workspace,
        run_group_id="rg_linked_pool",
        harnesses=("eliza",),
        popen_factory=popen,
        auth_status_runner=lambda *_args, **_kwargs: pytest.fail(
            "linked pool must not probe ambient Claude auth"
        ),
    )

    assert gateway.readiness.linked_pool_selectable is True
    gateway.close()
