#!/usr/bin/env python3
"""Exercise the agent TEE-evidence policy DECISIONS against chip-side fixtures (06 WI-2).

This is the chip-side proof of the cross-layer attestation contract: the chip
emits evidence in the TeeEvidence shape, and the agent verifier
evaluateTeeEvidencePolicy (packages/agent/src/services/tee-policy.ts) must reach
the expected decision. The evaluator below is a faithful Python port of that
TypeScript function — same decision order, same reason union, same normalization
rules from tee-evidence.ts (normalizeTeeEvidence / teeMeasurementDigestMatches /
detectSimulatedEvidence). The fixtures in docs/spec-db/tee-evidence-policy-fixtures.json
mirror the agent's tee-evidence-policy.matrix.test.ts and pin each expected reason.

Honest-approach note: the agent verifier is TypeScript and not importable from a
chip-side python gate without a node round-trip. Porting the pure decision
function (no crypto, no I/O) keeps the gate self-contained and fail-closed; the
serializer round-trip against the real cove_quote.c / cove-quote.ts is gated
separately by check_cove_quote.py (owned by the parallel chip agent). If the
agent reason union changes, the REASONS set assertion here fails closed.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "docs/spec-db/tee-evidence-policy-fixtures.json"
SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")

# The full reason union from tee-policy.ts TeeEvidencePolicyDecision. If the
# agent type changes, this gate must be updated in lockstep (fail-closed).
REASONS = {
    "no-policy",
    "not-required",
    "allowed",
    "missing-evidence",
    "invalid-evidence",
    "simulated-evidence-rejected",
    "kind-not-allowed",
    "provider-not-allowed",
    "measurement-mismatch",
    "measurement-revoked",
    "security-version-too-low",
    "security-version-revoked",
    "missing-nonce",
    "nonce-mismatch",
    "missing-timestamp",
    "timestamp-invalid",
    "timestamp-stale",
    "claim-mismatch",
}

CLAIM_KEYS = (
    "debugDisabled",
    "productionLifecycle",
    "secureBoot",
    "memoryEncrypted",
    "ioProtected",
    "gpuProtected",
    "npuProtected",
    "monitorMeasured",
)


class InvalidEvidence(Exception):
    pass


def _opt_str(value: dict[str, Any], key: str) -> str | None:
    raw = value.get(key)
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise InvalidEvidence(f'TEE evidence field "{key}" must be a string.')
    trimmed = raw.strip()
    return trimmed or None


def normalize_evidence(value: Any) -> dict[str, Any]:
    """Port of normalizeTeeEvidence: kind is required, everything else optional."""
    if not isinstance(value, dict):
        raise InvalidEvidence("TEE evidence must be an object.")
    kind = _opt_str(value, "kind")
    if kind is None:
        raise InvalidEvidence('TEE evidence field "kind" is required.')
    out: dict[str, Any] = {"kind": kind}
    for field in ("provider", "hardwareVendor", "platformVersion", "quote", "reportData"):
        got = _opt_str(value, field)
        if got is not None:
            out[field] = got
    sv = value.get("securityVersion")
    if sv is not None:
        if not isinstance(sv, int) or isinstance(sv, bool):
            raise InvalidEvidence('TEE evidence field "securityVersion" must be an integer.')
        out["securityVersion"] = sv
    measurements = value.get("measurements")
    if measurements is not None:
        if not isinstance(measurements, dict):
            raise InvalidEvidence("TEE evidence measurements must be an object.")
        norm_m: dict[str, str] = {}
        for k, raw in measurements.items():
            if not isinstance(raw, str):
                raise InvalidEvidence(f'TEE measurement "{k}" must be a string.')
            if raw.strip():
                norm_m[k] = raw.strip()
        if norm_m:
            out["measurements"] = norm_m
    freshness = value.get("freshness")
    if isinstance(freshness, dict):
        norm_f: dict[str, str] = {}
        for k in ("nonce", "timestamp", "verifier"):
            got = _opt_str(freshness, k)
            if got is not None:
                norm_f[k] = got
        if norm_f:
            out["freshness"] = norm_f
    claims = value.get("claims")
    if isinstance(claims, dict):
        norm_c: dict[str, bool] = {}
        for k in CLAIM_KEYS:
            if k in claims and claims[k] is not None:
                if not isinstance(claims[k], bool):
                    raise InvalidEvidence(f'TEE claim "{k}" must be boolean.')
                norm_c[k] = claims[k]
        if norm_c:
            out["claims"] = norm_c
    return out


def _norm_digest(value: str) -> str:
    t = value.strip().lower()
    return t[len("sha256:") :] if t.startswith("sha256:") else t


def digest_matches(actual: str | None, expected: str | None) -> bool:
    if expected is None:
        return True
    if actual is None:
        return False
    return _norm_digest(actual) == _norm_digest(expected)


def detect_simulated(ev: dict[str, Any]) -> str | None:
    """Port of detectSimulatedEvidence."""
    kind = ev["kind"].lower()
    if kind == "none" or any(t in kind for t in ("mock", "sim", "fake", "debug")):
        return f'TEE kind "{ev["kind"]}" indicates a non-production attestation.'
    vendor = ev.get("hardwareVendor")
    if vendor is not None and (vendor.lower().startswith("mock") or "sim" in vendor.lower()):
        return "non-production hardwareVendor"
    provider = ev.get("provider")
    if provider is not None and any(t in provider.lower() for t in ("mock", "sim", "fake")):
        return "non-production provider"
    quote = ev.get("quote")
    if quote is not None and any(
        t in quote.lower() for t in ("simulated", "mock", "fake", "debug", "devmode")
    ):
        return "TEE quote is marked simulated/debug/devmode."
    verifier = ev.get("freshness", {}).get("verifier")
    if verifier is not None and any(
        t in verifier.lower() for t in ("mock", "sim", "local-smoke", "local")
    ):
        return "non-production verifier"
    return None


def evaluate(evidence_input: Any, policy: dict[str, Any] | None, now_ms: int) -> dict[str, Any]:
    """Faithful port of evaluateTeeEvidencePolicy (tee-policy.ts), same order/reasons."""
    if policy is None:
        return {"trusted": True, "reason": "no-policy"}
    if not policy.get("required") and evidence_input is None:
        return {"trusted": True, "reason": "not-required"}
    if evidence_input is None:
        return {"trusted": False, "reason": "missing-evidence"}

    try:
        evidence = normalize_evidence(evidence_input)
    except InvalidEvidence as exc:
        return {"trusted": False, "reason": "invalid-evidence", "detail": str(exc)}

    if policy.get("rejectSimulatedEvidence"):
        sim = detect_simulated(evidence)
        if sim is not None:
            return {"trusted": False, "reason": "simulated-evidence-rejected", "detail": sim}

    allowed_kinds = policy.get("allowedKinds")
    if allowed_kinds is not None and evidence["kind"] not in allowed_kinds:
        return {"trusted": False, "reason": "kind-not-allowed"}

    allowed_providers = policy.get("allowedProviders")
    if allowed_providers is not None and evidence.get("provider") not in allowed_providers:
        return {"trusted": False, "reason": "provider-not-allowed"}

    measurements = evidence.get("measurements", {})
    for name, expected in (policy.get("requiredMeasurements") or {}).items():
        if not digest_matches(measurements.get(name), expected):
            return {"trusted": False, "reason": "measurement-mismatch", "detail": name}

    for name, revoked in (policy.get("revokedMeasurements") or {}).items():
        actual = measurements.get(name)
        if actual is not None and any(digest_matches(actual, d) for d in (revoked or [])):
            return {"trusted": False, "reason": "measurement-revoked", "detail": name}

    min_sv = policy.get("minSecurityVersion")
    if min_sv is not None and (
        evidence.get("securityVersion") is None or evidence["securityVersion"] < min_sv
    ):
        return {"trusted": False, "reason": "security-version-too-low"}
    sv = evidence.get("securityVersion")
    if sv is not None and sv in (policy.get("revokedSecurityVersions") or []):
        return {"trusted": False, "reason": "security-version-revoked"}

    expected_nonce = policy.get("expectedNonce")
    if expected_nonce is not None:
        nonce = evidence.get("freshness", {}).get("nonce")
        if nonce is None:
            return {"trusted": False, "reason": "missing-nonce"}
        if nonce != expected_nonce:
            return {"trusted": False, "reason": "nonce-mismatch"}

    max_age = policy.get("maxAgeMs")
    if max_age is not None:
        timestamp = evidence.get("freshness", {}).get("timestamp")
        if timestamp is None:
            return {"trusted": False, "reason": "missing-timestamp"}
        ts_ms = _parse_iso_ms(timestamp)
        if ts_ms is None:
            return {"trusted": False, "reason": "timestamp-invalid"}
        if ts_ms > now_ms + 60_000 or now_ms - ts_ms > max_age:
            return {"trusted": False, "reason": "timestamp-stale"}

    claims = evidence.get("claims", {})
    for claim, expected in (policy.get("requiredClaims") or {}).items():
        if claims.get(claim) != expected:
            return {"trusted": False, "reason": "claim-mismatch", "detail": claim}

    return {"trusted": True, "reason": "allowed"}


def _parse_iso_ms(value: str) -> int | None:
    """Mirror Date.parse for the RFC3339 form the fixtures use; None when unparseable."""
    from datetime import UTC, datetime

    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return int(parsed.timestamp() * 1000)


def _deep_merge(base: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    out = json.loads(json.dumps(base))
    out.update(overrides)
    return out


def build_case(
    fixtures: dict[str, Any], case: dict[str, Any]
) -> tuple[Any, dict[str, Any] | None, int]:
    now_ms = case.get("now_ms", fixtures["now_ms"])

    if "evidence_raw" in case:
        evidence: Any = case["evidence_raw"]
    elif case.get("evidence", "unset") is None:
        evidence = None
    else:
        evidence = json.loads(json.dumps(fixtures["golden_evidence"]))
        for key, value in case.get("evidence_overrides", {}).items():
            evidence[key] = value
        for key, value in case.get("evidence_measurement_overrides", {}).items():
            evidence["measurements"][key] = value
        for key, value in case.get("evidence_freshness_overrides", {}).items():
            if value is None:
                evidence["freshness"].pop(key, None)
            else:
                evidence["freshness"][key] = value
        for key, value in case.get("evidence_claim_overrides", {}).items():
            evidence["claims"][key] = value

    if "policy" in case:
        policy = case["policy"]
    else:
        policy = _deep_merge(fixtures["golden_policy"], case.get("policy_overrides", {}))

    return evidence, policy, now_ms


def main(argv: list[str]) -> int:
    fixtures_path = Path(argv[1]) if len(argv) > 1 else FIXTURES
    fixtures = json.loads(fixtures_path.read_text(encoding="utf-8"))

    cases = fixtures["cases"]
    seen_reasons: set[str] = set()
    failures: list[str] = []

    for case in cases:
        evidence, policy, now_ms = build_case(fixtures, case)
        decision = evaluate(evidence, policy, now_ms)
        seen_reasons.add(decision["reason"])
        expected_reason = case["expected_reason"]
        expected_trusted = case["expected_trusted"]
        if decision["reason"] != expected_reason:
            failures.append(
                f"{case['id']}: expected reason {expected_reason!r}, got {decision['reason']!r}"
                + (f" ({decision.get('detail')})" if decision.get("detail") else "")
            )
        elif decision["trusted"] != expected_trusted:
            failures.append(
                f"{case['id']}: expected trusted={expected_trusted}, got {decision['trusted']}"
            )
        else:
            print(f"PASS: {case['id']} -> {decision['reason']} (trusted={decision['trusted']})")

    # The fixture set MUST cover every reason in the agent decision union; an
    # uncovered reason means the cross-layer contract is under-tested.
    uncovered = REASONS.difference(seen_reasons)
    if uncovered:
        failures.append(
            f"reason union not fully exercised; missing: {', '.join(sorted(uncovered))}"
        )
    unknown = seen_reasons.difference(REASONS)
    if unknown:
        failures.append(
            f"evaluator produced reasons outside the agent union: {', '.join(sorted(unknown))}"
        )

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    print(f"PASS: {len(cases)} TEE evidence policy decision fixtures (full reason union covered)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
