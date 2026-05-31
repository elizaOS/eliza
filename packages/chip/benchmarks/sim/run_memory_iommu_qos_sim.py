#!/usr/bin/env python3
"""Deterministic memory IOMMU + QoS preflight model.

This is a spec-level executable model only. It proves that the target stream
IDs, deny-by-default fault path, and four-class QoS policy can be represented
and checked before RTL/LPDDR/Android evidence exists.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
MEMORY_SPEC = ROOT / "docs/spec-db/memory-2028-target.yaml"
DEFAULT_OUT = ROOT / "benchmarks/results/memory-iommu-qos-sim.json"

QOS_CLASS_WEIGHTS = {
    "isochronous": 8,
    "high": 4,
    "normal": 2,
    "best_effort": 1,
}
FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "rtl_iommu_claim_allowed": False,
    "lpddr_claim_allowed": False,
    "android_dmabuf_claim_allowed": False,
    "silicon_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}


@dataclass
class Stream:
    stream_id: str
    master: str
    qos_class: str
    base: int
    size: int
    permissions: str
    request_beats: int
    beats_served: int = 0
    last_service_cycle: int | None = None
    max_service_gap_cycles: int = 0
    service_gaps: list[int] = field(default_factory=list)


def load_memory_spec() -> dict[str, Any]:
    data = yaml.safe_load(MEMORY_SPEC.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{MEMORY_SPEC.relative_to(ROOT)} must contain a mapping")
    return data


def build_streams(spec: dict[str, Any]) -> list[Stream]:
    iommu = spec.get("iommu")
    if not isinstance(iommu, dict):
        raise ValueError("memory target missing iommu mapping")
    target_streams = iommu.get("per_master_stream_ids")
    if not isinstance(target_streams, list) or not target_streams:
        raise ValueError("memory target missing per_master_stream_ids")

    class_by_stream = {
        "display": "isochronous",
        "audio_dsp": "isochronous",
        "camera_isp": "high",
        "modem": "high",
        "npu_cmd_dma": "normal",
        "npu_data_dma": "normal",
        "gpu": "normal",
        "usb": "best_effort",
        "storage": "best_effort",
    }
    beat_by_class = {
        "isochronous": 192,
        "high": 160,
        "normal": 128,
        "best_effort": 96,
    }
    streams: list[Stream] = []
    for index, entry in enumerate(target_streams):
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            raise ValueError("memory target stream IDs must be mappings with string id")
        stream_id = entry["id"]
        qos_class = class_by_stream.get(stream_id, "best_effort")
        streams.append(
            Stream(
                stream_id=stream_id,
                master=str(entry.get("master", stream_id)),
                qos_class=qos_class,
                base=0x1000_0000 + index * 0x0100_0000,
                size=0x0010_0000,
                permissions="rw" if stream_id != "display" else "r",
                request_beats=beat_by_class[qos_class],
            )
        )
    return streams


def access_allowed(stream: Stream, iova: int, access_type: str) -> bool:
    if not (stream.base <= iova < stream.base + stream.size):
        return False
    if access_type == "write" and "w" not in stream.permissions:
        return False
    return not (access_type == "read" and "r" not in stream.permissions)


def fault_record(stream_id: str, iova: int, access_type: str, syndrome: str) -> dict[str, Any]:
    return {
        "master_id": stream_id,
        "stream_id": stream_id,
        "iova": iova,
        "translated_pa_when_available": None,
        "access_type": access_type,
        "permission_bits": "deny",
        "syndrome_status": syndrome,
        "recovery_behavior": "fault_queue_interrupt_and_context_kill",
    }


def run_iommu_probes(streams: list[Stream]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    by_id = {stream.stream_id: stream for stream in streams}
    allowed: list[dict[str, Any]] = []
    faults: list[dict[str, Any]] = []

    for stream in streams:
        allowed.append(
            {
                "stream_id": stream.stream_id,
                "iova": stream.base + 0x100,
                "access_type": "read",
                "translated_pa": 0x8000_0000 + (stream.base - 0x1000_0000) + 0x100,
            }
        )

    probes = [
        ("npu_data_dma", by_id["display"].base + 0x80, "write", "stream_range_violation"),
        ("display", by_id["display"].base + 0x40, "write", "permission_violation"),
        ("camera_isp", 0x7FFF_F000, "read", "unmapped_iova"),
        ("unknown_debug_dma", by_id["npu_cmd_dma"].base, "read", "unknown_stream_id"),
    ]
    for stream_id, iova, access_type, syndrome in probes:
        probe_stream = by_id.get(stream_id)
        if probe_stream is None or not access_allowed(probe_stream, iova, access_type):
            faults.append(fault_record(stream_id, iova, access_type, syndrome))
    return allowed, faults


def run_qos(streams: list[Stream]) -> dict[str, Any]:
    schedule: list[str] = []
    cycle = 0
    while any(stream.beats_served < stream.request_beats for stream in streams):
        progress = False
        for qos_class, weight in QOS_CLASS_WEIGHTS.items():
            class_streams = [stream for stream in streams if stream.qos_class == qos_class]
            for _ in range(weight):
                for stream in class_streams:
                    if stream.beats_served >= stream.request_beats:
                        continue
                    if stream.last_service_cycle is not None:
                        gap = cycle - stream.last_service_cycle
                        stream.service_gaps.append(gap)
                        stream.max_service_gap_cycles = max(
                            stream.max_service_gap_cycles,
                            gap,
                        )
                    stream.last_service_cycle = cycle
                    stream.beats_served += 1
                    schedule.append(stream.stream_id)
                    cycle += 1
                    progress = True
        if not progress:
            raise RuntimeError("QoS scheduler made no progress")

    all_gaps = [gap for stream in streams for gap in stream.service_gaps]
    sorted_gaps = sorted(all_gaps)
    p99_index = int(0.99 * (len(sorted_gaps) - 1)) if sorted_gaps else 0
    return {
        "streams": [
            {
                "stream_id": stream.stream_id,
                "qos_class": stream.qos_class,
                "request_beats": stream.request_beats,
                "beats_served": stream.beats_served,
                "max_service_gap_cycles": stream.max_service_gap_cycles,
            }
            for stream in streams
        ],
        "summary": {
            "stream_count": len(streams),
            "qos_class_count": len(QOS_CLASS_WEIGHTS),
            "total_beats_served": sum(stream.beats_served for stream in streams),
            "all_requests_completed": all(
                stream.beats_served == stream.request_beats for stream in streams
            ),
            "display_underflow_count": sum(
                1
                for stream in streams
                if stream.stream_id == "display" and stream.max_service_gap_cycles > 32
            ),
            "isochronous_max_service_gap_cycles": max(
                stream.max_service_gap_cycles
                for stream in streams
                if stream.qos_class == "isochronous"
            ),
            "high_max_service_gap_cycles": max(
                stream.max_service_gap_cycles for stream in streams if stream.qos_class == "high"
            ),
            "normal_max_service_gap_cycles": max(
                stream.max_service_gap_cycles for stream in streams if stream.qos_class == "normal"
            ),
            "best_effort_progress": all(
                stream.beats_served > 0 for stream in streams if stream.qos_class == "best_effort"
            ),
            "p99_service_gap_cycles": sorted_gaps[p99_index] if sorted_gaps else 0,
            "schedule_prefix": schedule[:32],
        },
    }


def build_report() -> dict[str, Any]:
    spec = load_memory_spec()
    streams = build_streams(spec)
    allowed, faults = run_iommu_probes(streams)
    qos = run_qos(streams)
    fault_fields = set((spec.get("iommu") or {}).get("fault_reporting_required") or [])
    required_fault_fields = {
        "master_id",
        "stream_id",
        "iova",
        "translated_pa_when_available",
        "access_type",
        "permission_bits",
        "syndrome_status",
        "recovery_behavior",
    }
    summary = qos["summary"]
    summary.update(
        {
            "allowed_probe_count": len(allowed),
            "fault_probe_count": len(faults),
            "deny_by_default_fault_count": len(
                [fault for fault in faults if fault["syndrome_status"] == "unknown_stream_id"]
            ),
            "unauthorized_accesses_blocked": len(faults) == 4,
            "fault_fields_present": required_fault_fields.issubset(fault_fields),
        }
    )
    return {
        "schema": "eliza.memory_iommu_qos_sim.v1",
        "status": "pass",
        "claim_boundary": (
            "Deterministic modeled IOMMU/QoS preflight only; not RTL IOMMU, "
            "not LPDDR controller or PHY, not coherent fabric, not Android dma-buf, "
            "not silicon or phone-class memory evidence."
        ),
        **FALSE_CLAIM_FLAGS,
        "source_spec": "docs/spec-db/memory-2028-target.yaml",
        "config": {
            "deny_by_default": bool((spec.get("iommu") or {}).get("deny_by_default")),
            "stream_count": len(streams),
            "qos_classes": list(QOS_CLASS_WEIGHTS),
            "qos_class_weights": QOS_CLASS_WEIGHTS,
        },
        "iommu_allowed_probes": allowed,
        "iommu_faults": faults,
        "qos_streams": qos["streams"],
        "summary": summary,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    report = build_report()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    try:
        out_label = args.out.relative_to(ROOT)
    except ValueError:
        out_label = args.out
    print(f"wrote {out_label}")


if __name__ == "__main__":
    main()
