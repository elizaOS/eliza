#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from gemma_capacity import (
    GEMMA_MODEL_SPECS,
    build_capacity_report,
    parse_context_length,
    resolve_model_spec,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Compute Gemma scaling-law, memory, and Nebius capacity plans.",
    )
    parser.add_argument(
        "--model",
        action="append",
        dest="models",
        help=(
            "Model id or alias. Repeat to plan multiple models. Defaults to all "
            "canonical Gemma 4 text targets."
        ),
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
        default=None,
        help=(
            "APOLLO rank used for optimizer-state estimates. Defaults to the "
            "Gemma tier registry value."
        ),
    )
    parser.add_argument(
        "--lora-rank",
        type=int,
        default=64,
        help="LoRA rank used for QLoRA adapter-memory estimates.",
    )
    parser.add_argument(
        "--kv-bits",
        type=float,
        default=16.0,
        help="Effective KV-cache precision used for Gemma KV planning.",
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
        "# Gemma Capacity Plan",
        "",
        "| Model | Eliza tier | AdamW total | APOLLO total | QLoRA NF4 | H100 APOLLO | H200 APOLLO |",
        "|---|---|---:|---:|---:|---|---|",
    ]
    for report in reports:
        model = report["model"]
        training = report["training_memory"]
        fit = report["single_gpu_fit"]
        lines.append(
            "| "
            f"{model['display_name']} | "
            f"{model['eliza_tier']} | "
            f"{training['adamw_total_gib']['total_gib']:.3f} GiB | "
            f"{training['apollo_total_gib']['total_gib']:.3f} GiB | "
            f"{training['qlora_nf4_gib']['total_gib']:.3f} GiB | "
            f"{fit['h100_apollo_total']} | "
            f"{fit['h200_apollo_total']} |"
        )
        lines.append("")
        lines.append("## " + model["display_name"])
        lines.append("")
        lines.append(f"- Chinchilla total tokens: `{report['chinchilla_total']['tokens']:,}`")
        lines.append(
            f"- Adapter memory: LoRA bf16 `{training['lora_bf16_gib']['total_gib']:.3f} GiB`, "
            f"QLoRA NF4 `{training['qlora_nf4_gib']['total_gib']:.3f} GiB`"
        )
        for context in report["context_memory"]:
            lines.append(
                f"- Context `{context['context_tokens']:,}`: "
                f"KV bf16 `{context['kv_cache_bf16_gib']:.3f} GiB`, "
                f"planned `{context['kv_cache_planned_gib']:.3f} GiB` "
                f"at {context['kv_bits']}-bit; full layers "
                f"`{context['full_attention_layers']}`, effective sliding KV layers "
                f"`{context['effective_sliding_kv_layers']}`"
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
                raise ValueError(f"Unknown Gemma model alias or id: {value}")
            specs.append(spec)
    else:
        specs = list(GEMMA_MODEL_SPECS)

    reports = []
    for spec in specs:
        apollo_rank = (
            args.apollo_rank
            if args.apollo_rank is not None
            else spec.default_apollo_rank
        )
        reports.append(
            build_capacity_report(
                spec,
                contexts=contexts,
                training_sequence_length=args.training_seq_length,
                micro_batch_size=args.micro_batch_size,
                apollo_rank=apollo_rank,
                lora_rank=args.lora_rank,
                kv_bits=args.kv_bits,
            )
        )

    if args.format == "markdown":
        print(render_markdown(reports))
    else:
        print(json.dumps(reports, indent=2))


if __name__ == "__main__":
    main()
