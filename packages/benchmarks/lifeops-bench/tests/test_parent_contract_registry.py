"""Contract-table tests exercise all 48 typed terminal snapshots and signer replay."""

from __future__ import annotations

import hashlib
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import cast

import pytest

from eliza_lifeops_bench import parent_contracts
from eliza_lifeops_bench.evidence import (
    HmacSha256ReceiptVerifier,
    HttpTrustedToolExecutor,
    TrustedExecutionContext,
    action_sha256,
    canonical_json_bytes,
)
from eliza_lifeops_bench.parent_contracts import (
    DOMAIN_ARTIFACT_SCHEMA,
    PARENT_CONTRACT_DEFINITIONS,
    TERMINAL_SNAPSHOT_SCHEMA,
    ContractArtifactSpec,
    FactRule,
)
from eliza_lifeops_bench.runtime_connector import (
    production_parent_contract_registry,
)
from eliza_lifeops_bench.scenarios import (
    WORLD_TRAVELING_COPARENT_SCENARIOS,
)
from eliza_lifeops_bench.trusted_executor_server import (
    ActionLineageEntry,
    ConnectorExecution,
    JsonObject,
    SqliteReplayStore,
    TrustedExecutorApplication,
    ValidatedExecutionRequest,
    make_trusted_executor_handler,
)
from eliza_lifeops_bench.types import (
    Action,
    TrustedActionPolicy,
    TrustedEvidenceBoundary,
    TrustedEvidenceRequirement,
)

_REQUEST_KEY = b"parent-contract-request-key-32-bytes!"
_RECEIPT_KEY = b"parent-contract-receipt-key-32-bytes!"
_REQUEST_KEY_ID = "parent-contract-request-v1"
_RECEIPT_KEY_ID = "parent-contract-receipt-v1"
_PROVIDER = "parent-contract-provider"
_BOUNDARY: TrustedEvidenceBoundary = "sandbox_connector"
_EXECUTOR_VERSION = "parent-contract-executor-v1"


