"""Release publishing: context."""

from __future__ import annotations
import logging
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping


_REPO_ROOT = Path(__file__).resolve().parents[2]

EXIT_OK = 0

EXIT_USAGE = 2

EXIT_BUNDLE_LAYOUT_FAIL = 10

EXIT_MISSING_FILE = 11

EXIT_KERNEL_VERIFY_FAIL = 12

EXIT_EVAL_GATE_FAIL = 13

EXIT_MANIFEST_INVALID = 14

EXIT_HF_PUSH_FAIL = 15

EXIT_RELEASE_EVIDENCE_FAIL = 16

EXIT_HF_AUDIT_FAIL = 17

ELIZA_1_HF_ORG = "elizaos"

REQUIRED_SUBDIRS: tuple[str, ...] = (
    "text",
    "tts",
    "asr",
    "vad",
    "mtp",
    "cache",
    "evals",
    "licenses",
    "evidence",
    "checksums",
)

REQUIRED_LICENSE_FILES: tuple[str, ...] = (
    "LICENSE.text",
    "LICENSE.voice",
    "LICENSE.mtp",
    "LICENSE.eliza-1",
)

COMPONENT_LICENSE_FILES: Mapping[str, str] = {
    "asr": "LICENSE.asr",
    "vision": "LICENSE.vision",
    "vad": "LICENSE.vad",
    "embedding": "LICENSE.embedding",
    "wakeword": "LICENSE.wakeword",
}

REQUIRED_QUANTIZATION_SIDECARS: Mapping[str, tuple[str, ...]] = {
    "turboquant": ("turboquant.json", "fused_turboquant.json"),
    "qjl": ("qjl_config.json",),
    "polarquant": ("polarquant_config.json",),
}

REQUIRED_QUANTIZATION_SIDECARS_BY_KERNEL: Mapping[str, tuple[str, ...]] = {
    # turboquant_q4 is the Gemma weight-quant proof. The fused sidecar is still
    # required because it carries the runtime kernel layout pins consumed by the
    # manifest builder.
    "turboquant_q4": ("turboquant.json", "fused_turboquant.json"),
    "turbo3_tcq": ("turboquant.json", "fused_turboquant.json"),
    "qjl": ("qjl_config.json",),
    "polarquant": ("polarquant_config.json",),
}

REQUIRED_KERNEL_MANIFEST_KEYS: tuple[str, ...] = (
    "kernel_target",
    "block_layout_version",
    "codebook_hash",
    "per_block_tolerance",
)

REQUIRED_KERNEL_TARGETS_BY_SIDECAR: Mapping[str, tuple[str, ...]] = {
    "turboquant.json": ("turbo3", "turbo4", "turbo3_tcq"),
    "fused_turboquant.json": ("turbo3", "turbo4", "turbo3_tcq"),
    "qjl_config.json": ("qjl1_256",),
    "polarquant_config.json": ("polar_q4",),
}

REQUIRED_METHOD_BY_SIDECAR: Mapping[str, str] = {
    "turboquant.json": "turboquant",
    "fused_turboquant.json": "fused-turboquant",
    "qjl_config.json": "qjl",
    "polarquant_config.json": "polarquant",
}

RELEASE_EVIDENCE_PATH = Path("evidence/release.json")

CHECKSUMS_PATH = Path("checksums/SHA256SUMS")

REQUIRED_RELEASE_FINAL_FLAGS: tuple[str, ...] = (
    "weights",
    "hashes",
    "evals",
    "licenses",
    "kernelDispatchReports",
    "platformEvidence",
    "sizeFirstRepoIds",
)

BASE_V1_RELEASE_FINAL_FLAGS: tuple[str, ...] = tuple(
    flag for flag in REQUIRED_RELEASE_FINAL_FLAGS if flag != "weights"
)

REQUIRED_GRAPH_CACHE_FAMILIES_BY_KERNEL: Mapping[str, tuple[str, ...]] = {
    "turbo3": ("turbo3",),
    "turbo4": ("turbo4",),
    "turbo3_tcq": ("turbo3_tcq",),
    "qjl": ("qjl",),
    "polarquant": ("polar",),
}

TIER_TAGLINES: Mapping[str, str] = {
    "2b": "modern phones",
    "4b": "flagship phones, small desktops",
    "9b": "workstations, tablets, and high-memory local hosts",
    "27b": "GPU workstations",
    "27b-256k": "long-context GPU workstations",
}

DEFAULT_VOICE_CAPABILITIES: tuple[str, ...] = ("tts", "emotion-tags", "singing")

EXPRESSIVE_GATE_NAMES: tuple[str, ...] = (
    "expressive_tag_faithfulness",
    "expressive_mos",
    "expressive_tag_leakage",
)

DEFAULT_RAM_BUDGET_MB: Mapping[str, tuple[int, int]] = {
    "2b": (4000, 5500),
    "4b": (10000, 12000),
    "9b": (12000, 16000),
    "27b": (32000, 48000),
    "27b-256k": (24000, 32000),
}

logging.basicConfig(level=logging.INFO, format="%(message)s")

log = logging.getLogger("publish.orchestrator")


class OrchestratorError(Exception):
    """Raised when a publish stage fails. Carries an exit code."""

    def __init__(self, message: str, exit_code: int) -> None:
        super().__init__(message)
        self.exit_code = exit_code


@dataclass(frozen=True)
class PublishContext:
    tier: str
    bundle_dir: Path
    dry_run: bool
    metal_verification: Path | None
    repo_id: str
    public: bool
    training_repo_root: Path
    template_path: Path
    gates_path: Path | None = None
    # Local path to a previously-published bundle's ``evals/aggregate.json``.
    # When set, the eval gate runs an extra regression check (no metric may
    # slip below the prior bundle's value by more than ``regression_tolerance``
    # — defaults to 5%). Set to ``None`` to skip the check (first-publish path).
    prior_bundle_aggregate: Path | None = None
    regression_tolerance: float = 0.05

    # Artifacts populated as stages run (kept here so tests can introspect).
    layout_files: dict[str, list[Path]] = field(default_factory=dict)


def _git_short_sha(repo_root: Path) -> str:
    """Best-effort training-repo HEAD hash for the verified backend record."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo_root), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
    except FileNotFoundError:
        pass
    return "unknown"


def _optional_float(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _bundle_repo_prefix(ctx: PublishContext) -> str:
    return f"bundles/{ctx.tier}"


def _bundle_repo_path(ctx: PublishContext, rel_path: str) -> str:
    return f"{_bundle_repo_prefix(ctx)}/{rel_path}"
