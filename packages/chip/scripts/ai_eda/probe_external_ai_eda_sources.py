#!/usr/bin/env python3
"""Probe external AI/EDA code, model, and dataset URLs without importing assets."""

from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
INVENTORY = ROOT / "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml"
PROVENANCE = ROOT / "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/external_source_probe"
CLAIM_BOUNDARY = "external_metadata_probe_only_no_import_no_release_use"
USER_AGENT = "eliza-ai-eda-source-probe/1.0"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected mapping")
    return data


def request_json(url: str, timeout: float) -> tuple[str, dict[str, Any] | None, str | None]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            status = f"HTTP_{response.status}"
    except urllib.error.HTTPError as exc:
        return f"HTTP_{exc.code}", None, str(exc)
    except urllib.error.URLError as exc:
        return "NETWORK_ERROR", None, str(exc.reason)
    except TimeoutError as exc:
        return "TIMEOUT", None, str(exc)
    try:
        data = json.loads(body)
    except json.JSONDecodeError as exc:
        return status, None, f"invalid_json: {exc}"
    if not isinstance(data, dict):
        return status, None, "json_root_not_mapping"
    return status, data, None


def github_api(url: str) -> str | None:
    prefix = "https://github.com/"
    if not url.startswith(prefix):
        return None
    parts = url.removeprefix(prefix).strip("/").split("/")
    if len(parts) < 2:
        return None
    owner, repo = parts[0], parts[1]
    return f"https://api.github.com/repos/{owner}/{repo}"


def huggingface_api(url: str) -> str | None:
    prefix = "https://huggingface.co/"
    if not url.startswith(prefix):
        return None
    parts = url.removeprefix(prefix).strip("/").split("/")
    if len(parts) < 2:
        return None
    if parts[0] == "datasets" and len(parts) >= 3:
        return f"https://huggingface.co/api/datasets/{parts[1]}/{parts[2]}"
    return f"https://huggingface.co/api/models/{parts[0]}/{parts[1]}"


def source_urls(entry: dict[str, Any]) -> list[dict[str, str]]:
    urls: list[dict[str, str]] = []
    for field in ("code_url", "model_url", "dataset_url"):
        value = entry.get(field)
        if isinstance(value, str) and value.startswith("https://"):
            urls.append({"kind": field.removesuffix("_url"), "url": value})
    return urls


def summarize_github(data: dict[str, Any]) -> dict[str, Any]:
    license_data = data.get("license")
    return {
        "full_name": data.get("full_name"),
        "default_branch": data.get("default_branch"),
        "archived": data.get("archived"),
        "disabled": data.get("disabled"),
        "stars": data.get("stargazers_count"),
        "forks": data.get("forks_count"),
        "open_issues": data.get("open_issues_count"),
        "pushed_at": data.get("pushed_at"),
        "license": license_data.get("spdx_id") if isinstance(license_data, dict) else None,
    }


def summarize_huggingface(data: dict[str, Any]) -> dict[str, Any]:
    card = data.get("cardData")
    tags = data.get("tags")
    return {
        "id": data.get("id"),
        "sha": data.get("sha"),
        "last_modified": data.get("lastModified"),
        "downloads": data.get("downloads"),
        "likes": data.get("likes"),
        "license": card.get("license") if isinstance(card, dict) else None,
        "pipeline_tag": data.get("pipeline_tag"),
        "tags": tags[:12] if isinstance(tags, list) else [],
    }


def probe_url(url: str, timeout: float) -> dict[str, Any]:
    github = github_api(url)
    if github:
        status, data, error = request_json(github, timeout)
        return {
            "url": url,
            "probe_api": github,
            "provider": "github",
            "status": status,
            "summary": summarize_github(data) if data else {},
            "error": error,
        }
    huggingface = huggingface_api(url)
    if huggingface:
        status, data, error = request_json(huggingface, timeout)
        return {
            "url": url,
            "probe_api": huggingface,
            "provider": "huggingface",
            "status": status,
            "summary": summarize_huggingface(data) if data else {},
            "error": error,
        }
    return {
        "url": url,
        "probe_api": None,
        "provider": "unsupported_for_json_probe",
        "status": "SKIPPED",
        "summary": {},
        "error": "no_supported_metadata_api",
    }


def provenance_by_source() -> dict[str, dict[str, Any]]:
    data = load_yaml(PROVENANCE)
    entries = data.get("entries")
    if not isinstance(entries, list):
        return {}
    return {
        entry["source_id"]: entry
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("source_id"), str)
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--timeout-seconds", type=float, default=8.0)
    parser.add_argument("--limit", type=int, default=0, help="optional source limit for debugging")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    inventory = load_yaml(INVENTORY)
    provenance = provenance_by_source()
    source_entries = inventory.get("entries")
    if not isinstance(source_entries, list):
        raise ValueError("inventory entries must be a list")
    probes: list[dict[str, Any]] = []
    for entry in source_entries[: args.limit or None]:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            continue
        source_id = entry["id"]
        source_provenance = provenance.get(source_id, {})
        for item in source_urls(entry):
            probe = probe_url(item["url"], args.timeout_seconds)
            probes.append(
                {
                    "source_id": source_id,
                    "asset_kind": item["kind"],
                    "inventory_license_status": entry.get("license_status"),
                    "provenance_release_use": source_provenance.get("release_use"),
                    "release_use_allowed": False,
                    **probe,
                }
            )
    status_counts: dict[str, int] = {}
    for probe in probes:
        status = str(probe.get("status"))
        status_counts[status] = status_counts.get(status, 0) + 1
    report = {
        "schema": "eliza.ai_eda.external_source_probe.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "metadata_probe",
        "status": "PROBED_WITH_RELEASE_USE_BLOCKED",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_count": len(source_entries),
        "probe_count": len(probes),
        "status_counts": status_counts,
        "policy": {
            "imports_external_assets": False,
            "downloads_model_weights": False,
            "release_use_allowed": False,
            "license_metadata_is_advisory_until_manual_review": True,
        },
        "probes": probes,
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "source_probe_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.external_source_probe {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
