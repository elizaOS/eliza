"""Eliza-1 GGUF platform release checklist generator.

This module produces the machine-readable platform plan and the human
readiness ledger used before an Eliza-1 bundle can become a release
candidate. It does not create weights or evidence; it only records the
paths that a final bundle must already contain.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Final, Mapping, Sequence

try:
    from scripts.manifest.eliza1_manifest import (
        ELIZA_1_PUBLISHABLE_RELEASE_STATES,
        ELIZA_1_TIERS,
        SUPPORTED_BACKENDS_BY_TIER,
        VOICE_PRESET_CACHE_PATH,
        VOICE_QUANT_BY_TIER,
        required_voice_artifacts_for_tier,
    )
except ImportError:  # pragma: no cover - script execution path
    from eliza1_manifest import (
        ELIZA_1_PUBLISHABLE_RELEASE_STATES,
        ELIZA_1_TIERS,
        SUPPORTED_BACKENDS_BY_TIER,
        VOICE_PRESET_CACHE_PATH,
        VOICE_QUANT_BY_TIER,
        required_voice_artifacts_for_tier,
    )

TEXT_QUANT_BY_TIER: Final[Mapping[str, str]] = {
    "0_8b": "Q3_K_M",
    "2b": "Q4_K_M",
    "4b": "Q4_K_M",
    "9b": "Q4_K_M",
    "27b": "Q4_K_M",
    "27b-256k": "Q4_K_M",
    "27b-1m": "Q4_K_M",
}

CONTEXTS_BY_TIER: Final[Mapping[str, tuple[str, ...]]] = {
    "0_8b": ("32k",),
    "2b": ("32k", "64k"),
    "4b": ("64k", "128k"),
    "9b": ("64k", "128k"),
    "27b": ("128k", "256k"),
    "27b-256k": ("256k",),
    "27b-1m": ("1m",),
}

ASR_ARTIFACTS_BY_TIER: Final[Mapping[str, tuple[str, ...]]] = {
    tier: ("asr/eliza-1-asr.gguf", "asr/eliza-1-asr-mmproj.gguf")
    for tier in ELIZA_1_TIERS
}

VAD_ARTIFACTS: Final[tuple[str, ...]] = ("vad/silero-vad-v5.1.2.ggml.bin",)
VAD_OPTIONAL_FALLBACK_ARTIFACTS: Final[tuple[str, ...]] = (
    "vad/silero-vad-int8.onnx",
)

COMPONENT_LICENSES_BY_TIER: Final[Mapping[str, tuple[str, ...]]] = {
    tier: (
        "licenses/LICENSE.text",
        "licenses/LICENSE.voice",
        "licenses/LICENSE.asr",
        "licenses/LICENSE.vad",
        "licenses/LICENSE.dflash",
        "licenses/LICENSE.eliza-1",
        "licenses/LICENSE.vision",
    )
    for tier in ELIZA_1_TIERS
}

REQUIRED_PLATFORM_EVIDENCE_BY_TIER: Final[Mapping[str, tuple[str, ...]]] = {
    "0_8b": (
        "darwin-arm64-metal",
        "ios-arm64-metal",
        "linux-x64-vulkan",
        "android-adreno-vulkan",
        "android-mali-vulkan",
        "linux-x64-cpu",
        "windows-x64-cpu",
        "windows-x64-vulkan",
        "windows-arm64-cpu",
        "windows-arm64-vulkan",
    ),
    "2b": (
        "darwin-arm64-metal",
        "ios-arm64-metal",
        "linux-x64-vulkan",
        "android-adreno-vulkan",
        "android-mali-vulkan",
        "linux-x64-cpu",
        "windows-x64-cpu",
        "windows-x64-vulkan",
        "windows-arm64-cpu",
        "windows-arm64-vulkan",
    ),
    "4b": (
        "darwin-arm64-metal",
        "ios-arm64-metal",
        "linux-x64-vulkan",
        "android-adreno-vulkan",
        "android-mali-vulkan",
        "linux-x64-cuda",
        "linux-x64-rocm",
        "windows-x64-cuda",
        "windows-x64-vulkan",
        "linux-x64-cpu",
        "windows-x64-cpu",
    ),
    "9b": (
        "darwin-arm64-metal",
        "ios-arm64-metal",
        "linux-x64-vulkan",
        "android-adreno-vulkan",
        "android-mali-vulkan",
        "linux-x64-cuda",
        "linux-x64-rocm",
        "windows-x64-cuda",
        "windows-x64-vulkan",
        "linux-x64-cpu",
        "windows-x64-cpu",
    ),
    "27b": (
        "darwin-arm64-metal",
        "linux-x64-vulkan",
        "linux-x64-cuda",
        "linux-x64-rocm",
        "windows-x64-cuda",
        "windows-x64-vulkan",
        "linux-x64-cpu",
    ),
    "27b-256k": (
        "darwin-arm64-metal",
        "linux-aarch64-cuda",
        "linux-x64-cuda",
        "linux-x64-rocm",
        "linux-x64-vulkan",
        "linux-x64-cpu",
    ),
    # 1M context is GH200-class only — Grace-Hopper aarch64+CUDA is the
    # only platform with the memory to hold the KV cache at that window.
    "27b-1m": ("linux-aarch64-cuda",),
}


@dataclass(frozen=True, slots=True)
class PlatformTarget:
    id: str
    backend: str
    evidence_path: str


@dataclass(frozen=True, slots=True)
class TierGgufPlan:
    tier: str
    text_quant: str
    voice_quant: str
    contexts: tuple[str, ...]
    required_files: tuple[str, ...]
    optional_files: tuple[str, ...]
    required_platform_evidence: tuple[PlatformTarget, ...]


def text_artifact_name(tier: str, ctx: str) -> str:
    # The dedicated long-context tiers (27b-256k, 27b-1m) carry the context
    # in the tier id itself, so the file is `eliza-1-<tier>.gguf` rather than
    # `eliza-1-<tier>-<ctx>.gguf` (which would double up the context token).
    if tier == "27b-256k" and ctx == "256k":
        return "text/eliza-1-27b-256k.gguf"
    if tier == "27b-1m" and ctx == "1m":
        return "text/eliza-1-27b-1m.gguf"
    return f"text/eliza-1-{tier}-{ctx}.gguf"


def required_files_for_tier(tier: str) -> tuple[str, ...]:
    text_files = tuple(text_artifact_name(tier, ctx) for ctx in CONTEXTS_BY_TIER[tier])
    voice_files = tuple(f"tts/{name}" for name in required_voice_artifacts_for_tier(tier))
    backend_reports = tuple(
        "evals/cpu_reference.json" if backend == "cpu" else f"evals/{backend}_verify.json"
        for backend in SUPPORTED_BACKENDS_BY_TIER[tier]
    )
    dispatch_reports = tuple(
        f"evals/{backend}_dispatch.json" for backend in SUPPORTED_BACKENDS_BY_TIER[tier]
    )
    dflash_files = (f"dflash/drafter-{tier}.gguf", "dflash/target-meta.json")
    vision_files = (f"vision/mmproj-{tier}.gguf",)
    return (
        *text_files,
        *voice_files,
        *ASR_ARTIFACTS_BY_TIER[tier],
        *VAD_ARTIFACTS,
        *vision_files,
        *dflash_files,
        VOICE_PRESET_CACHE_PATH,
        "evals/aggregate.json",
        *backend_reports,
        *dispatch_reports,
        *COMPONENT_LICENSES_BY_TIER[tier],
        "checksums/SHA256SUMS",
        "evidence/release.json",
        "quantization/turboquant.json",
        "quantization/fused_turboquant.json",
        "quantization/qjl_config.json",
        "quantization/polarquant_config.json",
    )


def _target_backend(target: str) -> str:
    for backend in ("metal", "vulkan", "cuda", "rocm"):
        if target.endswith(f"-{backend}"):
            return backend
    return "cpu"


def build_plan() -> dict[str, TierGgufPlan]:
    out: dict[str, TierGgufPlan] = {}
    for tier in ELIZA_1_TIERS:
        targets = tuple(
            PlatformTarget(
                id=target,
                backend=_target_backend(target),
                evidence_path=f"evidence/platform/{target}.json",
            )
            for target in REQUIRED_PLATFORM_EVIDENCE_BY_TIER[tier]
        )
        out[tier] = TierGgufPlan(
            tier=tier,
            text_quant=TEXT_QUANT_BY_TIER[tier],
            voice_quant=VOICE_QUANT_BY_TIER[tier],
            contexts=CONTEXTS_BY_TIER[tier],
            required_files=required_files_for_tier(tier),
            optional_files=VAD_OPTIONAL_FALLBACK_ARTIFACTS,
            required_platform_evidence=targets,
        )
    return out


def missing_files(
    bundle_root: Path, plan: Mapping[str, TierGgufPlan]
) -> dict[str, list[str]]:
    missing: dict[str, list[str]] = {}
    for tier, tier_plan in plan.items():
        plain_root = bundle_root / f"eliza-1-{tier}"
        bundle_root_candidate = bundle_root / f"eliza-1-{tier}.bundle"
        root = bundle_root_candidate if bundle_root_candidate.exists() else plain_root
        tier_missing = [
            rel for rel in tier_plan.required_files if not (root / rel).is_file()
        ]
        tier_missing.extend(
            target.evidence_path
            for target in tier_plan.required_platform_evidence
            if not (root / target.evidence_path).is_file()
        )
        missing[tier] = sorted(set(tier_missing))
    return missing


# Release-state interpretation: `base-v1` (the upstream base models,
# GGUF-converted via the elizaOS/llama.cpp fork and fully Eliza-optimized,
# NOT fine-tuned) is a legit release shape. It does not pretend `final.weights`
# is a *trained Eliza-1 checkpoint* — instead it records each component's
# upstream `sourceModel`. So for `base-v1`, `final.weights` is not required to
# be `true`; everything else (hashes, evals, kernel dispatch reports, platform
# evidence, licenses, size-first repo ids) still is. `upload-candidate` /
# `final` keep the original strict rule (all `final.*` true).
_RELEASE_FINAL_FLAGS_ALL: Final[tuple[str, ...]] = (
    "weights",
    "hashes",
    "evals",
    "licenses",
    "kernelDispatchReports",
    "platformEvidence",
    "sizeFirstRepoIds",
)
_RELEASE_FINAL_FLAGS_BASE_V1: Final[tuple[str, ...]] = tuple(
    f for f in _RELEASE_FINAL_FLAGS_ALL if f != "weights"
)
_WEIGHT_PAYLOAD_DIRS: Final[frozenset[str]] = frozenset(
    {"text", "tts", "asr", "vad", "vision", "dflash", "embedding", "wakeword"}
)


def release_status_blockers(
    bundle_root: Path, plan: Mapping[str, TierGgufPlan]
) -> dict[str, list[str]]:
    blockers: dict[str, list[str]] = {}
    for tier, tier_plan in plan.items():
        plain_root = bundle_root / f"eliza-1-{tier}"
        bundle_root_candidate = bundle_root / f"eliza-1-{tier}.bundle"
        root = bundle_root_candidate if bundle_root_candidate.exists() else plain_root
        evidence_path = root / "evidence" / "release.json"
        tier_blockers: list[str] = []
        if not bundle_root_candidate.exists() and not plain_root.exists():
            tier_blockers.append(
                "`bundle`: missing canonical local bundle "
                f"`{bundle_root_candidate.name}` or `{plain_root.name}`; "
                "final payloads, checksums, license evidence, and HF upload "
                "evidence cannot be verified"
            )
        if not evidence_path.is_file():
            tier_blockers.append(
                "`evidence/release.json`: missing; release state, final flags, "
                "source models, and HF upload evidence are not proven"
            )
        else:
            try:
                evidence = json.loads(evidence_path.read_text())
            except json.JSONDecodeError as exc:
                tier_blockers.append(f"`evidence/release.json`: invalid JSON: {exc}")
            else:
                release_state = evidence.get("releaseState")
                publish_eligible = evidence.get("publishEligible")
                if release_state not in ELIZA_1_PUBLISHABLE_RELEASE_STATES:
                    tier_blockers.append(
                        "`evidence/release.json`: releaseState is "
                        f"`{release_state}`, not one of "
                        f"{list(ELIZA_1_PUBLISHABLE_RELEASE_STATES)}"
                    )
                if publish_eligible is not True:
                    tier_blockers.append(
                        "`evidence/release.json`: publishEligible is not true"
                    )
                if evidence.get("checksumManifest") != "checksums/SHA256SUMS":
                    tier_blockers.append(
                        "`evidence/release.json`: checksumManifest is not "
                        "`checksums/SHA256SUMS`"
                    )
                weights = evidence.get("weights")
                if not isinstance(weights, list) or not all(
                    isinstance(p, str) for p in weights
                ):
                    tier_blockers.append(
                        "`evidence/release.json`: weights must list final "
                        "bundle-relative payload paths"
                    )
                else:
                    weights_set = set(weights)
                    required_weight_paths = {
                        rel
                        for rel in tier_plan.required_files
                        if rel.split("/", 1)[0] in _WEIGHT_PAYLOAD_DIRS
                    }
                    missing_weight_paths = sorted(required_weight_paths - weights_set)
                    if missing_weight_paths:
                        tier_blockers.append(
                            "`evidence/release.json`: weights missing final "
                            f"payload path(s): {missing_weight_paths}"
                        )
                if release_state == "base-v1":
                    finetuned = evidence.get("finetuned")
                    if finetuned is not False:
                        tier_blockers.append(
                            "`evidence/release.json`: releaseState is `base-v1` "
                            "but `finetuned` is not false"
                        )
                    if not isinstance(
                        evidence.get("sourceModels"), dict
                    ) or not evidence.get("sourceModels"):
                        tier_blockers.append(
                            "`evidence/release.json`: base-v1 release missing `sourceModels`"
                        )
                required_final_flags = (
                    _RELEASE_FINAL_FLAGS_BASE_V1
                    if release_state == "base-v1"
                    else _RELEASE_FINAL_FLAGS_ALL
                )
                final = evidence.get("final")
                if isinstance(final, dict):
                    for key in required_final_flags:
                        if final.get(key) is not True:
                            tier_blockers.append(
                                f"`evidence/release.json`: final.{key} is not true"
                            )
                else:
                    tier_blockers.append("`evidence/release.json`: final object missing")
                hf = evidence.get("hf")
                upload = hf.get("uploadEvidence") if isinstance(hf, dict) else None
                if not isinstance(hf, dict):
                    tier_blockers.append("`evidence/release.json`: hf object missing")
                else:
                    if hf.get("repoId") != "elizaos/eliza-1":
                        tier_blockers.append(
                            "`evidence/release.json`: hf.repoId is not "
                            "`elizaos/eliza-1`"
                        )
                    if hf.get("status") != "uploaded":
                        tier_blockers.append(
                            "`evidence/release.json`: hf.status is not `uploaded`; "
                            "final Hugging Face payload upload is not proven"
                        )
                if not isinstance(upload, dict):
                    tier_blockers.append(
                        "`evidence/release.json`: hf.uploadEvidence missing; "
                        "final Hugging Face commit/url/uploaded paths are not proven"
                    )
                else:
                    if upload.get("repoId") != "elizaos/eliza-1":
                        tier_blockers.append(
                            "`evidence/release.json`: hf.uploadEvidence.repoId is not "
                            "`elizaos/eliza-1`"
                        )
                    for key in ("commit", "url"):
                        if not isinstance(upload.get(key), str) or not upload.get(key):
                            tier_blockers.append(
                                f"`evidence/release.json`: hf.uploadEvidence.{key} missing"
                            )
                    uploaded_paths = upload.get("uploadedPaths")
                    if not isinstance(uploaded_paths, list) or not all(
                        isinstance(p, str) for p in uploaded_paths
                    ):
                        tier_blockers.append(
                            "`evidence/release.json`: hf.uploadEvidence.uploadedPaths "
                            "must list uploaded bundle paths"
                        )
        blockers[tier] = sorted(set(tier_blockers))
    return blockers


def plan_to_json(plan: Mapping[str, TierGgufPlan]) -> dict[str, object]:
    return {tier: asdict(tier_plan) for tier, tier_plan in plan.items()}


def render_readiness(
    plan: Mapping[str, TierGgufPlan],
    missing: Mapping[str, Sequence[str]] | None,
    blockers: Mapping[str, Sequence[str]] | None = None,
) -> str:
    lines = [
        "# Eliza-1 GGUF Platform Readiness",
        "",
        "This file is generated by `packages/training/scripts/manifest/eliza1_platform_plan.py`.",
        "It is a release checklist, not hardware evidence.",
        "",
        "Important caveats:",
        "",
        "- Text, TTS, ASR, and DFlash payloads are GGUF artifacts in the final plan.",
        "- VAD is a native GGML artifact at "
        "`vad/silero-vad-v5.1.2.ggml.bin`. It is not GGUF. "
        "Legacy bundles may additionally carry the ONNX fallback "
        "`vad/silero-vad-int8.onnx`, but the fallback is not the release "
        "readiness path.",
        "- Canonical small text tiers are Qwen3.5 0.8B (`0_8b`) and "
        "Qwen3.5 2B (`2b`). ASR and embedding are real Qwen3 upstream "
        "exceptions: Qwen3-ASR and Qwen3-Embedding artifacts must stay "
        "Qwen3, not be renamed to Qwen3.5.",
        "- v1 release shape (`releaseState=base-v1`): the upstream BASE models "
        "— GGUF-converted via the elizaOS/llama.cpp fork and fully "
        "Eliza-optimized (every quant/kernel trick in `packages/inference/AGENTS.md` "
        "§3) — but NOT fine-tuned. `evidence/release.json` records `finetuned=false` "
        "and a `sourceModels` map (which upstream HF repo each component comes "
        "from). For `base-v1`, `final.weights` need not be `true` (the bytes are "
        "the upstream base GGUFs by design) — but `final.{hashes,evals,licenses,"
        "kernelDispatchReports,platformEvidence,sizeFirstRepoIds}` must all be "
        "`true`, and the runnable-on-base evals (text perplexity vs the upstream "
        "GGUF, voice RTF, ASR WER, VAD latency/boundary/endpoint/false-barge-in, "
        "dflash acceptance, e2e loop, 30-turn) must pass — but NOT a "
        "fine-tuned-text-quality eval. Fine-tuning "
        "ships in v2 (`releaseState=finetuned-v2`).",
        "- Release evidence must use real final hashes, evals, "
        "licenses, platform reports, and Hugging Face upload records — and "
        "real GGUF/quant-sidecar bytes from a real fork build. Fabricated "
        "hashes / not-yet-built tiers are blockers.",
        "- No-larp release readiness requires canonical local bundle names, "
        "real `checksums/SHA256SUMS`, real license evidence, and "
        "`hf.status=uploaded` with `hf.uploadEvidence` commit/url/uploaded paths. "
        "`pending-upload` or blocked local evidence is not release-ready.",
        "",
    ]

    for tier, tier_plan in plan.items():
        lines.extend(
            [
                f"## {tier}",
                "",
                f"- Text quant: `{tier_plan.text_quant}`",
                f"- Voice quant: `{tier_plan.voice_quant}`",
                "- Contexts: "
                + ", ".join(f"`{ctx}`" for ctx in tier_plan.contexts),
                "- Required platform evidence: "
                + ", ".join(
                    f"`{target.id}`" for target in tier_plan.required_platform_evidence
                ),
                "",
                "Required files:",
            ]
        )
        lines.extend(f"- `{rel}`" for rel in tier_plan.required_files)
        lines.append("")
        if tier_plan.optional_files:
            lines.append("Optional fallback files:")
            lines.extend(f"- `{rel}`" for rel in tier_plan.optional_files)
            lines.append("")

        tier_missing = list(missing.get(tier, ())) if missing else []
        if tier_missing:
            lines.append("Missing files/evidence:")
            lines.extend(f"- `{rel}`" for rel in tier_missing)
            lines.append("")
        else:
            lines.append("Missing files/evidence: none recorded by this check.")
            lines.append("")

        tier_blockers = list(blockers.get(tier, ())) if blockers else []
        if tier_blockers:
            lines.append("Publish-blocking status:")
            lines.extend(f"- {item}" for item in tier_blockers)
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle-root", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--readiness-md", type=Path)
    args = parser.parse_args(argv)

    plan = build_plan()
    missing = missing_files(args.bundle_root, plan) if args.bundle_root else None
    blockers = release_status_blockers(args.bundle_root, plan) if args.bundle_root else None

    if args.out:
        args.out.write_text(
            json.dumps(plan_to_json(plan), indent=2, sort_keys=True) + "\n"
        )
    else:
        print(json.dumps(plan_to_json(plan), indent=2, sort_keys=True))

    if args.readiness_md:
        args.readiness_md.write_text(render_readiness(plan, missing, blockers))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
