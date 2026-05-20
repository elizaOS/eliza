#!/usr/bin/env python3
"""
Compare a base model and a locally trained artifact without requiring MLX HTTP serving.

This supports CPU/CUDA `transformers` directories as well as MLX base+adapter
pairs and produces the same style of deterministic Action/Reason comparison
report used by the publication pipeline.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "training"))

from compare_served_models import (
    DEFAULT_SYSTEM_PROMPT,
    aggregate_variant_suites,
    build_suite_configs,
    compare_variant_results,
    flatten_suite_prompts,
    load_prompts,
    normalize_text,
    score_response_text,
    summarize_results,
)
from deterministic_eval import ACTION_REASON_ASSISTANT_PREFIX
from local_inference import BackendName, LocalTextGenerator


def load_manifest(manifest_path: Path) -> tuple[str, str, BackendName]:
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    model_name = manifest.get("model_name")
    output_path = manifest.get("output_path")
    backend = manifest.get("backend")
    if not model_name or not output_path or backend not in {"mlx", "cuda", "cpu"}:
        raise ValueError(
            f"Manifest {manifest_path} is missing model_name, output_path, or a supported backend"
        )

    return str(model_name), str(output_path), backend


def evaluate_model_variant(
    *,
    label: str,
    backend: BackendName,
    model_ref: str,
    adapter_path: str | None,
    prompts: Sequence[dict[str, str]],
    system_prompt: str,
    max_tokens: int,
    assistant_prefix: str | None = ACTION_REASON_ASSISTANT_PREFIX,
    score_fn=score_response_text,
    summarize_fn=summarize_results,
) -> dict[str, Any]:
    generator = LocalTextGenerator(
        backend=backend,
        model_ref=model_ref,
        adapter_path=adapter_path,
    )
    try:
        results = []
        for prompt in prompts:
            start = time.perf_counter()
            response_text = generator.generate_messages(
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt["prompt"]},
                ],
                max_new_tokens=max_tokens,
                assistant_prefix=assistant_prefix,
            )
            latency_ms = (time.perf_counter() - start) * 1000
            results.append(
                {
                    "prompt_id": prompt["id"],
                    "prompt": prompt["prompt"],
                    "slice": prompt.get("slice"),
                    "response": response_text,
                    "latency_ms": round(latency_ms, 1),
                    "score": score_fn(response_text, prompt),
                }
            )

        return {
            "label": label,
            "backend": backend,
            "model_ref": model_ref,
            "adapter_path": adapter_path,
            "summary": summarize_fn(results),
            "results": results,
        }
    finally:
        generator.close()


def update_manifest_with_report(
    manifest_path: Path,
    output_path: Path,
    report: dict[str, Any],
) -> None:
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    manifest["local_evaluation"] = {
        "report_path": str(output_path),
        "generated_at": report["timestamp"],
        "backend": report["backend"],
        "base_summary": report["base_model"]["summary"],
        "trained_summary": report["trained_model"]["summary"],
        "comparison": report["comparison"],
    }

    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)


def generate_comparison_report(
    *,
    model_name: str,
    trained_model_path: str,
    backend: BackendName,
    prompts: Sequence[dict[str, str]] | None = None,
    system_prompt: str = DEFAULT_SYSTEM_PROMPT,
    max_tokens: int = 120,
    include_decision_suite: bool = True,
    output_path: Path,
    manifest_path: Path | None = None,
) -> dict[str, Any]:
    suite_configs = build_suite_configs(
        prompts=list(prompts) if prompts is not None else None,
        system_prompt=system_prompt,
        max_tokens=max_tokens,
        include_decision_suite=include_decision_suite,
    )

    def evaluate_suites(label: str, *, adapter_path: str | None, model_ref: str) -> dict[str, Any]:
        suite_variants: dict[str, dict[str, Any]] = {}
        for suite in suite_configs:
            suite_variants[str(suite["name"])] = evaluate_model_variant(
                label=label,
                backend=backend,
                model_ref=model_ref,
                adapter_path=adapter_path,
                prompts=suite["prompts"],
                system_prompt=suite["system_prompt"],
                max_tokens=int(suite["max_tokens"]),
                assistant_prefix=suite.get("assistant_prefix"),
                score_fn=suite["score_fn"],
                summarize_fn=suite["summarize_fn"],
            )
        return aggregate_variant_suites(suite_variants=suite_variants)

    if backend == "mlx":
        base_eval = evaluate_suites("base", adapter_path=None, model_ref=model_name)
        trained_eval = evaluate_suites(
            "trained", adapter_path=trained_model_path, model_ref=model_name
        )
    else:
        base_eval = evaluate_suites("base", adapter_path=None, model_ref=model_name)
        trained_eval = evaluate_suites("trained", adapter_path=None, model_ref=trained_model_path)

    comparison = compare_variant_results(
        base_eval["results"],
        trained_eval["results"],
    )
    distinct_responses = [
        item
        for item in comparison["per_prompt"]
        if not normalize_text(
            next(
                result["response"]
                for result in base_eval["results"]
                if result["prompt_id"] == item["prompt_id"]
            )
        )
        == normalize_text(
            next(
                result["response"]
                for result in trained_eval["results"]
                if result["prompt_id"] == item["prompt_id"]
            )
        )
    ]

    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "backend": backend,
        "system_prompt": system_prompt if len(suite_configs) == 1 else None,
        "prompts": flatten_suite_prompts(suite_configs),
        "suites": [
            {
                "name": suite["name"],
                "system_prompt": suite["system_prompt"],
                "prompt_count": len(suite["prompts"]),
                "max_tokens": suite["max_tokens"],
            }
            for suite in suite_configs
        ],
        "base_model": base_eval,
        "trained_model": trained_eval,
        "comparison": {
            **comparison,
            "distinct_prompt_ids": [item["prompt_id"] for item in distinct_responses],
        },
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    if manifest_path is not None:
        update_manifest_with_report(manifest_path, output_path, report)

    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compare a base model and trained local artifact with direct inference."
    )
    parser.add_argument(
        "--manifest",
        help="Path to training_manifest.json with backend, model_name, and output_path",
    )
    parser.add_argument("--model", help="Base model id/path")
    parser.add_argument(
        "--trained-model-path", help="Path to trained model directory or MLX adapter"
    )
    parser.add_argument("--backend", choices=["mlx", "cuda", "cpu"])
    parser.add_argument(
        "--prompt-file",
        help="Optional JSON file with prompt objects ({id, prompt}) or strings",
    )
    parser.add_argument("--max-tokens", type=int, default=120)
    parser.add_argument("--system-prompt", default=DEFAULT_SYSTEM_PROMPT)
    parser.add_argument(
        "--output",
        help="Where to save the comparison JSON (default: <manifest dir>/local_model_comparison.json)",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    manifest_path: Path | None = None
    if args.manifest:
        manifest_path = Path(args.manifest)
        model_name, trained_model_path, backend = load_manifest(manifest_path)
        output_path = (
            Path(args.output)
            if args.output
            else manifest_path.parent / "local_model_comparison.json"
        )
    else:
        if not args.model or not args.trained_model_path or not args.backend:
            parser.error(
                "Provide either --manifest or all of --model, --trained-model-path, and --backend"
            )
        model_name = args.model
        trained_model_path = args.trained_model_path
        backend = args.backend
        output_path = (
            Path(args.output) if args.output else Path.cwd() / "local_model_comparison.json"
        )

    prompts = load_prompts(args.prompt_file) if args.prompt_file else None
    include_decision_suite = (
        args.prompt_file is None and args.system_prompt == DEFAULT_SYSTEM_PROMPT
    )
    report = generate_comparison_report(
        model_name=model_name,
        trained_model_path=trained_model_path,
        backend=backend,
        prompts=prompts,
        system_prompt=args.system_prompt,
        max_tokens=args.max_tokens,
        include_decision_suite=include_decision_suite,
        output_path=output_path,
        manifest_path=manifest_path,
    )

    print(
        f"Base avg score: {report['base_model']['summary']['avg_score']:.4f} "
        f"({report['base_model']['summary']['avg_latency_ms']:.1f} ms)"
    )
    print(
        f"Trained avg score: {report['trained_model']['summary']['avg_score']:.4f} "
        f"({report['trained_model']['summary']['avg_latency_ms']:.1f} ms)"
    )
    print(
        f"Distinct responses: {report['comparison']['distinct_response_count']}/"
        f"{report['base_model']['summary'].get('prompt_count', 0)}"
    )
    print(f"Saved report to {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
