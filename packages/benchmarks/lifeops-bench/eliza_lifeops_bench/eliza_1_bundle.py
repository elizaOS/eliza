"""Reader for the eliza-1 GGUF bundle directory format (Python mirror).

Mirrors ``packages/benchmarks/lib/src/eliza-1-bundle.ts`` field-for-field. Keep
the release-state semantics and the ``bundle_is_pre_release`` predicate in
lockstep with the TS module — every harness reads from the same on-disk
contract.

Release-state semantics (from ``ELIZA_1_PRODUCTION_READINESS_REVIEW.md``):
- ``local-standin`` — synthesized/quantized standin weights for plumbing only.
- ``candidate``     — release-candidate weights from the real training run.
- ``final``         — promoted release.

``bundle_is_pre_release`` returns True unless ALL THREE of
``release_state=final``, ``publish_eligible=True``, and ``final.weights=True``
hold. AGENTS.md Cmd #8 forbids silently coercing ``pre_release=True -> False``.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Optional

ElizaOneModelSize = Literal["0.8b", "2b", "9b", "27b", "27b-1m"]
ElizaOneReleaseState = Literal["local-standin", "candidate", "final"]

ELIZA_ONE_MODEL_SIZES: tuple[ElizaOneModelSize, ...] = (
    "0.8b",
    "2b",
    "9b",
    "27b",
    "27b-1m",
)

ELIZA_ONE_RELEASE_STATES: tuple[ElizaOneReleaseState, ...] = (
    "local-standin",
    "candidate",
    "final",
)


@dataclass(frozen=True)
class ElizaOneBundleFinal:
    weights: bool


@dataclass(frozen=True)
class ElizaOneBundleManifest:
    bundle_id: str
    model_size: ElizaOneModelSize
    release_state: ElizaOneReleaseState
    publish_eligible: bool
    final: ElizaOneBundleFinal
    weights_path: str
    sha256: str
    drafters_path: Optional[str] = None


def _expand_home(value: str) -> str:
    if not value:
        return value
    if value == "~":
        return os.path.expanduser("~")
    if value.startswith("~/"):
        return os.path.join(os.path.expanduser("~"), value[2:])
    return value


def read_eliza_one_bundle(bundle_path: str) -> ElizaOneBundleManifest:
    """Read and validate ``manifest.json`` inside an eliza-1 bundle directory.

    Raises ``FileNotFoundError`` for missing paths and ``ValueError`` for
    schema violations. Mirrors the TS reader so the harness fails the same
    way regardless of language.
    """
    resolved = Path(_expand_home(bundle_path)).resolve()
    if not resolved.exists():
        raise FileNotFoundError(
            f"eliza-1 bundle directory does not exist: {resolved}"
        )
    if not resolved.is_dir():
        raise ValueError(f"eliza-1 bundle path is not a directory: {resolved}")
    manifest_path = resolved / "manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(
            f"eliza-1 bundle is missing manifest.json: {manifest_path}"
        )

    try:
        parsed = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"eliza-1 manifest.json is not valid JSON ({manifest_path}): {exc}"
        ) from exc

    if not isinstance(parsed, dict):
        raise ValueError(f"eliza-1 manifest.json must be an object: {manifest_path}")

    bundle_id = parsed.get("bundleId")
    if not isinstance(bundle_id, str) or not bundle_id:
        raise ValueError(
            f"eliza-1 manifest.json missing required string field 'bundleId': {manifest_path}"
        )

    model_size = parsed.get("modelSize")
    if model_size not in ELIZA_ONE_MODEL_SIZES:
        raise ValueError(
            f"eliza-1 manifest.json has invalid 'modelSize' ({model_size!r}); "
            f"expected one of {', '.join(ELIZA_ONE_MODEL_SIZES)}"
        )

    release_state = parsed.get("releaseState")
    if release_state not in ELIZA_ONE_RELEASE_STATES:
        raise ValueError(
            f"eliza-1 manifest.json has invalid 'releaseState' ({release_state!r}); "
            f"expected one of {', '.join(ELIZA_ONE_RELEASE_STATES)}"
        )

    publish_eligible = parsed.get("publishEligible")
    if not isinstance(publish_eligible, bool):
        raise ValueError(
            f"eliza-1 manifest.json missing required boolean field 'publishEligible': {manifest_path}"
        )

    final_raw = parsed.get("final")
    if not isinstance(final_raw, dict):
        raise ValueError(
            f"eliza-1 manifest.json missing required object field 'final': {manifest_path}"
        )
    final_weights = final_raw.get("weights")
    if not isinstance(final_weights, bool):
        raise ValueError(
            f"eliza-1 manifest.json missing required boolean field 'final.weights': {manifest_path}"
        )

    weights_raw = parsed.get("weightsPath")
    if not isinstance(weights_raw, str) or not weights_raw:
        raise ValueError(
            f"eliza-1 manifest.json missing required string field 'weightsPath': {manifest_path}"
        )
    weights_path = (
        weights_raw
        if os.path.isabs(weights_raw)
        else str(resolved / weights_raw)
    )
    if not Path(weights_path).exists():
        raise FileNotFoundError(
            f"eliza-1 bundle weights file does not exist: {weights_path} "
            f"(referenced by {manifest_path})"
        )

    drafters_path: Optional[str] = None
    drafters_raw = parsed.get("draftersPath")
    if isinstance(drafters_raw, str) and drafters_raw:
        candidate = (
            drafters_raw
            if os.path.isabs(drafters_raw)
            else str(resolved / drafters_raw)
        )
        if not Path(candidate).exists():
            raise FileNotFoundError(
                f"eliza-1 bundle drafters file does not exist: {candidate} "
                f"(referenced by {manifest_path})"
            )
        drafters_path = candidate

    sha256 = parsed.get("sha256")
    if not isinstance(sha256, str) or not sha256:
        raise ValueError(
            f"eliza-1 manifest.json missing required string field 'sha256': {manifest_path}"
        )

    return ElizaOneBundleManifest(
        bundle_id=bundle_id,
        model_size=model_size,  # type: ignore[arg-type]
        release_state=release_state,  # type: ignore[arg-type]
        publish_eligible=publish_eligible,
        final=ElizaOneBundleFinal(weights=final_weights),
        weights_path=weights_path,
        drafters_path=drafters_path,
        sha256=sha256,
    )


def bundle_is_pre_release(manifest: ElizaOneBundleManifest) -> bool:
    """Return True when the bundle MUST be labeled ``pre-release`` downstream.

    Publication-ready bundles must clear every gate: ``release_state=final``,
    ``publish_eligible=True``, and ``final.weights=True``. Anything less keeps
    the pre-release flag on, matching ``bundleIsPreRelease`` in the TS sibling.
    """
    if manifest.release_state != "final":
        return True
    if not manifest.publish_eligible:
        return True
    if not manifest.final.weights:
        return True
    return False


__all__ = [
    "ELIZA_ONE_MODEL_SIZES",
    "ELIZA_ONE_RELEASE_STATES",
    "ElizaOneBundleFinal",
    "ElizaOneBundleManifest",
    "ElizaOneModelSize",
    "ElizaOneReleaseState",
    "bundle_is_pre_release",
    "read_eliza_one_bundle",
]
