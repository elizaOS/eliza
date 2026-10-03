"""Authenticates real execution artifacts for evidence-gated LIVE scenarios.

The evaluated model never controls the evidence contract, action policy, or
assertion vocabulary. A separately operated executor owns the matching
contract implementation and returns a signed terminal artifact. The runner
retains that signed envelope and re-verifies it during scoring.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from collections.abc import Iterable
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Protocol, TypedDict, cast
from urllib.parse import urlparse

import httpx

from .types import (
    Action,
    Scenario,
    TrustedAttestationKind,
    TrustedActionPolicy,
    TrustedEvidenceBoundary,
    TrustedEvidenceRequirement,
    TurnResult,
    VerifiedEvidenceReceipt,
)

EXECUTION_METADATA_KEY = "_lifeops_bench_execution"
DETERMINISTIC_LIFEWORLD_BOUNDARY = "deterministic_lifeworld"
EXTERNAL_REQUEST_SCHEMA = "lifeops.external-execution.request.v2"
EXTERNAL_RESPONSE_SCHEMA = "lifeops.external-execution.response.v2"
SIGNED_RECEIPT_SCHEMA = "lifeops.trusted-evidence.v3"
ARTIFACT_SCHEMA = "lifeops.execution-artifact.v1"

_OPENAI_ACTION_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_TOOL_CALL_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_RECEIPT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")
_IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$")
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_SIGNATURE_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_MAX_ARTIFACT_BYTES = 1024 * 1024
_MAX_JSON_DEPTH = 16
_MAX_JSON_ITEMS = 20_000
_MAX_JSON_STRING = 256 * 1024
_MIN_HMAC_KEY_BYTES = 32


class _ParsedRequest(TypedDict):
    """Validated request fields consumed by receipt and artifact checks."""

    run_id: str
    run_nonce: str
    scenario_id: str
    seed: int
    tool_call_id: str
    request_ordinal: int
    action: str
    action_sha256: str
    contract_id: str
    contract_version: int
    contract_sha256: str


class EvidenceVerificationError(RuntimeError):
    """Raised when an external outcome cannot be authenticated safely."""


@dataclass(frozen=True)
class TrustedExecutionContext:
    """Public request identity passed to the separately controlled executor.

    Required assertion IDs and their definitions intentionally do not cross
    this boundary. The executor must resolve ``contract_sha256`` through its
    own versioned registry and derive assertions from provider postconditions.
    """

    run_id: str
    run_nonce: str
    run_started_at: datetime
    scenario_id: str
    seed: int
    tool_call_id: str
    request_ordinal: int
    action: Action
    contract_id: str
    contract_version: int
    contract_sha256: str
    requested_at: datetime


@dataclass(frozen=True)
class ExternalToolExecution:
    """Unverified response returned by the configured executor."""

    payload: dict[str, Any]
    artifact_manifest: dict[str, Any]
    receipt: dict[str, Any]


@dataclass(frozen=True)
class TrustedEvidenceVerification:
    """Result of re-authenticating one scenario's terminal evidence."""

    satisfied: bool
    reason: str
    receipt_ids: tuple[str, ...] = ()


class TrustedToolExecutor(Protocol):
    """Execution boundary used only when a gated campaign opts into real work."""

    async def execute(self, context: TrustedExecutionContext) -> ExternalToolExecution:
        """Execute one pre-authorized action and return a signed artifact."""


class TrustedEvidenceVerifier(Protocol):
    """Authenticates fresh and stored executor envelopes."""

    def verify(
        self,
        context: TrustedExecutionContext,
        execution: ExternalToolExecution,
        requirement: TrustedEvidenceRequirement,
    ) -> VerifiedEvidenceReceipt:
        """Authenticate a fresh executor response."""

    def verify_stored(
        self,
        stored: VerifiedEvidenceReceipt,
        payload: dict[str, Any],
        requirement: TrustedEvidenceRequirement,
    ) -> VerifiedEvidenceReceipt:
        """Re-authenticate the exact envelope retained in a run result."""


def canonical_json_bytes(value: Any) -> bytes:
    """Serialize protocol values with the documented sorted-key JSON profile."""
    _validate_json_limits(value)
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise EvidenceVerificationError(
            "external evidence protocol contains a non-canonical JSON value"
        ) from exc


def action_sha256(action: Action) -> str:
    """Bind a receipt to both the canonical tool name and complete arguments."""
    return hashlib.sha256(
        canonical_json_bytes({"name": action.name, "kwargs": action.kwargs})
    ).hexdigest()


