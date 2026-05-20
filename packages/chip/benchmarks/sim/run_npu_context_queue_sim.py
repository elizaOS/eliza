#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from benchmarks.sim.run_npu_scale_sim import CONFIGS, ceil_div  # noqa: E402


@dataclass
class ContextState:
    context_id: int
    weight: int
    qos_class: str
    descriptors_remaining: int
    descriptors_served: int = 0
    dma_beats_served: int = 0
    max_service_gap_cycles: int = 0
    last_service_cycle: int | None = None

    @property
    def total_descriptors(self) -> int:
        return self.descriptors_remaining + self.descriptors_served


QOS_CLASSES = (
    ("interactive_ai", 4),
    ("camera_ai", 3),
    ("display_assist", 2),
    ("audio_ai", 2),
    ("background_llm", 1),
    ("background_vision", 1),
    ("system_service", 1),
    ("test_context", 1),
)


def make_contexts(descriptors_per_context: int) -> list[ContextState]:
    return [
        ContextState(
            context_id=index,
            weight=weight,
            qos_class=name,
            descriptors_remaining=descriptors_per_context,
        )
        for index, (name, weight) in enumerate(QOS_CLASSES)
    ]


def run_weighted_queue(
    *,
    descriptors_per_context: int,
    descriptor_payload_bytes: int,
    dma_bytes_per_cycle: int,
) -> dict:
    contexts = make_contexts(descriptors_per_context)
    descriptor_dma_beats = ceil_div(descriptor_payload_bytes, dma_bytes_per_cycle)
    cycle = 0
    schedule: list[int] = []
    while any(context.descriptors_remaining > 0 for context in contexts):
        progressed = False
        for context in contexts:
            for _ in range(context.weight):
                if context.descriptors_remaining <= 0:
                    continue
                if context.last_service_cycle is not None:
                    context.max_service_gap_cycles = max(
                        context.max_service_gap_cycles,
                        cycle - context.last_service_cycle,
                    )
                context.last_service_cycle = cycle
                context.descriptors_remaining -= 1
                context.descriptors_served += 1
                context.dma_beats_served += descriptor_dma_beats
                schedule.append(context.context_id)
                cycle += 1
                progressed = True
        if not progressed:
            raise RuntimeError("weighted queue made no progress")

    service_shares = [
        context.descriptors_served / sum(item.descriptors_served for item in contexts)
        for context in contexts
    ]
    jain = (sum(service_shares) ** 2) / (len(service_shares) * sum(x * x for x in service_shares))
    return {
        "contexts": [
            {
                "context_id": context.context_id,
                "qos_class": context.qos_class,
                "weight": context.weight,
                "descriptors_requested": context.total_descriptors,
                "descriptors_served": context.descriptors_served,
                "dma_beats_served": context.dma_beats_served,
                "max_service_gap_cycles": context.max_service_gap_cycles,
            }
            for context in contexts
        ],
        "summary": {
            "context_count": len(contexts),
            "total_descriptors_served": sum(context.descriptors_served for context in contexts),
            "total_dma_beats_served": sum(context.dma_beats_served for context in contexts),
            "max_service_gap_cycles": max(context.max_service_gap_cycles for context in contexts),
            "min_service_share": min(service_shares),
            "max_service_share": max(service_shares),
            "jain_fairness_index": jain,
            "all_contexts_completed": all(
                context.descriptors_remaining == 0 for context in contexts
            ),
            "schedule_prefix": schedule[:64],
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run modeled NPU multi-context queue fairness sim")
    parser.add_argument("--config", choices=sorted(CONFIGS), default="open_2028_sota_160tops")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--descriptors-per-context", type=int, default=128)
    args = parser.parse_args()

    if args.descriptors_per_context <= 0:
        raise SystemExit("--descriptors-per-context must be positive")
    config = CONFIGS[args.config]
    descriptor_payload_bytes = config.scratchpad_kib * 1024
    queue = run_weighted_queue(
        descriptors_per_context=args.descriptors_per_context,
        descriptor_payload_bytes=descriptor_payload_bytes,
        dma_bytes_per_cycle=config.dma_bytes_per_cycle,
    )
    report = {
        "schema": "eliza.npu_context_queue_sim.v1",
        "status": "pass",
        "claim_boundary": (
            "Deterministic modeled multi-context queue fairness only; not RTL scheduler, "
            "IOMMU isolation, Android HAL, measured QoS, silicon, or phone-class evidence."
        ),
        "config": {
            "name": config.name,
            "descriptor_queue_depth": config.dma_queue_depth,
            "concurrent_contexts": len(QOS_CLASSES),
            "descriptor_payload_bytes": descriptor_payload_bytes,
            "dma_bytes_per_cycle": config.dma_bytes_per_cycle,
            "descriptors_per_context": args.descriptors_per_context,
        },
        **queue,
    }
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.out:
        output = args.out if args.out.is_absolute() else ROOT / args.out
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text, encoding="utf-8")
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
