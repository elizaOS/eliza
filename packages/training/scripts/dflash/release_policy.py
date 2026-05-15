"""Shared DFlash drafter release policy.

This is the source of truth for DFlash-specific tooling. It deliberately
separates active Eliza-1 text tiers from tiers that require a drafter.
"""

from __future__ import annotations

from typing import Any, Final, Literal

ACTIVE_TIERS: Final[tuple[str, ...]] = (
    "0_8b",
    "2b",
    "4b",
    "9b",
    "27b",
    "27b-256k",
)

DFLASH_DISABLED_TIERS: Final[tuple[str, ...]] = ("0_8b",)
DFLASH_REQUIRED_TIERS: Final[tuple[str, ...]] = tuple(
    tier for tier in ACTIVE_TIERS if tier not in DFLASH_DISABLED_TIERS
)

DFLASH_DISABLED_REASON: Final[dict[str, str]] = {
    "0_8b": (
        "The 0_8b target is already the smallest Qwen3.5 text tier. A "
        "0.8B-class drafter adds another resident model, tokenizer, KV/cache "
        "pressure, and speculative runtime overhead while offering little or "
        "negative speedup on the low-memory devices this tier targets."
    ),
}

DEFAULT_STUDENT_BASE: Final[dict[str, str]] = {
    tier: "Qwen/Qwen3.5-0.8B-Base" for tier in DFLASH_REQUIRED_TIERS
}

DEFAULT_TARGET_MODEL: Final[dict[str, str]] = {
    tier: f"elizaos/eliza-1/bundles/{tier}" for tier in ACTIVE_TIERS
}

ACCEPTANCE_GATE: Final[dict[str, float]] = {
    "2b": 0.48,
    "4b": 0.52,
    "9b": 0.52,
    "27b": 0.52,
    "27b-256k": 0.52,
}


def dflash_release_status(tier: str) -> Literal["disabled", "required"]:
    if tier not in ACTIVE_TIERS:
        raise ValueError(f"unknown Eliza-1 DFlash tier: {tier}")
    if tier in DFLASH_DISABLED_TIERS:
        return "disabled"
    return "required"


def is_dflash_disabled(tier: str) -> bool:
    return dflash_release_status(tier) == "disabled"


def is_dflash_required(tier: str) -> bool:
    return dflash_release_status(tier) == "required"


def disabled_policy_manifest(
    *,
    tier: str,
    synthetic: bool,
    generated_at: str,
    training_commit: str | None,
) -> dict[str, Any]:
    if not is_dflash_disabled(tier):
        raise ValueError(f"tier {tier} is not DFlash-disabled")
    return {
        "schemaVersion": 1,
        "kind": "dflash-release-policy",
        "tier": tier,
        "generatedAt": generated_at,
        "synthetic": synthetic,
        "status": "disabled",
        "releaseMode": "fail-open-no-drafter",
        "requiresDrafter": False,
        "releaseEligibleWithoutDrafter": True,
        "drafter": None,
        "expectedBundleFiles": {
            "required": ("dflash/target-meta.json",),
            "forbidden": (f"dflash/drafter-{tier}.gguf",),
        },
        "artifactManifestPath": f"dflash/dflash-disabled-{tier}.release-policy.json",
        "targetMetaPolicy": {
            "path": "dflash/target-meta.json",
            "status": "disabled",
            "matchesTargetCheckpoint": None,
        },
        "reason": DFLASH_DISABLED_REASON[tier],
        "trainingCommit": training_commit,
        "notes": (
            "Do not create a fake drafter for this tier. Runtime must fall "
            "back to normal target decoding, and release validation should "
            "treat a drafter GGUF for this tier as a policy violation."
        ),
    }


def required_artifact_manifest_path(tier: str) -> str:
    if not is_dflash_required(tier):
        raise ValueError(f"tier {tier} does not require a DFlash drafter")
    return f"dflash/drafter-{tier}.distill.json"