def execution_request_body(context: TrustedExecutionContext) -> dict[str, Any]:
    """Build the signed request without leaking the runner's assertion list."""
    _require_aware(context.run_started_at, "run_started_at")
    _require_aware(context.requested_at, "requested_at")
    _validate_run_identifier(context.run_id, "run_id")
    _validate_run_identifier(context.run_nonce, "run_nonce")
    _validate_tool_call_id(context.tool_call_id)
    _validate_action_name(context.action.name)
    if context.request_ordinal <= 0:
        raise EvidenceVerificationError("request_ordinal must be positive")
    if context.contract_version <= 0:
        raise EvidenceVerificationError("contract_version must be positive")
    if not _SHA256_PATTERN.fullmatch(context.contract_sha256):
        raise EvidenceVerificationError("contract_sha256 is invalid")
    return {
        "schema": EXTERNAL_REQUEST_SCHEMA,
        "run_id": context.run_id,
        "run_nonce": context.run_nonce,
        "run_started_at": _format_utc(context.run_started_at),
        "scenario_id": context.scenario_id,
        "seed": context.seed,
        "tool_call_id": context.tool_call_id,
        "request_ordinal": context.request_ordinal,
        "action": {
            "name": context.action.name,
            "kwargs": context.action.kwargs,
            "sha256": action_sha256(context.action),
        },
        "evidence_contract": {
            "contract_id": context.contract_id,
            "contract_version": context.contract_version,
            "contract_sha256": context.contract_sha256,
        },
        "requested_at": _format_utc(context.requested_at),
    }


def sign_receipt(receipt_without_signature: dict[str, Any], key: bytes) -> str:
    """Sign a receipt using the executor's dedicated response key."""
    _validate_hmac_key(key)
    return hmac.new(
        key,
        canonical_json_bytes(receipt_without_signature),
        hashlib.sha256,
    ).hexdigest()


def validate_action_policy(
    action: Action,
    requirement: TrustedEvidenceRequirement,
    prior_policy_calls: dict[int, int],
) -> TrustedActionPolicy:
    """Reject actions outside the exact versioned contract before dispatch."""
    _validate_action_name(action.name)
    if not isinstance(action.kwargs, dict):
        raise EvidenceVerificationError("external action arguments must be an object")

    for policy_index, policy in enumerate(requirement.allowed_actions):
        if action.name != policy.name:
            continue
        if policy.discriminator_field is not None:
            discriminator = action.kwargs.get(policy.discriminator_field)
            if discriminator not in policy.allowed_discriminators:
                continue
        missing = [
            field
            for field in policy.required_kwargs
            if not isinstance(action.kwargs.get(field), str)
            or not str(action.kwargs[field]).strip()
        ]
        if missing:
            raise EvidenceVerificationError(
                f"external action {action.name} lacks contract-required fields: "
                + ", ".join(missing)
            )
        call_count = prior_policy_calls.get(policy_index, 0)
        if call_count >= policy.max_calls:
            raise EvidenceVerificationError(
                f"external action {action.name} exceeds contract call limit"
            )
        prior_policy_calls[policy_index] = call_count + 1
        return policy

    raise EvidenceVerificationError(
        f"action {action.name!r} is not allowed by evidence contract "
        f"{requirement.contract_id!r}"
    )


def validate_tool_call_id(value: str) -> None:
    """Validate one runner-visible tool-call identifier before any dispatch."""
    _validate_tool_call_id(value)


