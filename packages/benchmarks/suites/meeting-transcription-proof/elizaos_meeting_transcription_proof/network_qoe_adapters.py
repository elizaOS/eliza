"""Network-QoE video-conferencing dataset adapters (distinct modality).

Some video-conferencing datasets carry no audio/speech/transcript and so cannot
feed the meeting-artifact transcription/diarization benchmark. VCAPurdue is one:
it is a network measurement corpus — packet traces, BESS-switch buffer logs, and
frame-derived video-QoE metrics (SSIM/PSNR/VIF) captured from Cisco Webex, Google
Meet, Microsoft Teams, and Zoom under controlled network conditions
(https://www.cs.purdue.edu/homes/fahmy/datasets/VCAPurdue/).

Forcing it into ``elizaos.meeting_dataset_adapter.v1`` (which requires an
``elizaos.meeting_artifact.v1`` transcript output) would be dishonest — there is
no transcript to produce. Instead this module defines a sibling contract,
``elizaos.vc_network_qoe.v1``, for the network/QoE benchmark axis: how well an
elizaOS-hosted VC/RTP path (or an on-device capture pipeline) behaves for
congestion control, bandwidth adaptation, and objective video quality under
adverse networks — measured against the dataset's per-app reference behavior.

Same discipline as the transcript adapters: raw rows are never committed
(downloaded at run time), metrics are declared, and the baseline is a reference
system (the dataset's own per-app measured behavior), not a fabricated number.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

VC_QOE_ADAPTER_SCHEMA = "elizaos.vc_network_qoe.v1"

REQUIRED_QOE_ADAPTER_FIELDS = {
    "id",
    "source_url",
    "modality",
    "license_access",
    "apps_covered",
    "scenarios",
    "row_selection",
    "required_hashes",
    "metrics",
    "baseline",
    "training_eval_separation",
}

# Objective network + video-QoE metrics VCAPurdue can gate.
REQUIRED_QOE_METRICS = {
    "throughput_kbps",
    "one_way_latency_ms",
    "packet_loss_rate",
    "rebuffer_ratio",
    "ssim",
    "psnr_db",
    "vif",
}

QOE_ADAPTERS: tuple[dict[str, Any], ...] = (
    {
        "id": "vca_purdue_qoe",
        "source_url": "https://www.cs.purdue.edu/homes/fahmy/datasets/VCAPurdue/",
        "download_url": "http://www.cs.purdue.edu/homes/fahmy/datasets/VCAPurdue/pam2026.zip",
        "modality": "network_qoe",
        "license_access": {
            "repo_license": "unspecified",
            "raw_data_policy": "downloaded-eval",
            "notes": (
                "No explicit license/terms posted on the dataset page (~2.6 GB zip, "
                "direct download, no login). Treat as academic-use; cite Cherian, "
                "Prasad, Fahmy, 'A Microscopic View of Congestion Control Behavior in "
                "Video Conferencing Applications', PAM 2026. Confirm redistribution "
                "terms with the authors (prasad67@purdue.edu) before caching. Raw "
                "traces/logs are never committed to this repo."
            ),
        },
        "apps_covered": ["webex", "google_meet", "microsoft_teams", "zoom"],
        "scenarios": [
            "constant_bandwidth",
            "changing_bandwidth",
            "tcp_background_traffic",
            "udp_background_traffic",
        ],
        "per_sample_files": {
            "traffic_csv": 4,  # in/out x before/after buffer; 5-tuple flow + RTP meta
            "buffer_log": 2,  # BESS switch queue occupancy + packet loss
            "qoe_csv": 1,  # frame-level latency, SSIM, PSNR, VIF
        },
        "row_selection": {
            "strategy": "per_app_per_scenario_after_download",
            "row_count": 8,  # 4 apps x 2 representative scenarios for the smoke gate
            "row_id_fields": ["app", "scenario", "capture_id"],
            "content_hash_fields": ["traffic_csv", "buffer_log", "qoe_csv"],
            "raw_rows_committed": False,
        },
        "required_hashes": [
            "source_revision",
            "row_id",
            "traffic_csv_sha256",
            "qoe_csv_sha256",
            "adapter_config_sha256",
        ],
        "metrics": sorted(REQUIRED_QOE_METRICS),
        "baseline": {
            # The dataset's own measured per-app behavior is the reference; an
            # elizaOS VC/RTP path is compared to it under the same scenario, the
            # compare.py way (delta vs a reference system, not a fixed number).
            "kind": "reference_system_per_app",
            "reference": "VCAPurdue measured Webex/Meet/Teams/Zoom behavior",
            "comparison": "delta of elizaOS RTP path vs dataset app under matched scenario",
            "note": (
                "Not a transcription baseline. Gates network-side VC quality: "
                "congestion-control responsiveness, bandwidth-probe behavior, "
                "loss/latency under adverse networks, and objective video QoE."
            ),
        },
        "training_eval_separation": {
            "eval_only": True,
            "training_allowed": False,
            "note": "Network measurement corpus; eval-only.",
        },
        "transcription_usable": False,
        "usability_note": (
            "VCAPurdue has NO audio/speech/speaker labels/transcripts, so it cannot "
            "benchmark ASR or diarization. For transcript+diarization use "
            "zoomgroupstats_p0_smoke (this package) or AMI/ICSI/VoxConverse/DIHARD."
        ),
    },
)


def build_qoe_adapter_contract() -> dict[str, Any]:
    return {
        "schema": VC_QOE_ADAPTER_SCHEMA,
        "adapters": deepcopy(list(QOE_ADAPTERS)),
        "raw_data_committed": False,
        "publishable_run_required": True,
    }


def validate_qoe_adapter_contract(contract: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if contract.get("schema") != VC_QOE_ADAPTER_SCHEMA:
        errors.append(f"schema must be {VC_QOE_ADAPTER_SCHEMA}")
    if contract.get("raw_data_committed") is not False:
        errors.append("raw_data_committed must be false")
    if contract.get("publishable_run_required") is not True:
        errors.append("publishable_run_required must be true")

    adapters = contract.get("adapters")
    if not isinstance(adapters, list) or not adapters:
        return [*errors, "adapters must be a non-empty array"]

    seen_ids: set[str] = set()
    for index, adapter in enumerate(adapters):
        if not isinstance(adapter, dict):
            errors.append(f"adapters[{index}] must be an object")
            continue
        missing = REQUIRED_QOE_ADAPTER_FIELDS - set(adapter)
        if missing:
            errors.append(f"adapters[{index}] missing fields: {sorted(missing)}")
        adapter_id = adapter.get("id")
        if not isinstance(adapter_id, str) or not adapter_id:
            errors.append(f"adapters[{index}].id must be non-empty")
        elif adapter_id in seen_ids:
            errors.append(f"duplicate adapter id: {adapter_id}")
        else:
            seen_ids.add(adapter_id)
        if adapter.get("modality") != "network_qoe":
            errors.append(f"adapters[{index}].modality must be network_qoe")
        license_access = adapter.get("license_access")
        if not isinstance(license_access, dict):
            errors.append(f"adapters[{index}].license_access must be an object")
            license_access = {}
        if license_access.get("raw_data_policy") != "downloaded-eval":
            errors.append(f"adapters[{index}].license_access.raw_data_policy must be downloaded-eval")
        row_selection = adapter.get("row_selection")
        if not isinstance(row_selection, dict):
            errors.append(f"adapters[{index}].row_selection must be an object")
            row_selection = {}
        if row_selection.get("raw_rows_committed") is not False:
            errors.append(f"adapters[{index}].row_selection.raw_rows_committed must be false")
        row_count = row_selection.get("row_count")
        if isinstance(row_count, bool) or not isinstance(row_count, int) or row_count <= 0:
            errors.append(f"adapters[{index}].row_selection.row_count must be positive")
        required_hashes = adapter.get("required_hashes")
        if not isinstance(required_hashes, list) or "adapter_config_sha256" not in required_hashes:
            errors.append(f"adapters[{index}].required_hashes must include adapter_config_sha256")
        metrics = adapter.get("metrics")
        metric_set = set(metrics) if isinstance(metrics, list) else set()
        missing_metrics = REQUIRED_QOE_METRICS - metric_set
        if missing_metrics:
            errors.append(f"adapters[{index}].metrics missing: {sorted(missing_metrics)}")
        if not isinstance(adapter.get("baseline"), dict):
            errors.append(f"adapters[{index}].baseline must be an object")
        separation = adapter.get("training_eval_separation")
        if not isinstance(separation, dict):
            errors.append(f"adapters[{index}].training_eval_separation must be an object")
            separation = {}
        if separation.get("eval_only") is not True or separation.get("training_allowed") is not False:
            errors.append(f"adapters[{index}].training_eval_separation must be eval-only")
    return errors
