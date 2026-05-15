"""Validate the Eliza-1 GGUF source/quantization plan.

This is intentionally lightweight: the default validation is offline and
checks the checked-in manifest against policy and local script paths. Use
``--check-hf`` for an operator preflight that also verifies the referenced
Hugging Face repos/files are still public.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Mapping, Sequence

TRAINING_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PLAN = TRAINING_ROOT / "config" / "eliza1_gguf_pipeline_manifest.json"

REQUIRED_TIERS: tuple[str, ...] = (
    "0_8b",
    "2b",
    "4b",
    "9b",
    "27b",
    "27b-256k",
    "27b-1m",
)
QWEN35_TIERS: tuple[str, ...] = ("0_8b", "2b", "4b", "9b")
QWEN36_27B_TIERS: tuple[str, ...] = ("27b", "27b-256k", "27b-1m")
OFFICIAL_QWEN36_27B = "Qwen/Qwen3.6-27B"


def load_plan(path: Path = DEFAULT_PLAN) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        blob = json.load(f)
    if not isinstance(blob, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return blob


def _is_mapping(value: Any) -> bool:
    return isinstance(value, dict)


def _local_script_errors(plan: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    quantization = plan.get("quantization")
    if not _is_mapping(quantization):
        return ["quantization: must be an object"]

    for section in ("runtimeStack", "ggufKQuantLadder"):
        entries = quantization.get(section)
        if not isinstance(entries, list):
            errors.append(f"quantization.{section}: must be a list")
            continue
        for idx, entry in enumerate(entries):
            if not _is_mapping(entry):
                errors.append(f"quantization.{section}[{idx}]: must be an object")
                continue
            script = entry.get("script")
            if not isinstance(script, str) or not script:
                errors.append(f"quantization.{section}[{idx}].script: required")
                continue
            script_path = TRAINING_ROOT / script
            if not script_path.is_file():
                errors.append(
                    f"quantization.{section}[{idx}].script missing: {script}"
                )
    return errors


def validate_plan(plan: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if plan.get("schemaVersion") != 1:
        errors.append("schemaVersion: expected 1")

    tiers = plan.get("tiers")
    if not _is_mapping(tiers):
        errors.append("tiers: must be an object")
        return errors

    tier_keys = set(tiers)
    missing = set(REQUIRED_TIERS) - tier_keys
    if missing:
        errors.append(f"tiers: missing required tiers {sorted(missing)}")

    for tier in REQUIRED_TIERS:
        entry = tiers.get(tier)
        if not _is_mapping(entry):
            continue
        source = entry.get("sourceModel")
        family = entry.get("family")
        context_tokens = entry.get("contextTokens")
        gguf_seed = entry.get("ggufSeed")

        if not isinstance(source, str) or "/" not in source:
            errors.append(f"tiers.{tier}.sourceModel: expected HF repo id")
        if tier in QWEN35_TIERS:
            if family != "qwen3.5":
                errors.append(f"tiers.{tier}.family: expected qwen3.5 fallback")
            if isinstance(source, str) and source.startswith("Qwen/Qwen3.6-"):
                errors.append(
                    f"tiers.{tier}.sourceModel: lower tiers must not invent "
                    f"a Qwen3.6 repo ({source})"
                )
        if tier in QWEN36_27B_TIERS:
            if family != "qwen3.6":
                errors.append(f"tiers.{tier}.family: expected qwen3.6")
            if source != OFFICIAL_QWEN36_27B:
                errors.append(
                    f"tiers.{tier}.sourceModel: expected {OFFICIAL_QWEN36_27B}"
                )
        if not isinstance(context_tokens, int) or context_tokens <= 0:
            errors.append(f"tiers.{tier}.contextTokens: expected positive int")

        if not _is_mapping(gguf_seed):
            errors.append(f"tiers.{tier}.ggufSeed: must be an object")
        else:
            repo = gguf_seed.get("repo")
            filename = gguf_seed.get("file")
            if not isinstance(repo, str) or "/" not in repo:
                errors.append(f"tiers.{tier}.ggufSeed.repo: expected HF repo id")
            if not isinstance(filename, str) or not filename.endswith(".gguf"):
                errors.append(f"tiers.{tier}.ggufSeed.file: expected .gguf file")
            if tier.startswith("27b") and repo != "unsloth/Qwen3.6-27B-GGUF":
                errors.append(
                    f"tiers.{tier}.ggufSeed.repo: expected Qwen3.6 GGUF seed"
                )

    errors.extend(_local_script_errors(plan))
    return errors


def _hf_model_info(repo_id: str) -> dict[str, Any]:
    quoted = urllib.parse.quote(repo_id, safe="/")
    url = f"https://huggingface.co/api/models/{quoted}"
    req = urllib.request.Request(url, headers={"User-Agent": "eliza-gguf-plan/1"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"{repo_id}: HF API returned HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"{repo_id}: HF API request failed: {exc}") from exc


def hf_check_errors(plan: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    tiers = plan.get("tiers")
    if not _is_mapping(tiers):
        return ["tiers: must be an object"]

    seen_repos: dict[str, set[str]] = {}
    for tier, entry in tiers.items():
        if not _is_mapping(entry):
            continue
        for repo in (entry.get("sourceModel"), (entry.get("ggufSeed") or {}).get("repo")):
            if isinstance(repo, str):
                seen_repos.setdefault(repo, set())
        gguf_seed = entry.get("ggufSeed")
        if _is_mapping(gguf_seed):
            repo = gguf_seed.get("repo")
            filename = gguf_seed.get("file")
            if isinstance(repo, str) and isinstance(filename, str):
                seen_repos.setdefault(repo, set()).add(filename)

    for repo, required_files in sorted(seen_repos.items()):
        try:
            info = _hf_model_info(repo)
        except RuntimeError as exc:
            errors.append(str(exc))
            continue
        siblings = {
            sibling.get("rfilename")
            for sibling in info.get("siblings", [])
            if isinstance(sibling, dict)
        }
        for filename in sorted(required_files):
            if filename not in siblings:
                errors.append(f"{repo}: missing file {filename}")
    return errors


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    parser.add_argument(
        "--check-hf",
        action="store_true",
        help="Also verify referenced HF repos/files via huggingface.co/api/models.",
    )
    parser.add_argument("--json", action="store_true", help="Emit a JSON report.")
    args = parser.parse_args(argv)

    plan = load_plan(args.plan)
    errors = validate_plan(plan)
    if args.check_hf:
        errors.extend(hf_check_errors(plan))

    report = {
        "plan": str(args.plan),
        "check_hf": args.check_hf,
        "ok": not errors,
        "errors": errors,
    }
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    elif errors:
        print("Eliza-1 GGUF plan validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
    else:
        print(f"Eliza-1 GGUF plan OK: {args.plan}")
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
