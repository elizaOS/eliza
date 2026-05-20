#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "training"))

from qwen_capacity import (
    QWEN_MODEL_SPECS,
    build_capacity_report,
    parse_context_length,
    resolve_model_spec,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Compute Qwen scaling-law, memory, and Nebius capacity plans.",
    )
    parser.add_argument(
        "--model",
        action="append",
        dest="models",
        help="Model id or alias. Repeat to plan multiple models. Defaults to all canonical Qwen 3.5 targets.",
    )
    parser.add_argument(
        "--contexts",
        default="128k,256k",
        help="Comma-separated context lengths for KV-cache planning, e.g. 128k,256k.",
    )
    parser.add_argument(
        "--training-seq-length",
        type=parse_context_length,
        default=8192,
        help="Training sequence length used for activation and fit estimates.",
    )
    parser.add_argument(
        "--micro-batch-size",
        type=int,
        default=1,
        help="Micro-batch size used for training-memory estimates.",
    )
    parser.add_argument(
        "--apollo-rank",
        type=int,
        default=64,
        help="APOLLO rank used for optimizer-state estimates.",
    )
    parser.add_argument(
        "--lora-rank",
        type=int,
        default=64,
        help="LoRA rank used for QLoRA adapter-memory estimates.",
    )
    parser.add_argument(
        "--turboquant-bits",
        type=float,
        default=4.0,
        help="Effective KV-cache precision used for TurboQuant planning.",
    )
    parser.add_argument(
        "--format",
        choices=["json", "markdown"],
        default="json",
        help="Output format.",
    )
    return parser


def render_markdown(reports: list[dict[str, object]]) -> str:
    lines = [
        "# Qwen Capacity Plan",
        "",
        "| Model | AdamW total | APOLLO total | APOLLO active | QLoRA NF4 | H100 APOLLO | H200 APOLLO |",
        "|---|---:|---:|---:|---:|---|---|",
    ]
    for report in reports:
        model = report["model"]
        training = report["training_memory"]
        fit = report["single_gpu_fit"]
        lines.append(
            "| "
            f"{model['display_name']} | "
            f"{training['adamw_total_gib']['total_gib']:.3f} GiB | "
            f"{training['apollo_total_gib']['total_gib']:.3f} GiB | "
            f"{training.get('apollo_active_gib', {}).get('total_gib', '-')} | "
            f"{training['qlora_nf4_gib']['total_gib']:.3f} GiB | "
            f"{fit.get('h100_apollo_active', fit['h100_apollo_total'])} | "
            f"{fit.get('h200_apollo_active', fit['h200_apollo_total'])} |"
        )
        lines.append("")
        lines.append("## " + model["display_name"])
        lines.append("")
        lines.append(f"- Chinchilla total tokens: `{report['chinchilla_total']['tokens']:,}`")
        if "chinchilla_active" in report:
            lines.append(f"- Chinchilla active tokens: `{report['chinchilla_active']['tokens']:,}`")
        lines.append(
            f"- Adapter memory: LoRA bf16 `{training['lora_bf16_gib']['total_gib']:.3f} GiB`, "
            f"QLoRA NF4 `{training['qlora_nf4_gib']['total_gib']:.3f} GiB`"
        )
        for context in report["context_memory"]:
            lines.append(
                f"- Context `{context['context_tokens']:,}`: "
                f"KV bf16 `{context['kv_cache_bf16_gib']:.3f} GiB`, "
                f"TurboQuant `{context['kv_cache_turboquant_gib']:.3f} GiB` "
                f"at {context['turboquant_bits']}-bit"
            )
        lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    contexts = [parse_context_length(item) for item in args.contexts.split(",") if item.strip()]
    specs = []
    if args.models:
        for value in args.models:
            spec = resolve_model_spec(value)
            if spec is None:
                raise ValueError(f"Unknown Qwen model alias or id: {value}")
            specs.append(spec)
    else:
        specs = list(QWEN_MODEL_SPECS)

    reports = [
        build_capacity_report(
            spec,
            contexts=contexts,
            training_sequence_length=args.training_seq_length,
            micro_batch_size=args.micro_batch_size,
            apollo_rank=args.apollo_rank,
            lora_rank=args.lora_rank,
            turboquant_bits=args.turboquant_bits,
        )
        for spec in specs
    ]

    if args.format == "markdown":
        print(render_markdown(reports))
    else:
        print(json.dumps(reports, indent=2))


if __name__ == "__main__":
    main()
