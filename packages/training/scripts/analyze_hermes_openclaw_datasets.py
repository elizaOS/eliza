#!/usr/bin/env python3
"""Inventory Hermes and OpenClaw datasets on HuggingFace vs. datasets.yaml.

Lists all known Hermes/OpenClaw datasets, shows which are in datasets.yaml,
checks whether converted files exist locally, and optionally probes HuggingFace
for basic metadata.

Usage:
    python analyze_hermes_openclaw_datasets.py [--check-hf] [--datasets-yaml PATH]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Optional imports (graceful degradation)
try:
    import yaml as _yaml  # type: ignore
    _HAS_YAML = True
except ImportError:
    _HAS_YAML = False


ROOT = Path(__file__).resolve().parent.parent

# ──────────────────────────────────────────────────────────────
# Hardcoded known datasets to inventory
# ──────────────────────────────────────────────────────────────

KNOWN_DATASETS: list[dict] = [
    {
        "repo_id": "NousResearch/hermes-function-calling-v1",
        "family": "hermes",
        "normalizer": "hermes_fc",
        "est_records": 11_000,
        "license": "apache-2.0",
        "notes": "Original Hermes FC v1; ~11k tool-call examples",
    },
    {
        "repo_id": "Jofthomas/hermes-function-calling-thinking-V1",
        "family": "hermes",
        "normalizer": "hermes_fc_thinking",
        "est_records": 15_000,
        "license": "apache-2.0",
        "notes": "FC v1 with thinking traces",
    },
    {
        "repo_id": "NousResearch/Hermes-3-Dataset",
        "family": "hermes",
        "normalizer": "hermes_3",
        "est_records": 200_000,
        "license": "apache-2.0",
        "notes": "Hermes 3 full dataset; diverse instruction tuning",
    },
    {
        "repo_id": "teknium/OpenHermes-2.5",
        "family": "hermes",
        "normalizer": "openhermes",
        "est_records": 1_000_000,
        "license": "apache-2.0",
        "notes": "OpenHermes 2.5; large general SFT corpus",
    },
    {
        "repo_id": "interstellarninja/hermes_reasoning_tool_use",
        "family": "hermes",
        "normalizer": "hermes_reasoning_tool_use",
        "est_records": 50_000,
        "license": "apache-2.0",
        "notes": "Reasoning + tool-use traces",
    },
    {
        "repo_id": "lambda/hermes-agent-reasoning-traces",
        "family": "hermes",
        "normalizer": "hermes_traces",
        "est_records": 30_000,
        "license": "unknown",
        "notes": "Agent reasoning traces in Hermes format",
    },
    {
        "repo_id": "ning423/Hermes-OmniForge-Qwen36-27B-full-v0.3.0-unsloth",
        "family": "hermes",
        "normalizer": "hermes_omniforge",
        "est_records": 80_000,
        "license": "unknown",
        "notes": "OmniForge gemma-4-31B generated; diverse tool-calling",
    },
    {
        "repo_id": "CyberAGI/openclaw-operator-data",
        "family": "openclaw",
        "normalizer": "openclaw",
        "est_records": 20_000,
        "license": "unknown",
        "notes": "OpenClaw operator dataset; agent task execution",
    },
    {
        "repo_id": "NousResearch/Hermes-Function-Calling-V2",
        "family": "hermes",
        "normalizer": "hermes_fc_v2",
        "est_records": 25_000,
        "license": "apache-2.0",
        "notes": "Updated FC dataset with improved examples",
    },
]


# ──────────────────────────────────────────────────────────────
# datasets.yaml loader
# ──────────────────────────────────────────────────────────────

def load_datasets_yaml(path: Path) -> dict[str, dict]:
    """Return dict keyed by repo_id for quick lookup. Skips entries without repo_id."""
    if not path.exists():
        return {}
    if not _HAS_YAML:
        # Fallback: scan for repo_id lines with a simple heuristic.
        entries: dict[str, dict] = {}
        current: dict = {}
        with path.open(encoding="utf-8") as f:
            for line in f:
                line = line.rstrip()
                if line.strip().startswith("- slug:"):
                    current = {"slug": line.split(":", 1)[1].strip()}
                elif "repo_id:" in line and current:
                    current["repo_id"] = line.split(":", 1)[1].strip()
                elif "normalizer:" in line and current:
                    current["normalizer"] = line.split(":", 1)[1].strip()
                elif "license:" in line and current:
                    current["license"] = line.split(":", 1)[1].strip()
                    if "repo_id" in current:
                        entries[current["repo_id"]] = dict(current)
        return entries

    with path.open(encoding="utf-8") as f:
        data = _yaml.safe_load(f) or {}
    entries: dict[str, dict] = {}
    for ds in data.get("datasets") or []:
        if isinstance(ds, dict) and ds.get("repo_id"):
            entries[ds["repo_id"]] = ds
    return entries


# ──────────────────────────────────────────────────────────────
# Converted file detection
# ──────────────────────────────────────────────────────────────

def _slug_candidates(repo_id: str, yaml_entry: dict | None) -> list[str]:
    """Guess likely file stems for a repo_id."""
    candidates = []
    if yaml_entry and yaml_entry.get("slug"):
        candidates.append(yaml_entry["slug"])
    # Derive from repo_id: org/Name → name lowercased with - separator
    name = repo_id.split("/")[-1].lower().replace("_", "-").replace(".", "-")
    candidates.append(name)
    # Some normalizers produce a shorter slug
    short = name[:20]
    if short not in candidates:
        candidates.append(short)
    return candidates


def find_converted_file(repo_id: str, yaml_entry: dict | None, data_root: Path) -> str:
    """Return path string if a converted file exists, else empty string."""
    for stem in _slug_candidates(repo_id, yaml_entry):
        for subdir in ("normalized", "converted", "candidates", "native"):
            for ext in (".jsonl", ".jsonl.gz"):
                candidate = data_root / subdir / f"{stem}{ext}"
                if candidate.exists():
                    return str(candidate)
    return ""


# ──────────────────────────────────────────────────────────────
# Optional HuggingFace probe
# ──────────────────────────────────────────────────────────────

def probe_hf(repo_id: str) -> dict:
    """Return basic HF metadata dict, or error info. Requires requests."""
    try:
        import urllib.request
        import urllib.error
        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
        url = f"https://huggingface.co/api/datasets/{repo_id}"
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read())
        return {
            "exists": True,
            "downloads": data.get("downloads", "?"),
            "likes": data.get("likes", "?"),
            "private": data.get("private", False),
        }
    except Exception as exc:
        return {"exists": False, "error": str(exc)[:80]}


# ──────────────────────────────────────────────────────────────
# Markdown table output
# ──────────────────────────────────────────────────────────────

def _trunc(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


def print_markdown_table(rows: list[dict], check_hf: bool) -> None:
    hf_col = " HF-status |" if check_hf else ""
    print(f"| Family | Repo ID | Normalizer | Est. Records | License | In datasets.yaml | Converted file |{hf_col}")
    print(f"|--------|---------|------------|:------------:|---------|:----------------:|----------------|{'------|' if check_hf else ''}")
    for r in rows:
        hf_cell = ""
        if check_hf:
            hf = r.get("hf") or {}
            if hf.get("exists"):
                hf_cell = f" ✓ ({hf.get('downloads','?')} dl) |"
            else:
                hf_cell = f" ✗ {hf.get('error','unknown')[:30]} |"
        in_yaml = "yes" if r["in_yaml"] else "**no**"
        conv = f"`{Path(r['converted_file']).name}`" if r["converted_file"] else "-"
        print(
            f"| {r['family']} "
            f"| `{_trunc(r['repo_id'], 55)}` "
            f"| `{r['normalizer']}` "
            f"| {r['est_records']:,} "
            f"| {r['license']} "
            f"| {in_yaml} "
            f"| {conv} "
            f"|{hf_cell}"
        )
    print()


def print_summary(rows: list[dict]) -> None:
    in_yaml = [r for r in rows if r["in_yaml"]]
    not_in_yaml = [r for r in rows if not r["in_yaml"]]
    converted = [r for r in rows if r["converted_file"]]
    print(f"Total known datasets: {len(rows)}")
    print(f"  In datasets.yaml:  {len(in_yaml)}")
    print(f"  Not yet added:     {len(not_in_yaml)}")
    print(f"  Converted locally: {len(converted)}")
    if not_in_yaml:
        print()
        print("New datasets to consider adding to datasets.yaml:")
        for r in not_in_yaml:
            print(f"  {r['repo_id']}  ({r['family']}, ~{r['est_records']:,} records)")
    print()


# ──────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check-hf", action="store_true",
                    help="probe HuggingFace API for each repo (requires internet)")
    ap.add_argument("--datasets-yaml", type=Path,
                    default=ROOT / "datasets.yaml",
                    help="path to datasets.yaml (default: packages/training/datasets.yaml)")
    ap.add_argument("--data-dir", type=Path,
                    default=ROOT / "data",
                    help="root data directory to search for converted files")
    args = ap.parse_args()

    yaml_entries = load_datasets_yaml(args.datasets_yaml)
    if not yaml_entries and args.datasets_yaml.exists():
        print(
            f"warning: could not parse {args.datasets_yaml} "
            f"({'install pyyaml for full parse' if not _HAS_YAML else 'empty/malformed'})",
            file=sys.stderr,
        )

    rows: list[dict] = []
    for ds in KNOWN_DATASETS:
        repo_id = ds["repo_id"]
        yaml_entry = yaml_entries.get(repo_id)
        converted = find_converted_file(repo_id, yaml_entry, args.data_dir)
        row: dict = {
            "repo_id": repo_id,
            "family": ds["family"],
            "normalizer": yaml_entry.get("normalizer") if yaml_entry else ds["normalizer"],
            "est_records": ds["est_records"],
            "license": yaml_entry.get("license") if yaml_entry else ds["license"],
            "notes": ds["notes"],
            "in_yaml": bool(yaml_entry),
            "yaml_slug": yaml_entry.get("slug", "") if yaml_entry else "",
            "converted_file": converted,
        }
        if args.check_hf:
            row["hf"] = probe_hf(repo_id)
        rows.append(row)

    print_markdown_table(rows, check_hf=args.check_hf)
    print_summary(rows)

    return 0


if __name__ == "__main__":
    sys.exit(main())