class HmacSha256ReceiptVerifier:
    """Verifies receipts from one pinned executor identity."""

    def __init__(
        self,
        receipt_key: bytes,
        *,
        signing_key_id: str,
        allowed_providers: Iterable[str],
        allowed_boundaries: Iterable[str],
        allowed_contract_ids: Iterable[str],
        allowed_clock_skew: timedelta = timedelta(seconds=30),
        max_execution_duration: timedelta = timedelta(minutes=5),
    ) -> None:
        _validate_hmac_key(receipt_key)
        _validate_run_identifier(signing_key_id, "signing_key_id")
        providers = frozenset(item.strip() for item in allowed_providers if item.strip())
        boundaries = frozenset(
            item.strip() for item in allowed_boundaries if item.strip()
        )
        contracts = frozenset(
            item.strip() for item in allowed_contract_ids if item.strip()
        )
        if not providers or not boundaries or not contracts:
            raise ValueError(
                "receipt verifier requires non-empty provider, boundary, and "
                "contract allowlists"
            )
        if allowed_clock_skew < timedelta(0):
            raise ValueError("allowed_clock_skew cannot be negative")
        if max_execution_duration <= timedelta(0):
            raise ValueError("max_execution_duration must be positive")
        self._receipt_key = bytes(receipt_key)
        self._signing_key_id = signing_key_id
        self._allowed_providers = providers
        self._allowed_boundaries = boundaries
        self._allowed_contract_ids = contracts
        self._allowed_clock_skew = allowed_clock_skew
        self._max_execution_duration = max_execution_duration

    def verify(
        self,
        context: TrustedExecutionContext,
        execution: ExternalToolExecution,
        requirement: TrustedEvidenceRequirement,
    ) -> VerifiedEvidenceReceipt:
        """Authenticate a fresh response and preserve its complete proof."""
        request_envelope = execution_request_body(context)
        return self._verify_components(
            request_envelope=request_envelope,
            payload=execution.payload,
            artifact_manifest=execution.artifact_manifest,
            signed_receipt=execution.receipt,
            requirement=requirement,
        )

    def verify_stored(
        self,
        stored: VerifiedEvidenceReceipt,
        payload: dict[str, Any],
        requirement: TrustedEvidenceRequirement,
    ) -> VerifiedEvidenceReceipt:
        """Re-authenticate a stored envelope and compare every summary field."""
        verified = self._verify_components(
            request_envelope=stored.request_envelope,
            payload=payload,
            artifact_manifest=stored.artifact_manifest,
            signed_receipt=stored.signed_receipt,
            requirement=requirement,
        )
        if verified != stored:
            raise EvidenceVerificationError(
                f"stored receipt summary {stored.receipt_id!r} was modified"
            )
        return verified

    def _verify_components(
        self,
        *,
        request_envelope: dict[str, Any],
        payload: dict[str, Any],
        artifact_manifest: dict[str, Any],
        signed_receipt: dict[str, Any],
        requirement: TrustedEvidenceRequirement,
    ) -> VerifiedEvidenceReceipt:
        if not isinstance(request_envelope, dict):
            raise EvidenceVerificationError("stored request envelope is invalid")
        if not isinstance(payload, dict):
            raise EvidenceVerificationError("executor payload must be a JSON object")
        if not isinstance(artifact_manifest, dict):
            raise EvidenceVerificationError(
                "executor artifact manifest must be a JSON object"
            )
        if not isinstance(signed_receipt, dict):
            raise EvidenceVerificationError("executor receipt must be a JSON object")
        request_bytes = canonical_json_bytes(request_envelope)
        payload_bytes = canonical_json_bytes(payload)
        artifact_bytes = canonical_json_bytes(artifact_manifest)
        if len(artifact_bytes) > _MAX_ARTIFACT_BYTES:
            raise EvidenceVerificationError(
                f"executor artifact exceeds {_MAX_ARTIFACT_BYTES} bytes"
            )

        request = _parse_request_envelope(request_envelope)
        if (
            request["contract_id"] != requirement.contract_id
            or request["contract_version"] != requirement.contract_version
            or request["contract_sha256"] != requirement.contract_sha256
        ):
            raise EvidenceVerificationError(
                "request envelope does not match the runner's evidence contract"
            )

        receipt = dict(signed_receipt)
        signature = receipt.pop("signature", None)
        if not isinstance(signature, str) or not _SIGNATURE_PATTERN.fullmatch(
            signature
        ):
            raise EvidenceVerificationError(
                "executor receipt has no valid HMAC-SHA256 signature"
            )
        expected_signature = sign_receipt(receipt, self._receipt_key)
        if not hmac.compare_digest(signature, expected_signature):
            raise EvidenceVerificationError("executor receipt signature mismatch")

        expected_request_sha256 = hashlib.sha256(request_bytes).hexdigest()
        expected_action_sha256 = request["action_sha256"]
        expected_payload_sha256 = hashlib.sha256(payload_bytes).hexdigest()
        expected_artifact_sha256 = hashlib.sha256(artifact_bytes).hexdigest()

        _expect_equal(receipt, "schema", SIGNED_RECEIPT_SCHEMA)
        _expect_equal(receipt, "signing_key_id", self._signing_key_id)
        _expect_equal(receipt, "run_id", request["run_id"])
        _expect_equal(receipt, "run_nonce", request["run_nonce"])
        _expect_equal(receipt, "scenario_id", request["scenario_id"])
        _expect_equal(receipt, "seed", request["seed"])
        _expect_equal(receipt, "tool_call_id", request["tool_call_id"])
        _expect_equal(receipt, "request_ordinal", request["request_ordinal"])
        _expect_equal(receipt, "action", request["action"])
        _expect_equal(receipt, "action_sha256", expected_action_sha256)
        _expect_equal(receipt, "contract_id", requirement.contract_id)
        _expect_equal(
            receipt,
            "contract_version",
            requirement.contract_version,
        )
        _expect_equal(receipt, "contract_sha256", requirement.contract_sha256)
        _expect_equal(receipt, "request_sha256", expected_request_sha256)
        _expect_equal(receipt, "payload_sha256", expected_payload_sha256)
        _expect_equal(receipt, "artifact_sha256", expected_artifact_sha256)

        receipt_id = _require_identifier(receipt, "receipt_id")
        if not _RECEIPT_ID_PATTERN.fullmatch(receipt_id):
            raise EvidenceVerificationError("executor receipt_id has invalid syntax")
        provider = _require_identifier(receipt, "provider")
        if provider not in self._allowed_providers:
            raise EvidenceVerificationError(
                f"executor provider {provider!r} is not pinned to this key"
            )
        boundary = _require_identifier(receipt, "boundary")
        if boundary not in self._allowed_boundaries:
            raise EvidenceVerificationError(
                f"executor boundary {boundary!r} is not pinned to this key"
            )
        if requirement.contract_id not in self._allowed_contract_ids:
            raise EvidenceVerificationError(
                f"contract {requirement.contract_id!r} is not pinned to this key"
            )
        executor_version = _require_identifier(receipt, "executor_version")
        success = receipt.get("success")
        if not isinstance(success, bool):
            raise EvidenceVerificationError("executor receipt success must be boolean")
        attestation_kind = receipt.get("attestation_kind")
        if attestation_kind not in {"operation", "terminal_postcondition"}:
            raise EvidenceVerificationError(
                "executor attestation_kind is invalid"
            )

        observed_at_raw = _require_nonempty_string(receipt, "observed_at")
        issued_at_raw = _require_nonempty_string(receipt, "issued_at")
        observed_at = _parse_aware_datetime(observed_at_raw, "observed_at")
        issued_at = _parse_aware_datetime(issued_at_raw, "issued_at")
        requested_at = _parse_aware_datetime(
            cast(str, request_envelope["requested_at"]),
            "requested_at",
        )
        now = datetime.now(timezone.utc)
        if observed_at < requested_at - self._allowed_clock_skew:
            raise EvidenceVerificationError(
                "executor receipt predates the action request"
            )
        if issued_at < observed_at - self._allowed_clock_skew:
            raise EvidenceVerificationError(
                "executor receipt was issued before its observation"
            )
        if issued_at > now + self._allowed_clock_skew:
            raise EvidenceVerificationError(
                "executor receipt timestamp is in the future"
            )
        if issued_at - requested_at > self._max_execution_duration:
            raise EvidenceVerificationError(
                "executor receipt exceeded the allowed execution duration"
            )

        assertion_ids, artifact_terminal = _validate_artifact_manifest(
            artifact_manifest,
            request=request,
            requirement=requirement,
            provider=provider,
            boundary=boundary,
            executor_version=executor_version,
            observed_at=_format_utc(observed_at),
        )
        receipt_assertion_ids = receipt.get("assertion_ids")
        if (
            not isinstance(receipt_assertion_ids, list)
            or not all(
                isinstance(item, str) and item for item in receipt_assertion_ids
            )
            or tuple(receipt_assertion_ids) != assertion_ids
        ):
            raise EvidenceVerificationError(
                "receipt assertions do not match the validated artifact"
            )
        if not success and assertion_ids:
            raise EvidenceVerificationError(
                "failed executor receipt cannot carry passed assertions"
            )
        if (
            attestation_kind == "terminal_postcondition"
            and not artifact_terminal
        ):
            raise EvidenceVerificationError(
                "terminal receipt does not contain a terminal artifact"
            )
        if attestation_kind == "operation" and artifact_terminal:
            raise EvidenceVerificationError(
                "operation receipt mislabels a terminal artifact"
            )

        retained_request = deepcopy(request_envelope)
        retained_receipt = deepcopy(signed_receipt)
        retained_artifact = deepcopy(artifact_manifest)
        verified_boundary = cast(TrustedEvidenceBoundary, boundary)
        verified_attestation_kind = cast(
            TrustedAttestationKind,
            attestation_kind,
        )
        return VerifiedEvidenceReceipt(
            schema="lifeops.verified-evidence.v1",
            receipt_id=receipt_id,
            provider=provider,
            boundary=verified_boundary,
            run_id=request["run_id"],
            scenario_id=request["scenario_id"],
            seed=request["seed"],
            tool_call_id=request["tool_call_id"],
            action=request["action"],
            action_sha256=expected_action_sha256,
            contract_id=requirement.contract_id,
            assertion_ids=assertion_ids,
            observed_at=_format_utc(observed_at),
            artifact_sha256=expected_artifact_sha256,
            request_sha256=expected_request_sha256,
            payload_sha256=expected_payload_sha256,
            success=success,
            verification_method="hmac-sha256",
            signing_key_id=self._signing_key_id,
            executor_version=executor_version,
            contract_sha256=requirement.contract_sha256,
            request_ordinal=request["request_ordinal"],
            attestation_kind=verified_attestation_kind,
            request_envelope=retained_request,
            signed_receipt=retained_receipt,
            artifact_manifest=retained_artifact,
        )