def _iso(value: datetime) -> str:
    return (
        value.astimezone(timezone.utc)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


def _requirements() -> dict[str, TrustedEvidenceRequirement]:
    return {
        requirement.contract_id: requirement
        for scenario in WORLD_TRAVELING_COPARENT_SCENARIOS
        if (requirement := scenario.trusted_evidence_requirement) is not None
    }


def _action_for(requirement: TrustedEvidenceRequirement) -> Action:
    policy = requirement.allowed_actions[0]
    kwargs: dict[str, object] = {
        field: f"{field}-value" for field in policy.required_kwargs
    }
    if policy.discriminator_field is not None:
        kwargs[policy.discriminator_field] = policy.allowed_discriminators[0]
    return Action(name=policy.name, kwargs=kwargs)


def _request_for(
    contract_id: str,
    *,
    now: datetime,
    tool_call_id: str = "call-1",
    request_ordinal: int = 1,
    run_nonce: str = "parent-contract-nonce",
    run_id: str = "parent-contract-run",
) -> ValidatedExecutionRequest:
    requirement = _requirements()[contract_id]
    action = _action_for(requirement)
    return ValidatedExecutionRequest(
        envelope={},
        run_id=run_id,
        run_nonce=run_nonce,
        run_started_at=now,
        scenario_id=next(
            scenario.id
            for scenario in WORLD_TRAVELING_COPARENT_SCENARIOS
            if scenario.trusted_evidence_requirement == requirement
        ),
        seed=2026,
        tool_call_id=tool_call_id,
        request_ordinal=request_ordinal,
        action=action,
        action_sha256=action_sha256(action),
        contract_id=contract_id,
        contract_version=requirement.contract_version,
        contract_sha256=requirement.contract_sha256,
        requested_at=now,
    )


def _sample_fact(
    name: str,
    rule: FactRule,
    *,
    observed_at: datetime,
) -> object:
    if rule.const is not parent_contracts._MISSING:
        return rule.const
    if rule.kind == "boolean":
        return True
    if rule.kind == "integer":
        return rule.minimum if rule.minimum is not None else 1
    if rule.kind == "sha256":
        return hashlib.sha256(name.encode()).hexdigest()
    if rule.kind == "timestamp":
        return _iso(observed_at)
    if rule.kind == "string":
        return rule.allowed[0] if rule.allowed else f"{name}-value"
    if rule.kind == "string_list":
        count = rule.min_items if rule.min_items is not None else 1
        if rule.allowed:
            if rule.unique_items:
                return list(rule.allowed[:count])
            return [rule.allowed[0] for _index in range(count)]
        return [f"{name}-{index + 1}" for index in range(count)]
    raise AssertionError(f"unsupported test rule {rule.kind}")


def _sample_facts(
    spec: ContractArtifactSpec,
    *,
    observed_at: datetime,
) -> dict[str, object]:
    facts = {
        name: _sample_fact(name, rule, observed_at=observed_at)
        for name, rule in spec.facts
    }
    for left, right in spec.equal_fields:
        facts[right] = facts[left]
    for left, right in spec.equal_length_fields:
        left_value = facts[left]
        right_value = facts[right]
        assert isinstance(left_value, list)
        assert isinstance(right_value, list)
        if len(right_value) < len(left_value):
            right_value.extend(
                f"{right}-{index + 1}"
                for index in range(len(right_value), len(left_value))
            )
        elif len(right_value) > len(left_value):
            del right_value[len(left_value) :]
    for earlier, later in spec.ordered_timestamp_fields:
        facts[earlier] = _iso(observed_at - timedelta(minutes=1))
        facts[later] = _iso(observed_at)
    return facts


def _terminal_snapshot(
    contract_id: str,
    *,
    observed_at: datetime,
    lineage: tuple[ActionLineageEntry, ...],
) -> dict[str, object]:
    definition = PARENT_CONTRACT_DEFINITIONS[contract_id]
    artifacts: list[dict[str, object]] = []
    for index, spec in enumerate(definition.artifacts, start=1):
        facts = _sample_facts(spec, observed_at=observed_at)
        artifacts.append(
            {
                "schema": DOMAIN_ARTIFACT_SCHEMA,
                "kind": spec.kind,
                "artifactId": f"{contract_id.lower()}-artifact-{index}",
                "revision": f"{contract_id.lower()}-revision-{index}",
                "observedAt": _iso(observed_at),
                "source": {
                    "kind": spec.source_kind,
                    "reference": (
                        f"{spec.source_kind}://"
                        f"{contract_id.lower()}/artifact-{index}"
                    ),
                    "revision": f"source-revision-{index}",
                    "observedAt": _iso(observed_at),
                },
                "facts": facts,
                "factsSha256": hashlib.sha256(canonical_json_bytes(facts)).hexdigest(),
            }
        )
    snapshot: dict[str, object] = {
        "schema": TERMINAL_SNAPSHOT_SCHEMA,
        "snapshotId": f"{contract_id.lower()}-terminal-snapshot",
        "revision": f"{contract_id.lower()}-terminal-revision",
        "observedAt": _iso(observed_at),
        "lineageSha256": hashlib.sha256(
            canonical_json_bytes([entry.to_json() for entry in lineage])
        ).hexdigest(),
        "artifacts": artifacts,
    }
    snapshot["snapshotSha256"] = hashlib.sha256(
        canonical_json_bytes(snapshot)
    ).hexdigest()
    return snapshot


def _lineage(
    request: ValidatedExecutionRequest,
) -> tuple[ActionLineageEntry, ...]:
    return (
        ActionLineageEntry(
            request_ordinal=request.request_ordinal,
            tool_call_id=request.tool_call_id,
            action=request.action.name,
            action_sha256=request.action_sha256,
        ),
    )


def _execution(
    request: ValidatedExecutionRequest,
    snapshot: dict[str, object],
    *,
    observed_at: datetime,
) -> ConnectorExecution:
    return ConnectorExecution(
        payload=cast(
            JsonObject,
            {
                "result": {
                    "success": True,
                    "data": {
                        "actionName": request.action.name,
                        "terminalSnapshot": cast(
                            dict[str, object],
                            snapshot,
                        ),
                    },
                },
            },
        ),
        observed_at=observed_at,
        succeeded=True,
    )


def _all_object_keys(value: object) -> set[str]:
    if isinstance(value, dict):
        return set(value).union(
            *(_all_object_keys(item) for item in value.values()),
            set(),
        )
    if isinstance(value, list):
        return set().union(
            *(_all_object_keys(item) for item in value),
            set(),
        )
    return set()


@pytest.mark.parametrize(
    "contract_id",
    [f"G{index}" for index in range(1, 49) if index not in {35, 36}],
)
def test_each_parent_contract_accepts_only_its_complete_typed_snapshot(
    contract_id: str,
) -> None:
    now = datetime.now(timezone.utc)
    request = _request_for(contract_id, now=now)
    lineage = _lineage(request)
    snapshot = _terminal_snapshot(
        contract_id,
        observed_at=now,
        lineage=lineage,
    )
    requirement = _requirements()[contract_id]
    evaluator = (
        production_parent_contract_registry()
        .resolve(
            contract_id,
            requirement.contract_version,
            requirement.contract_sha256,
        )
        .evaluator
    )

    evaluation = evaluator.evaluate(
        request,
        _execution(request, snapshot, observed_at=now),
        lineage,
    )

    assert evaluation.terminal is True
    assert tuple(item.assertion_id for item in evaluation.assertions) == (
        f"{contract_id}.world.1",
        f"{contract_id}.world.2",
    )
    assert not {
        "assertion_id",
        "assertionIds",
        "requiredAssertionIds",
        "required_assertion_ids",
    }.intersection(_all_object_keys(snapshot))


def test_missing_or_altered_artifacts_remain_nonterminal() -> None:
    now = datetime.now(timezone.utc)
    request = _request_for("G34", now=now)
    lineage = _lineage(request)
    requirement = _requirements()["G34"]
    evaluator = (
        production_parent_contract_registry()
        .resolve(
            "G34",
            requirement.contract_version,
            requirement.contract_sha256,
        )
        .evaluator
    )
    missing = _terminal_snapshot("G34", observed_at=now, lineage=lineage)
    missing_artifacts = cast(list[object], missing["artifacts"])
    missing_artifacts.pop()
    missing["snapshotSha256"] = hashlib.sha256(
        canonical_json_bytes(
            {key: value for key, value in missing.items() if key != "snapshotSha256"}
        )
    ).hexdigest()

    missing_result = evaluator.evaluate(
        request,
        _execution(request, missing, observed_at=now),
        lineage,
    )

    altered = _terminal_snapshot("G34", observed_at=now, lineage=lineage)
    first = cast(list[dict[str, object]], altered["artifacts"])[0]
    facts = cast(dict[str, object], first["facts"])
    facts["ageYears"] = 9
    altered["snapshotSha256"] = hashlib.sha256(
        canonical_json_bytes(
            {key: value for key, value in altered.items() if key != "snapshotSha256"}
        )
    ).hexdigest()
    altered_result = evaluator.evaluate(
        request,
        _execution(request, altered, observed_at=now),
        lineage,
    )

    assert missing_result == parent_contracts.ContractEvaluation(
        assertions=(),
        terminal=False,
    )
    assert altered_result == missing_result


def test_cross_contract_snapshot_and_assertion_smuggling_fail_closed() -> None:
    now = datetime.now(timezone.utc)
    request = _request_for("G1", now=now)
    lineage = _lineage(request)
    requirement = _requirements()["G1"]
    evaluator = (
        production_parent_contract_registry()
        .resolve(
            "G1",
            requirement.contract_version,
            requirement.contract_sha256,
        )
        .evaluator
    )
    cross_case = _terminal_snapshot("G2", observed_at=now, lineage=lineage)
    smuggled = _terminal_snapshot("G1", observed_at=now, lineage=lineage)
    smuggled["requiredAssertionIds"] = [
        "G1.world.1",
        "G1.world.2",
    ]

    cross_result = evaluator.evaluate(
        request,
        _execution(request, cross_case, observed_at=now),
        lineage,
    )
    smuggled_result = evaluator.evaluate(
        request,
        _execution(request, smuggled, observed_at=now),
        lineage,
    )

    assert cross_result.terminal is False
    assert cross_result.assertions == ()
    assert smuggled_result == cross_result


class _SnapshotConnector:
    """Test connector exposes typed provider artifacts through the signer."""

    def __init__(self) -> None:
        self.calls = 0

    def execute(
        self,
        action: Action,
        *,
        idempotency_key: str,
        request: ValidatedExecutionRequest,
        policy: TrustedActionPolicy,
    ) -> ConnectorExecution:
        del idempotency_key, policy
        self.calls += 1
        observed_at = datetime.now(timezone.utc)
        lineage = (
            ActionLineageEntry(
                request_ordinal=request.request_ordinal,
                tool_call_id=request.tool_call_id,
                action=action.name,
                action_sha256=request.action_sha256,
            ),
        )
        snapshot = _terminal_snapshot(
            request.contract_id,
            observed_at=observed_at,
            lineage=lineage,
        )
        return _execution(
            request,
            snapshot,
            observed_at=observed_at,
        )


def _application(
    database_path: Path,
    connector: _SnapshotConnector,
) -> TrustedExecutorApplication:
    return TrustedExecutorApplication(
        request_hmac_key=_REQUEST_KEY,
        request_key_id=_REQUEST_KEY_ID,
        receipt_hmac_key=_RECEIPT_KEY,
        receipt_key_id=_RECEIPT_KEY_ID,
        provider=_PROVIDER,
        boundary=_BOUNDARY,
        executor_version=_EXECUTOR_VERSION,
        contracts=production_parent_contract_registry(),
        connector=connector,
        replay_store=SqliteReplayStore(database_path),
    )


@contextmanager
def _running_server(
    application: TrustedExecutorApplication,
) -> Iterator[str]:
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        make_trusted_executor_handler(application),
    )
    server.daemon_threads = True
    thread = threading.Thread(
        target=server.serve_forever,
        name="parent-contract-registry-test-server",
        daemon=True,
    )
    thread.start()
    try:
        host = cast(str, server.server_address[0])
        port = cast(int, server.server_address[1])
        yield f"http://{host}:{port}/execute"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.mark.asyncio
