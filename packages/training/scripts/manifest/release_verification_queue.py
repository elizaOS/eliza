#!/usr/bin/env python3
"""Build a one-bundle-at-a-time verification queue from the HF release audit.

The queue is deliberately conservative: it does not download weights or run
LLMs. It converts the live metadata audit into ordered operator work items so
the remaining release work can be executed one tier/backend at a time on the
right hardware, with no fabricated pass reports.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

try:
    from scripts.manifest.audit_hf_eliza1_release import audit_hf_release
    from scripts.manifest.eliza1_manifest import ELIZA_1_TIERS
    from scripts.manifest.eliza1_platform_plan import text_artifact_name
except ImportError:  # pragma: no cover - script execution path
    from audit_hf_eliza1_release import audit_hf_release  # type: ignore
    from eliza1_manifest import ELIZA_1_TIERS  # type: ignore
    from eliza1_platform_plan import text_artifact_name  # type: ignore

TIER_ORDER: tuple[str, ...] = ELIZA_1_TIERS
BACKEND_ORDER: tuple[str, ...] = ("cpu", "metal", "vulkan", "cuda", "rocm")
IMAGEGEN_ACCELERATOR_ORDER: tuple[str, ...] = ("cpu", "metal", "vulkan", "cuda")
_TIER_CHECK_RE = re.compile(r"^(?P<tier>\S+) (?P<kind>.+)$")


@dataclass(frozen=True, slots=True)
class QueueItem:
    id: str
    tier: str
    category: str
    priority: int
    requires_hardware: bool
    command: str
    evidence: tuple[str, ...]
    source: str
    detail: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "tier": self.tier,
            "category": self.category,
            "priority": self.priority,
            "requiresHardware": self.requires_hardware,
            "command": self.command,
            "evidence": list(self.evidence),
            "source": self.source,
            "detail": self.detail,
        }


def _tier_sort_key(tier: str) -> int:
    try:
        return TIER_ORDER.index(tier)
    except ValueError:
        return len(TIER_ORDER)


def _parse_tier(name: str) -> str | None:
    match = _TIER_CHECK_RE.match(name)
    if not match:
        return None
    tier = match.group("tier")
    return tier if tier in TIER_ORDER else None


def _failed_checks(summary: Mapping[str, Any], category: str) -> list[Mapping[str, str]]:
    failures = summary.get("failuresByCategory")
    if not isinstance(failures, Mapping):
        return []
    value = failures.get(category)
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, Mapping)]


def _backend_names(detail: str) -> list[str]:
    out: list[str] = []
    for backend in BACKEND_ORDER:
        if re.search(rf"\b{backend}:\s*", detail):
            out.append(backend)
    return out


def _imagegen_accelerators(detail: str) -> list[str]:
    out: list[str] = []
    for accelerator in IMAGEGEN_ACCELERATOR_ORDER:
        if re.search(rf"\b{accelerator}\b", detail):
            out.append(accelerator)
    return out


def _bundle_dir(bundle_root: str, tier: str) -> str:
    return str(Path(bundle_root) / f"eliza-1-{tier}.bundle")


def _default_eval_python() -> str:
    override = os.environ.get("ELIZA_EVAL_PYTHON")
    if override:
        return override
    conda = Path("/opt/miniconda3/bin/python3")
    if conda.is_file():
        return str(conda)
    return "python3"


def _eval_suite_command(eval_python: str, bundle: str, tier: str, *extra: str) -> str:
    args = [
        "ELIZA_EVAL_ALLOW_CONCURRENT_LLM=0",
        eval_python,
        "-m",
        "scripts.eval.eliza1_eval_suite",
        "--bundle-dir",
        bundle,
        "--tier",
        tier,
        *extra,
    ]
    return " ".join(args)


def _process_guard_command(eval_python: str) -> str:
    return f"{eval_python} packages/training/scripts/manifest/release_process_guard.py"


def _guarded(eval_python: str, command: str) -> str:
    return f"{_process_guard_command(eval_python)} && {command}"


def _backend_command(bundle_root: str, verify_dir: str, tier: str, backend: str, eval_python: str) -> str:
    bundle = _bundle_dir(bundle_root, tier)
    if backend == "cpu":
        return _guarded(
            eval_python,
            f"make -C {verify_dir} reference-test && "
            f"{_eval_suite_command(eval_python, bundle, tier, '--backend', 'cpu', '--threads', '8')}",
        )
    if backend == "metal":
        return _guarded(
            eval_python,
            "node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target darwin-arm64-metal && "
            f"make -C {verify_dir} metal-verify dispatch-smoke && "
            f"{_eval_suite_command(eval_python, bundle, tier, '--backend', 'metal')}",
        )
    if backend == "vulkan":
        return _guarded(
            eval_python,
            "node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-vulkan && "
            f"make -C {verify_dir} vulkan_verify vulkan-dispatch-smoke && "
            f"{_eval_suite_command(eval_python, bundle, tier, '--backend', 'vulkan')}",
        )
    if backend == "cuda":
        return _guarded(
            eval_python,
            "node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-cuda && "
            f"{verify_dir}/cuda_runner.sh && "
            f"{_eval_suite_command(eval_python, bundle, tier, '--backend', 'cuda')}",
        )
    if backend == "rocm":
        return _guarded(
            eval_python,
            "node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-rocm && "
            f"make -C {verify_dir} rocm_verify rocm-dispatch-smoke && "
            f"{_eval_suite_command(eval_python, bundle, tier, '--backend', 'rocm')}",
        )
    raise ValueError(f"unsupported backend {backend!r}")


def _imagegen_command(accelerator: str, eval_python: str) -> str:
    return _guarded(
        eval_python,
        f"ELIZA_IMAGEGEN_ACCELERATOR={accelerator} "
        "node plugins/plugin-local-inference/scripts/probe-sd-cpp.mjs --json "
        f"| python3 -c \"import json,sys; p=json.load(sys.stdin); "
        f"assert p.get('available') is True, p; "
        f"assert p.get('requiredAccelerator') == '{accelerator}', p; "
        f"assert '{accelerator}' in p.get('accelerators', []), p\" && "
        "bun test plugins/plugin-local-inference/__tests__/imagegen-routing.test.ts "
        "plugins/plugin-local-inference/__tests__/imagegen-publishing.test.ts "
        "plugins/plugin-local-inference/__tests__/imagegen-sd-cpp-probe.test.ts && "
        f"publish evidence/imagegen/{accelerator}.json and refresh "
        "evidence/imagegen/sd-cpp-runtime.json only after real image smoke reports pass",
    )


def _mtp_command(bundle_root: str, tier: str, eval_python: str) -> str:
    bundle = _bundle_dir(bundle_root, tier)
    validation_tier = "27b" if tier == "27b-256k" else tier
    target_gguf = Path(bundle) / text_artifact_name(tier, "256k")
    return _guarded(
        eval_python,
        f"{eval_python} packages/training/scripts/dflash/validate_drafter.py "
        f"--tier {validation_tier} "
        f"--target-gguf {target_gguf} "
        f"--drafter-gguf {bundle}/dflash/drafter-{tier}.gguf "
        "--skip-acceptance-rollout "
        f"--report-out {bundle}/dflash/validation-real.json && "
        "node plugins/plugin-local-inference/native/verify/dflash_drafter_runtime_smoke.mjs "
        f"--tier {tier} "
        f"--target-model {target_gguf} "
        f"--drafter-model {bundle}/dflash/drafter-{tier}.gguf "
        "--spec-type dflash "
        "--bench --bench-tokens 128 --bench-context 128 "
        f"--report {bundle}/dflash/runtime-smoke-native.json "
        f"--bench-report {bundle}/evals/dflash-native-bench.json && "
        f"{_eval_suite_command(eval_python, bundle, tier, '--threads', '8', '--timeout', '600')} && "
        f"{eval_python} packages/training/scripts/manifest/dflash_tuning_report.py "
        f"{bundle} --out {bundle}/evals/dflash-tuning-report.json && "
        f"publish bundles/{tier}/dflash/target-meta.json, "
        f"bundles/{tier}/dflash/validation-real.json, "
        f"bundles/{tier}/dflash/runtime-smoke-native.json, and "
        f"bundles/{tier}/evals/dflash-accept.json only after native runtime acceptanceRate and speedup meet the release gates",
    )


def _finetune_command(eval_python: str) -> str:
    return _guarded(
        eval_python,
        "hf download elizaos/eliza-1-training --type dataset --include 'sft/0_8b/*' "
        "--local-dir /tmp/eliza-1-training && "
        "cd packages/training && "
        "uv run --extra train python scripts/run_pipeline.py "
        "--registry-key qwen3.5-0.8b "
        "--train-file /tmp/eliza-1-training/sft/0_8b/train.jsonl "
        "--val-file /tmp/eliza-1-training/sft/0_8b/val.jsonl "
        "--test-file /tmp/eliza-1-training/sft/0_8b/test.jsonl "
        "--epochs 1 --run-name eliza-1-0_8b-finetuned-v2 && "
        "uv run --extra train python scripts/benchmark/native_tool_call_bench.py "
        "--model checkpoints/eliza-1-0_8b-finetuned-v2/final "
        "--test-file /tmp/eliza-1-training/sft/0_8b/test.jsonl "
        "--out-dir /tmp/eliza-1-finetune-native-tool-call && "
        "publish bundles/0_8b/finetuned-v2/eliza-1-0_8b-sft.gguf plus "
        "evidence/training/fine-tune-comparison.json only after baseline-vs-finetuned "
        "eliza_bench, native_tool_call, and structured_response reports pass",
    )


def _release_evidence_command(bundle_root: str, tier: str, eval_python: str) -> str:
    bundle = _bundle_dir(bundle_root, tier)
    bundles_root = str(Path(bundle).parent)
    return (
        f"{eval_python} packages/training/scripts/manifest/finalize_eliza1_evidence.py {bundle} && "
        f"{eval_python} packages/training/scripts/publish/publish_eliza1_model_repo.py "
        f"--bundles-root {bundles_root} --tier {tier} --dry-run && "
        f"publish bundles/{tier}/evidence/release.json and bundles/{tier}/checksums/SHA256SUMS "
        "only after final flags are true or the releaseState/base-v1 exception is explicitly satisfied"
    )


def build_queue(
    summary: Mapping[str, Any],
    *,
    bundle_root: str,
    verify_dir: str = "plugins/plugin-local-inference/native/verify",
    eval_python: str | None = None,
) -> list[QueueItem]:
    items: list[QueueItem] = []
    eval_python = eval_python or _default_eval_python()

    for check in _failed_checks(summary, "missingReleaseFiles"):
        name = str(check.get("name", ""))
        detail = str(check.get("detail", ""))
        tier = _parse_tier(name)
        if not tier:
            continue
        missing = tuple(part.strip() for part in detail.split(",") if part.strip())
        items.append(
            QueueItem(
                id=f"{tier}:missing-release-files",
                tier=tier,
                category="missingReleaseFiles",
                priority=10 + _tier_sort_key(tier),
                requires_hardware=any(
                    path.startswith("evals/") and path.endswith("_verify.json")
                    for path in missing
                ),
                command=(
                    f"produce the missing evidence for {tier}, then publish those paths "
                    "with huggingface_hub.HfApi.create_commit"
                ),
                evidence=tuple(f"bundles/{tier}/{path}" for path in missing),
                source=name,
                detail=detail,
            )
        )

    for check in _failed_checks(summary, "other"):
        name = str(check.get("name", ""))
        detail = str(check.get("detail", ""))
        tier = _parse_tier(name)
        if not tier or "manifest files cover required runtime artifacts" not in name:
            continue
        missing = tuple(part.strip() for part in detail.split(",") if part.strip())
        items.append(
            QueueItem(
                id=f"{tier}:manifest-runtime-surface",
                tier=tier,
                category="manifestIntegrity",
                priority=20 + _tier_sort_key(tier),
                requires_hardware=False,
                command=(
                    f"refresh bundles/{tier}/eliza-1.manifest.json so files.* includes "
                    "the listed runtime artifacts with final sha256 values"
                ),
                evidence=(
                    f"bundles/{tier}/eliza-1.manifest.json",
                    *(f"bundles/{tier}/{path}" for path in missing),
                ),
                source=name,
                detail=detail,
            )
        )

    for check in _failed_checks(summary, "checksumIntegrity"):
        name = str(check.get("name", ""))
        detail = str(check.get("detail", ""))
        tier = _parse_tier(name)
        if not tier:
            continue
        missing = tuple(part.strip() for part in detail.split(",") if part.strip())
        items.append(
            QueueItem(
                id=f"{tier}:checksum-surface",
                tier=tier,
                category="checksumIntegrity",
                priority=30 + _tier_sort_key(tier),
                requires_hardware=False,
                command=(
                    f"refresh bundles/{tier}/checksums/SHA256SUMS after the listed "
                    "runtime artifacts exist and match the manifest"
                ),
                evidence=(
                    f"bundles/{tier}/checksums/SHA256SUMS",
                    *(f"bundles/{tier}/{path}" for path in missing),
                ),
                source=name,
                detail=detail,
            )
        )

    for check in _failed_checks(summary, "backendVerification"):
        name = str(check.get("name", ""))
        detail = str(check.get("detail", ""))
        tier = _parse_tier(name)
        if not tier:
            continue
        for backend in _backend_names(detail):
            items.append(
                QueueItem(
                    id=f"{tier}:backend:{backend}",
                    tier=tier,
                    category="backendVerification",
                    priority=100 + _tier_sort_key(tier) * 10 + BACKEND_ORDER.index(backend),
                    requires_hardware=backend in {"metal", "vulkan", "cuda", "rocm"},
                    command=_backend_command(bundle_root, verify_dir, tier, backend, eval_python),
                    evidence=(
                        f"bundles/{tier}/evals/{backend}_dispatch.json",
                        (
                            f"bundles/{tier}/evals/{backend}_verify.json"
                            if backend != "cpu"
                            else f"bundles/{tier}/evals/cpu_reference.json"
                        ),
                    ),
                    source=name,
                    detail=detail,
                )
            )

    for check in _failed_checks(summary, "manifestEvalGates"):
        name = str(check.get("name", ""))
        detail = str(check.get("detail", ""))
        tier = _parse_tier(name)
        if not tier:
            continue
        bundle = _bundle_dir(bundle_root, tier)
        items.append(
            QueueItem(
                id=f"{tier}:eval-suite",
                tier=tier,
                category="manifestEvalGates",
                priority=200 + _tier_sort_key(tier),
                requires_hardware=False,
                command=(
                    _guarded(
                        eval_python,
                        _eval_suite_command(
                            eval_python,
                            bundle,
                            tier,
                            "--threads",
                            "8",
                            "--timeout",
                            "600",
                        ),
                    )
                ),
                evidence=(
                    f"bundles/{tier}/evals/aggregate.json",
                    f"bundles/{tier}/eliza-1.manifest.json",
                ),
                source=name,
                detail=detail,
            )
        )

    for check in _failed_checks(summary, "imagegenEvidence"):
        name = str(check.get("name", ""))
        detail = str(check.get("detail", ""))
        for accelerator in _imagegen_accelerators(detail):
            if accelerator == "cpu":
                priority = 300
                requires_hardware = False
            else:
                priority = 300 + IMAGEGEN_ACCELERATOR_ORDER.index(accelerator)
                requires_hardware = accelerator in {"metal", "vulkan", "cuda"}
            items.append(
                QueueItem(
                    id=f"imagegen:{accelerator}",
                    tier="imagegen",
                    category="imagegenEvidence",
                    priority=priority,
                    requires_hardware=requires_hardware,
                    command=_imagegen_command(accelerator, eval_python),
                    evidence=(
                        "evidence/imagegen/sd-cpp-runtime.json",
                        f"evidence/imagegen/{accelerator}.json",
                    ),
                    source=name,
                    detail=detail,
                )
            )

    for check in _failed_checks(summary, "mtpDrafter"):
        name = str(check.get("name", ""))
        detail = str(check.get("detail", ""))
        tier = _parse_tier(name)
        if not tier:
            continue
        items.append(
            QueueItem(
                id=f"{tier}:mtp-drafter",
                tier=tier,
                category="mtpDrafter",
                priority=400 + _tier_sort_key(tier),
                requires_hardware=True,
                command=_mtp_command(bundle_root, tier, eval_python),
                evidence=(
                    f"bundles/{tier}/dflash/target-meta.json",
                    f"bundles/{tier}/dflash/validation-real.json",
                    f"bundles/{tier}/dflash/runtime-smoke-native.json",
                    f"bundles/{tier}/evals/dflash-accept.json",
                    f"bundles/{tier}/evals/dflash-tuning-report.json",
                ),
                source=name,
                detail=detail,
            )
        )

    for check in _failed_checks(summary, "fineTuneComparison"):
        name = str(check.get("name", ""))
        detail = str(check.get("detail", ""))
        items.append(
            QueueItem(
                id="0_8b:fine-tune-comparison",
                tier="0_8b",
                category="fineTuneComparison",
                priority=500,
                requires_hardware=True,
                command=_finetune_command(eval_python),
                evidence=(
                    "bundles/0_8b/finetuned-v2/eliza-1-0_8b-sft.gguf",
                    "evidence/training/0_8b/eliza-bench.json",
                    "evidence/training/0_8b/native-tool-call.json",
                    "evidence/training/0_8b/structured-response.json",
                    "evidence/training/fine-tune-comparison.json",
                ),
                source=name,
                detail=detail,
            )
        )

    for check in _failed_checks(summary, "releaseEvidence"):
        name = str(check.get("name", ""))
        detail = str(check.get("detail", ""))
        tier = _parse_tier(name)
        if not tier:
            continue
        items.append(
            QueueItem(
                id=f"{tier}:release-evidence",
                tier=tier,
                category="releaseEvidence",
                priority=600 + _tier_sort_key(tier),
                requires_hardware=True,
                command=_release_evidence_command(bundle_root, tier, eval_python),
                evidence=(
                    f"bundles/{tier}/evidence/release.json",
                    f"bundles/{tier}/checksums/SHA256SUMS",
                    f"bundles/{tier}/eliza-1.manifest.json",
                ),
                source=name,
                detail=detail,
            )
        )

    return sorted(items, key=lambda item: (item.priority, item.id))


def filter_queue(
    items: list[QueueItem],
    *,
    tier: str | None = None,
    category: str | None = None,
    local_only: bool = False,
    hardware_only: bool = False,
    limit: int | None = None,
) -> list[QueueItem]:
    out = items
    if tier:
        out = [item for item in out if item.tier == tier]
    if category:
        out = [item for item in out if item.category == category]
    if local_only:
        out = [item for item in out if not item.requires_hardware]
    if hardware_only:
        out = [item for item in out if item.requires_hardware]
    if limit is not None:
        out = out[:limit]
    return out


def render_markdown(items: list[QueueItem]) -> str:
    lines = [
        "# Eliza-1 Verification Queue",
        "",
        "Run one item at a time. Do not mark a backend or eval gate passing unless the listed evidence was produced against the staged bundle bytes.",
        "",
    ]
    for item in items:
        hw = "hardware" if item.requires_hardware else "local"
        lines.extend(
            [
                f"## {item.id}",
                f"- category: `{item.category}`",
                f"- tier: `{item.tier}`",
                f"- runner: `{hw}`",
                f"- source: `{item.source}`",
                f"- detail: {item.detail or '(none)'}",
                "- evidence:",
                *[f"  - `{path}`" for path in item.evidence],
                "- command:",
                "",
                "```bash",
                item.command,
                "```",
                "",
            ]
        )
    if not items:
        lines.append("No release verification work items remain in the audit summary.")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--summary-json", type=Path, help="Use a saved audit --summary JSON file.")
    ap.add_argument("--bundle-root", default="/tmp/eliza-1-bundles")
    ap.add_argument(
        "--verify-dir",
        default="plugins/plugin-local-inference/native/verify",
        help="Native verifier directory containing the Makefile and backend runners.",
    )
    ap.add_argument(
        "--eval-python",
        default=None,
        help=(
            "Python executable for scripts.eval.eliza1_eval_suite. Defaults to "
            "ELIZA_EVAL_PYTHON, then /opt/miniconda3/bin/python3 when present, "
            "then python3."
        ),
    )
    ap.add_argument("--format", choices=("json", "markdown"), default="json")
    ap.add_argument("--tier", choices=TIER_ORDER, help="Only emit items for one tier.")
    ap.add_argument(
        "--category",
        choices=(
            "missingReleaseFiles",
            "backendVerification",
            "manifestEvalGates",
            "imagegenEvidence",
            "mtpDrafter",
            "fineTuneComparison",
            "releaseEvidence",
        ),
        help="Only emit one category of work.",
    )
    ap.add_argument("--local-only", action="store_true", help="Only emit work that can run on this host class.")
    ap.add_argument("--hardware-only", action="store_true", help="Only emit work that needs backend-specific hardware.")
    ap.add_argument("--next", action="store_true", help="Emit only the next item after filters.")
    ap.add_argument("--limit", type=int, default=None, help="Maximum number of items to emit.")
    args = ap.parse_args(argv)
    if args.local_only and args.hardware_only:
        ap.error("--local-only and --hardware-only are mutually exclusive")

    if args.summary_json:
        summary = json.loads(args.summary_json.read_text(encoding="utf-8"))
    else:
        summary = audit_hf_release().summary()
    limit = 1 if args.next else args.limit
    all_items = build_queue(
        summary,
        bundle_root=args.bundle_root,
        verify_dir=args.verify_dir,
        eval_python=args.eval_python,
    )
    items = filter_queue(
        all_items,
        tier=args.tier,
        category=args.category,
        local_only=args.local_only,
        hardware_only=args.hardware_only,
        limit=limit,
    )
    payload = {
        "oneBundleAtATime": True,
        "totalItemCount": len(all_items),
        "itemCount": len(items),
        "items": [item.as_dict() for item in items],
    }
    if args.format == "markdown":
        print(render_markdown(items))
    else:
        print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if summary.get("ok") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