class HttpTrustedToolExecutor:
    """Calls a controlled executor with bounded, non-redirecting HTTP."""

    def __init__(
        self,
        url: str,
        request_hmac_key: bytes,
        *,
        request_key_id: str,
        bearer_token: str | None = None,
        timeout_s: float = 60.0,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        _validate_executor_url(url)
        _validate_hmac_key(request_hmac_key)
        _validate_run_identifier(request_key_id, "request_key_id")
        if timeout_s <= 0:
            raise ValueError("timeout_s must be positive")
        self._url = url
        self._request_hmac_key = bytes(request_hmac_key)
        self._request_key_id = request_key_id
        self._bearer_token = bearer_token
        self._timeout_s = timeout_s
        self._http_client = http_client

    async def execute(self, context: TrustedExecutionContext) -> ExternalToolExecution:
        """Send one authenticated request and parse it under a hard byte cap."""
        body = execution_request_body(context)
        body_bytes = canonical_json_bytes(body)
        timestamp = _format_utc(datetime.now(timezone.utc))
        request_signature = hmac.new(
            self._request_hmac_key,
            timestamp.encode("utf-8") + b"\n" + body_bytes,
            hashlib.sha256,
        ).hexdigest()
        headers = {
            "Accept": "application/json",
            "Accept-Encoding": "identity",
            "Content-Type": "application/json",
            "X-LifeOps-Key-Id": self._request_key_id,
            "X-LifeOps-Timestamp": timestamp,
            "X-LifeOps-Signature": request_signature,
        }
        if self._bearer_token:
            headers["Authorization"] = f"Bearer {self._bearer_token}"

        if self._http_client is not None:
            return await self._stream_response(
                self._http_client,
                body_bytes,
                headers,
            )
        async with httpx.AsyncClient(
            trust_env=False,
            follow_redirects=False,
        ) as client:
            return await self._stream_response(client, body_bytes, headers)

    async def _stream_response(
        self,
        client: httpx.AsyncClient,
        body_bytes: bytes,
        headers: dict[str, str],
    ) -> ExternalToolExecution:
        try:
            async with client.stream(
                "POST",
                self._url,
                content=body_bytes,
                headers=headers,
                timeout=self._timeout_s,
                follow_redirects=False,
            ) as response:
                if response.is_redirect:
                    raise EvidenceVerificationError(
                        "trusted executor redirects are forbidden"
                    )
                if response.status_code < 200 or response.status_code >= 300:
                    raise EvidenceVerificationError(
                        "trusted executor returned "
                        f"HTTP {response.status_code}; provider outcome is unknown"
                    )
                content_type = response.headers.get("content-type", "").split(
                    ";", 1
                )[0].strip().lower()
                if content_type != "application/json":
                    raise EvidenceVerificationError(
                        "trusted executor response must be application/json"
                    )
                content_encoding = response.headers.get(
                    "content-encoding", "identity"
                ).strip().lower()
                if content_encoding not in {"", "identity"}:
                    raise EvidenceVerificationError(
                        "trusted executor response compression is forbidden"
                    )
                chunks: list[bytes] = []
                received = 0
                async for chunk in response.aiter_bytes():
                    received += len(chunk)
                    if received > _MAX_RESPONSE_BYTES:
                        raise EvidenceVerificationError(
                            "trusted executor response exceeds the protocol limit"
                        )
                    chunks.append(chunk)
        except httpx.HTTPError as exc:
            raise EvidenceVerificationError(
                "trusted executor transport failed; provider outcome is unknown"
            ) from exc

        try:
            raw = json.loads(b"".join(chunks))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise EvidenceVerificationError(
                "trusted executor returned invalid JSON"
            ) from exc
        _validate_json_limits(raw)
        if not isinstance(raw, dict):
            raise EvidenceVerificationError(
                "trusted executor response must be a JSON object"
            )
        if raw.get("schema") != EXTERNAL_RESPONSE_SCHEMA:
            raise EvidenceVerificationError(
                "trusted executor returned an unsupported response schema"
            )
        payload = raw.get("payload")
        artifact_manifest = raw.get("artifact")
        receipt = raw.get("receipt")
        if (
            not isinstance(payload, dict)
            or not isinstance(artifact_manifest, dict)
            or not isinstance(receipt, dict)
        ):
            raise EvidenceVerificationError(
                "trusted executor response lacks payload, artifact, or receipt"
            )
        return ExternalToolExecution(
            payload=payload,
            artifact_manifest=artifact_manifest,
            receipt=receipt,
        )


def mark_deterministic_lifeworld_result(payload: dict[str, Any]) -> dict[str, Any]:
    """Stamp runner-owned provenance so simulation cannot masquerade as E2E."""
    marked = dict(payload)
    marked[EXECUTION_METADATA_KEY] = {
        "boundary": DETERMINISTIC_LIFEWORLD_BOUNDARY,
        "receiptAuthenticated": False,
        "executionSucceeded": payload.get("ok") is True,
    }
    return marked


def mark_authenticated_external_result(
    payload: dict[str, Any],
    receipt: VerifiedEvidenceReceipt,
) -> dict[str, Any]:
    """Expose a non-secret status summary without calling payload data verified."""
    marked = {
        key: value
        for key, value in payload.items()
        if key != EXECUTION_METADATA_KEY
    }
    marked[EXECUTION_METADATA_KEY] = {
        "boundary": receipt.boundary,
        "receiptAuthenticated": True,
        "executionSucceeded": receipt.success,
        "receiptId": receipt.receipt_id,
        "artifactSha256": receipt.artifact_sha256,
        "payloadSha256": receipt.payload_sha256,
    }
    return marked


def verify_result_trusted_evidence(
    scenario: Scenario,
    turns: Iterable[TurnResult],
    *,
    seed: int,
    verifier: TrustedEvidenceVerifier | None,
) -> TrustedEvidenceVerification:
    """Re-authenticate all retained envelopes and require a final snapshot."""
    requirement = scenario.trusted_evidence_requirement
    if requirement is None:
        return TrustedEvidenceVerification(
            satisfied=True,
            reason="scenario does not require authenticated external evidence",
        )
    if verifier is None:
        return TrustedEvidenceVerification(
            satisfied=False,
            reason="no receipt verifier was supplied to the scorer",
        )
    if (
        not requirement.contract_id.strip()
        or requirement.contract_version <= 0
        or not _SHA256_PATTERN.fullmatch(requirement.contract_sha256)
        or not requirement.required_assertion_ids
        or not requirement.allowed_actions
    ):
        return TrustedEvidenceVerification(
            satisfied=False,
            reason="trusted evidence requirement is empty or malformed",
        )

    records: list[VerifiedEvidenceReceipt] = []
    rejection_reasons: list[str] = []
    for turn in turns:
        results_by_call: dict[str, tuple[str, dict[str, Any]]] = {}
        for result in turn.tool_results:
            call_id = result.get("tool_call_id")
            action_name = result.get("name")
            payload = result.get("payload")
            if (
                isinstance(call_id, str)
                and isinstance(action_name, str)
                and isinstance(payload, dict)
            ):
                if call_id in results_by_call:
                    rejection_reasons.append(
                        f"tool_call_id {call_id!r} appears more than once"
                    )
                    continue
                results_by_call[call_id] = (action_name, payload)
        if len(turn.verified_evidence) != len(results_by_call):
            rejection_reasons.append(
                f"turn {turn.turn_number} does not have one receipt per tool result"
            )
        for stored in turn.verified_evidence:
            matched_result = results_by_call.get(stored.tool_call_id)
            if matched_result is None:
                rejection_reasons.append(
                    f"receipt {stored.receipt_id!r} has no matching tool result"
                )
                continue
            result_action, marked_payload = matched_result
            if result_action != stored.action:
                rejection_reasons.append(
                    f"receipt {stored.receipt_id!r} action does not match "
                    "its tool result"
                )
                continue
            payload = {
                key: value
                for key, value in marked_payload.items()
                if key != EXECUTION_METADATA_KEY
            }
            try:
                verified = verifier.verify_stored(
                    stored,
                    payload,
                    requirement,
                )
            except EvidenceVerificationError as exc:
                rejection_reasons.append(str(exc))
                continue
            if verified.scenario_id != scenario.id or verified.seed != seed:
                rejection_reasons.append(
                    f"receipt {verified.receipt_id!r} belongs to another "
                    "scenario or seed"
                )
                continue
            records.append(verified)

    if rejection_reasons:
        return TrustedEvidenceVerification(
            satisfied=False,
            reason="; ".join(dict.fromkeys(rejection_reasons)),
        )
    if not records:
        return TrustedEvidenceVerification(
            satisfied=False,
            reason=(
                f"trusted evidence contract {requirement.contract_id!r} has "
                "no authenticated external receipts"
            ),
        )
    receipt_ids = [record.receipt_id for record in records]
    ordinals = [record.request_ordinal for record in records]
    tool_call_ids = [record.tool_call_id for record in records]
    if len(receipt_ids) != len(set(receipt_ids)):
        return TrustedEvidenceVerification(
            satisfied=False,
            reason="trusted evidence reuses a receipt_id within one run",
        )
    if len(ordinals) != len(set(ordinals)) or ordinals != sorted(ordinals):
        return TrustedEvidenceVerification(
            satisfied=False,
            reason="trusted evidence request ordinals are duplicated or out of order",
        )
    if len(tool_call_ids) != len(set(tool_call_ids)):
        return TrustedEvidenceVerification(
            satisfied=False,
            reason="trusted evidence reuses a tool_call_id within one run",
        )
    if len({record.run_id for record in records}) != 1:
        return TrustedEvidenceVerification(
            satisfied=False,
            reason="trusted receipts span multiple benchmark runs",
        )

    final = records[-1]
    if not final.success:
        return TrustedEvidenceVerification(
            satisfied=False,
            reason=f"final receipt {final.receipt_id!r} records failure",
        )
    if (
        requirement.terminal_attestation_required
        and final.attestation_kind != "terminal_postcondition"
    ):
        return TrustedEvidenceVerification(
            satisfied=False,
            reason="final external action has no terminal postcondition attestation",
        )
    required_assertions = set(requirement.required_assertion_ids)
    covered_assertions = set(final.assertion_ids)
    missing = sorted(required_assertions - covered_assertions)
    unexpected = sorted(covered_assertions - required_assertions)
    if missing or unexpected:
        detail: list[str] = []
        if missing:
            detail.append("missing: " + ", ".join(missing))
        if unexpected:
            detail.append("unexpected: " + ", ".join(unexpected))
        return TrustedEvidenceVerification(
            satisfied=False,
            reason=(
                f"terminal evidence for contract {requirement.contract_id!r} "
                + "; ".join(detail)
            ),
        )
    return TrustedEvidenceVerification(
        satisfied=True,
        reason=(
            f"terminal authenticated artifact covers "
            f"{len(required_assertions)} required world assertions"
        ),
        receipt_ids=tuple(receipt_ids),
    )


def _parse_request_envelope(value: dict[str, Any]) -> _ParsedRequest:
    if value.get("schema") != EXTERNAL_REQUEST_SCHEMA:
        raise EvidenceVerificationError("request envelope schema is invalid")
    action = value.get("action")
    contract = value.get("evidence_contract")
    if not isinstance(action, dict) or not isinstance(contract, dict):
        raise EvidenceVerificationError(
            "request envelope lacks action or evidence contract"
        )
    run_id = _require_nonempty_string(value, "run_id")
    run_nonce = _require_nonempty_string(value, "run_nonce")
    scenario_id = _require_nonempty_string(value, "scenario_id")
    tool_call_id = _require_nonempty_string(value, "tool_call_id")
    action_name = _require_nonempty_string(action, "name")
    action_digest = _require_nonempty_string(action, "sha256")
    contract_id = _require_nonempty_string(contract, "contract_id")
    contract_digest = _require_nonempty_string(contract, "contract_sha256")
    _validate_run_identifier(run_id, "run_id")
    _validate_run_identifier(run_nonce, "run_nonce")
    _validate_tool_call_id(tool_call_id)
    _validate_action_name(action_name)
    if not _SHA256_PATTERN.fullmatch(action_digest):
        raise EvidenceVerificationError("request action digest is invalid")
    if not _SHA256_PATTERN.fullmatch(contract_digest):
        raise EvidenceVerificationError("request contract digest is invalid")
    kwargs = action.get("kwargs")
    if not isinstance(kwargs, dict):
        raise EvidenceVerificationError("request action kwargs must be an object")
    if action_digest != action_sha256(Action(name=action_name, kwargs=kwargs)):
        raise EvidenceVerificationError("request action digest mismatch")
    seed = value.get("seed")
    ordinal = value.get("request_ordinal")
    contract_version = contract.get("contract_version")
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise EvidenceVerificationError("request seed must be an integer")
    if not isinstance(ordinal, int) or isinstance(ordinal, bool) or ordinal <= 0:
        raise EvidenceVerificationError(
            "request ordinal must be a positive integer"
        )
    if (
        not isinstance(contract_version, int)
        or isinstance(contract_version, bool)
        or contract_version <= 0
    ):
        raise EvidenceVerificationError(
            "request contract version must be a positive integer"
        )
    _parse_aware_datetime(
        _require_nonempty_string(value, "run_started_at"),
        "run_started_at",
    )
    _parse_aware_datetime(
        _require_nonempty_string(value, "requested_at"),
        "requested_at",
    )
    return {
        "run_id": run_id,
        "run_nonce": run_nonce,
        "scenario_id": scenario_id,
        "seed": seed,
        "tool_call_id": tool_call_id,
        "request_ordinal": ordinal,
        "action": action_name,
        "action_sha256": action_digest,
        "contract_id": contract_id,
        "contract_version": contract_version,
        "contract_sha256": contract_digest,
    }


def _validate_artifact_manifest(
    artifact: dict[str, Any],
    *,
    request: _ParsedRequest,
    requirement: TrustedEvidenceRequirement,
    provider: str,
    boundary: str,
    executor_version: str,
    observed_at: str,
) -> tuple[tuple[str, ...], bool]:
    _expect_equal(artifact, "schema", ARTIFACT_SCHEMA)
    for field in (
        "run_nonce",
        "scenario_id",
        "seed",
        "tool_call_id",
        "request_ordinal",
        "action",
        "action_sha256",
    ):
        _expect_equal(artifact, field, request[field])
    _expect_equal(artifact, "contract_id", requirement.contract_id)
    _expect_equal(
        artifact,
        "contract_version",
        requirement.contract_version,
    )
    _expect_equal(artifact, "contract_sha256", requirement.contract_sha256)
    _expect_equal(artifact, "provider", provider)
    _expect_equal(artifact, "boundary", boundary)
    _expect_equal(artifact, "executor_version", executor_version)
    _expect_equal(artifact, "observed_at", observed_at)
    terminal = artifact.get("terminal")
    if not isinstance(terminal, bool):
        raise EvidenceVerificationError("artifact terminal must be boolean")

    lineage = artifact.get("action_lineage")
    if not isinstance(lineage, list) or not lineage:
        raise EvidenceVerificationError(
            "artifact action_lineage must be a non-empty list"
        )
    lineage_ordinals = [
        entry.get("request_ordinal")
        for entry in lineage
        if isinstance(entry, dict)
    ]
    if (
        len(lineage_ordinals) != len(lineage)
        or not all(
            isinstance(ordinal, int) and not isinstance(ordinal, bool)
            for ordinal in lineage_ordinals
        )
        or lineage_ordinals
        != list(range(1, request["request_ordinal"] + 1))
    ):
        raise EvidenceVerificationError(
            "artifact action lineage is incomplete or out of order"
        )
    current_lineage = [
        entry
        for entry in lineage
        if isinstance(entry, dict)
        and entry.get("request_ordinal") == request["request_ordinal"]
    ]
    if len(current_lineage) != 1:
        raise EvidenceVerificationError(
            "artifact does not contain exactly one current action lineage entry"
        )
    current = current_lineage[0]
    for field in ("tool_call_id", "action", "action_sha256"):
        _expect_equal(current, field, request[field])

    assertion_results = artifact.get("assertions")
    if not isinstance(assertion_results, list):
        raise EvidenceVerificationError("artifact assertions must be a list")
    passed: list[str] = []
    seen: set[str] = set()
    allowed = set(requirement.required_assertion_ids)
    for entry in assertion_results:
        if not isinstance(entry, dict):
            raise EvidenceVerificationError(
                "artifact assertion entries must be objects"
            )
        assertion_id = _require_nonempty_string(entry, "assertion_id")
        if assertion_id in seen:
            raise EvidenceVerificationError(
                f"artifact repeats assertion {assertion_id!r}"
            )
        seen.add(assertion_id)
        if assertion_id not in allowed:
            raise EvidenceVerificationError(
                f"artifact includes assertion {assertion_id!r} outside contract"
            )
        passed_value = entry.get("passed")
        if not isinstance(passed_value, bool):
            raise EvidenceVerificationError(
                f"artifact assertion {assertion_id!r} lacks boolean passed"
            )
        subject = _require_nonempty_string(entry, "subject")
        revision = _require_nonempty_string(entry, "revision")
        if not subject or not revision:
            raise EvidenceVerificationError(
                f"artifact assertion {assertion_id!r} lacks subject or revision"
            )
        evidence = entry.get("evidence")
        if not isinstance(evidence, dict) or not evidence:
            raise EvidenceVerificationError(
                f"artifact assertion {assertion_id!r} lacks evidence"
            )
        _require_nonempty_string(evidence, "kind")
        _require_nonempty_string(evidence, "reference")
        if passed_value:
            passed.append(assertion_id)
    return tuple(passed), terminal


def _validate_json_limits(value: Any) -> None:
    item_count = 0

    def visit(candidate: Any, depth: int) -> None:
        nonlocal item_count
        if depth > _MAX_JSON_DEPTH:
            raise EvidenceVerificationError("evidence JSON nesting is too deep")
        item_count += 1
        if item_count > _MAX_JSON_ITEMS:
            raise EvidenceVerificationError("evidence JSON has too many values")
        if isinstance(candidate, str):
            if len(candidate.encode("utf-8")) > _MAX_JSON_STRING:
                raise EvidenceVerificationError(
                    "evidence JSON contains an oversized string"
                )
            return
        if candidate is None or isinstance(candidate, (bool, int, float)):
            return
        if isinstance(candidate, list):
            for item in candidate:
                visit(item, depth + 1)
            return
        if isinstance(candidate, dict):
            for key, item in candidate.items():
                if not isinstance(key, str):
                    raise EvidenceVerificationError(
                        "evidence JSON object keys must be strings"
                    )
                visit(key, depth + 1)
                visit(item, depth + 1)
            return
        raise EvidenceVerificationError(
            f"evidence JSON contains unsupported type {type(candidate).__name__}"
        )

    visit(value, 0)


def _expect_equal(record: dict[str, Any], field: str, expected: Any) -> None:
    actual = record.get(field)
    if actual != expected:
        raise EvidenceVerificationError(
            f"executor evidence {field} mismatch: expected {expected!r}"
        )


def _require_nonempty_string(record: dict[str, Any], field: str) -> str:
    value = record.get(field)
    if not isinstance(value, str) or not value.strip():
        raise EvidenceVerificationError(
            f"executor evidence {field} must be a non-empty string"
        )
    return value.strip()


def _require_identifier(record: dict[str, Any], field: str) -> str:
    value = _require_nonempty_string(record, field)
    if not _IDENTIFIER_PATTERN.fullmatch(value):
        raise EvidenceVerificationError(
            f"executor evidence {field} has invalid syntax"
        )
    return value


def _parse_aware_datetime(value: str, field: str) -> datetime:
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise EvidenceVerificationError(
            f"executor evidence {field} must be an ISO timestamp"
        ) from exc
    if parsed.tzinfo is None:
        raise EvidenceVerificationError(
            f"executor evidence {field} must include a timezone"
        )
    return parsed.astimezone(timezone.utc)


def _format_utc(value: datetime) -> str:
    _require_aware(value, "timestamp")
    return (
        value.astimezone(timezone.utc)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


def _require_aware(value: datetime, field: str) -> None:
    if value.tzinfo is None or value.utcoffset() is None:
        raise EvidenceVerificationError(f"{field} must be timezone-aware")


def _validate_hmac_key(key: bytes) -> None:
    if not isinstance(key, bytes) or len(key) < _MIN_HMAC_KEY_BYTES:
        raise ValueError(
            f"executor HMAC key must contain at least {_MIN_HMAC_KEY_BYTES} bytes"
        )


def _validate_run_identifier(value: str, field: str) -> None:
    if not _IDENTIFIER_PATTERN.fullmatch(value):
        raise EvidenceVerificationError(f"{field} has invalid syntax")


def _validate_tool_call_id(value: str) -> None:
    if not _TOOL_CALL_ID_PATTERN.fullmatch(value):
        raise EvidenceVerificationError("tool_call_id has invalid syntax")


def _validate_action_name(value: str) -> None:
    if not _OPENAI_ACTION_PATTERN.fullmatch(value):
        raise EvidenceVerificationError("external action name has invalid syntax")


def _validate_executor_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme == "https" and parsed.netloc:
        return
    if parsed.scheme == "http" and parsed.hostname in {
        "127.0.0.1",
        "::1",
        "localhost",
    }:
        return
    raise ValueError(
        "trusted executor URL must use HTTPS, or HTTP on an explicit loopback host"
    )