async def test_production_registry_replay_survives_signer_restart(
    tmp_path: Path,
) -> None:
    requirement = _requirements()["G34"]
    action = _action_for(requirement)
    now = datetime.now(timezone.utc)
    context = TrustedExecutionContext(
        run_id="parent-restart-run",
        run_nonce="parent-restart-nonce",
        run_started_at=now,
        scenario_id=next(
            scenario.id
            for scenario in WORLD_TRAVELING_COPARENT_SCENARIOS
            if scenario.trusted_evidence_requirement == requirement
        ),
        seed=2026,
        tool_call_id="call-1",
        request_ordinal=1,
        action=action,
        contract_id=requirement.contract_id,
        contract_version=requirement.contract_version,
        contract_sha256=requirement.contract_sha256,
        requested_at=now,
    )
    connector = _SnapshotConnector()
    database_path = tmp_path / "parent-contract-replay.sqlite"
    with _running_server(_application(database_path, connector)) as first_url:
        first = await HttpTrustedToolExecutor(
            first_url,
            _REQUEST_KEY,
            request_key_id=_REQUEST_KEY_ID,
            timeout_s=5,
        ).execute(context)
    with _running_server(_application(database_path, connector)) as second_url:
        second = await HttpTrustedToolExecutor(
            second_url,
            _REQUEST_KEY,
            request_key_id=_REQUEST_KEY_ID,
            timeout_s=5,
        ).execute(context)

    verifier = HmacSha256ReceiptVerifier(
        _RECEIPT_KEY,
        signing_key_id=_RECEIPT_KEY_ID,
        allowed_providers={_PROVIDER},
        allowed_boundaries={_BOUNDARY},
        allowed_contract_ids={requirement.contract_id},
    )
    verified = verifier.verify(context, second, requirement)

    assert second == first
    assert connector.calls == 1
    assert verified.assertion_ids == requirement.required_assertion_ids
    assert verified.attestation_kind == "terminal_postcondition"
