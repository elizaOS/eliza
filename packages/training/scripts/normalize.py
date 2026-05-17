"""Normalize every downloaded dataset into the DEPRECATED flat ElizaRecord
intermediate.

This emits the legacy flat `ElizaRecord` shape (see
`scripts/lib/eliza_record.py`), NOT the canonical Eliza-1 corpus record. The
canonical corpus record is `eliza_native_v1`; see
`packages/training/docs/dataset/CANONICAL_RECORD.md`. This path is kept only so
the existing bulk corpus keeps loading — new corpus data should be authored as
`eliza_native_v1` rows.

Reads `datasets.yaml`, walks `data/raw/<slug>/`, dispatches to the named
adapter in `lib/adapters.REGISTRY`, and writes
`data/normalized/<slug>.jsonl` (+ `<slug>.errors.jsonl` for dropped rows).
Outputs use JSON expectedResponse payloads for native tool calling.

Source files are auto-discovered:
  - `*.parquet` (loaded via pyarrow)
  - `*.jsonl`, `*.json` (one record per line, or one JSON list per file)

Filtering rules:
  - For scambench, prefer `formats/eliza-*.jsonl` — that's the canonical
    config. Skip the parquet `data/*.parquet` because it's a flat shape.
  - For other datasets we use parquet+jsonl indiscriminately.

Usage:
    uv run python scripts/normalize.py
    uv run python scripts/normalize.py --only scambench,claude-distills
    uv run python scripts/normalize.py --max-records 1000   # smoke test
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any, Iterator

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.adapters import REGISTRY  # noqa: E402
from lib.expected_response import ExpectedResponseEncoder, make_expected_response_encoder  # noqa: E402

RAW_DIR = ROOT / "data" / "raw"
OUT_DIR = ROOT / "data" / "normalized"
REGISTRY_FILE = ROOT / "datasets.yaml"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("normalize")


def split_from_filename(path: Path) -> str:
    haystack = "/".join(p.lower() for p in path.parts)
    if "held-out" in haystack or "held_out" in haystack or "heldout" in haystack:
        return "test"
    name = path.name.lower()
    for s in ("train", "test", "validation", "val", "dev"):
        if s in name:
            return "train" if s in ("train",) else ("validation" if s in ("val", "validation", "dev") else "test")
    return "train"


def iter_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    with path.open("r", encoding="utf-8", errors="replace") as f:
        first = f.readline()
        if not first:
            return
        first_strip = first.lstrip()
        # Whole-file JSON list  (e.g. dataset.json shipped as one array)
        if first_strip.startswith("["):
            f.seek(0)
            try:
                data = json.load(f)
            except json.JSONDecodeError as e:
                log.warning("could not parse %s as JSON list: %s", path, e)
                return
            if isinstance(data, list):
                yield from (r for r in data if isinstance(r, dict))
            return
        # Whole-file JSON object — common for MCP-Flow per-tool specs.
        # We yield it as a single record.
        if first_strip.startswith("{") and path.suffix == ".json":
            f.seek(0)
            try:
                data = json.load(f)
            except json.JSONDecodeError:
                # fall through to JSONL handling
                pass
            else:
                if isinstance(data, dict):
                    yield data
                    return
                if isinstance(data, list):
                    yield from (r for r in data if isinstance(r, dict))
                    return
        # JSONL
        try:
            yield json.loads(first)
        except json.JSONDecodeError:
            pass
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def iter_parquet(path: Path) -> Iterator[dict[str, Any]]:
    """Stream a parquet file row-batch by row-batch — never load the whole
    table. Some sources ship multi-GB shards (toucan, glm-51) and the
    `pq.read_table` path OOMs."""
    import pyarrow.parquet as pq
    pf = pq.ParquetFile(path)
    for batch in pf.iter_batches(batch_size=2048):
        for row in batch.to_pylist():
            yield row


def discover_files(slug: str, raw_dir: Path) -> list[Path]:
    if slug == "scambench":
        files = sorted((raw_dir / "formats").glob("eliza-*.jsonl"))
        if files:
            return files
    if slug == "playwright-mcp-toolcalling":
        # The playwright corpus ships the same trajectories under several
        # filenames (`dataset.parquet` ≡ `data_with_llm_grades.parquet`,
        # `train_v3.parquet` ≡ `train_v3.jsonl`, plus older versioned
        # train files). Pin to the canonical splits and the latest train
        # to avoid emitting near-identical training records.
        canonical = ["train_v4.jsonl", "train.parquet", "test.parquet",
                     "eval.parquet", "val.parquet"]
        picks = [raw_dir / "data" / n for n in canonical]
        return [p for p in picks if p.exists()]
    files = []
    files.extend(sorted(raw_dir.rglob("*.jsonl")))
    files.extend(sorted(raw_dir.rglob("*.parquet")))
    files.extend(sorted(raw_dir.rglob("*.json")))
    return [
        p for p in files
        if not any(part in {"node_modules"} for part in p.parts)
        and p.suffix in {".jsonl", ".parquet", ".json"}
        and p.name not in {"dataset_info.json", "dataset_infos.json"}
    ]


def load_records(path: Path) -> Iterator[dict[str, Any]]:
    if path.suffix == ".parquet":
        yield from iter_parquet(path)
    else:
        yield from iter_jsonl(path)


def _tag_source(records: Iterator[dict[str, Any]], filename: str) -> Iterator[dict[str, Any]]:
    """Inject the source filename so file-aware adapters can pick task_type."""
    for r in records:
        if isinstance(r, dict):
            r.setdefault("_source_filename", filename)
        yield r


def normalize_dataset(
    entry: dict, *, max_records: int | None, encoder: ExpectedResponseEncoder,
) -> tuple[int, int, int]:
    slug = entry["slug"]
    license = entry.get("license", "unknown")
    adapter_name = entry["normalizer"]
    adapter = REGISTRY.get(adapter_name)
    if not adapter:
        log.error("no adapter registered for %s (slug=%s)", adapter_name, slug)
        return (0, 0, 1)

    raw_dir = RAW_DIR / slug
    if not raw_dir.exists() or not (raw_dir / ".done").exists():
        log.warning("skip %s — not downloaded yet", slug)
        return (0, 0, 0)

    files = discover_files(slug, raw_dir)
    if not files:
        log.warning("no source files found in %s", raw_dir)
        return (0, 0, 0)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"{slug}.jsonl"
    err_path = OUT_DIR / f"{slug}.errors.jsonl"

    n_in = n_out = n_err = 0
    with out_path.open("w", encoding="utf-8") as out, \
         err_path.open("w", encoding="utf-8") as err:
        for f in files:
            split = split_from_filename(f)
            log.info("  %s [%s] %s", slug, split, f.name)
            records = _tag_source(load_records(f), f.name)
            try:
                for ezr in adapter(
                    records, slug=slug, license=license, split=split, encoder=encoder
                ):
                    n_in += 1
                    ok, why = ezr.is_valid()
                    if not ok:
                        n_err += 1
                        err.write(json.dumps({"reason": why, "record": ezr.to_dict()}) + "\n")
                        continue
                    out.write(ezr.to_jsonl() + "\n")
                    n_out += 1
                    if max_records and n_out >= max_records:
                        break
            except Exception as e:  # noqa: BLE001
                log.exception("adapter %s crashed on %s: %s", adapter_name, f, e)
                n_err += 1
            if max_records and n_out >= max_records:
                break

    log.info("  %s: %d in, %d out, %d errors → %s", slug, n_in, n_out, n_err, out_path.name)
    return (n_in, n_out, n_err)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry", type=Path, default=REGISTRY_FILE)
    ap.add_argument("--only", type=str, default="")
    ap.add_argument("--skip", type=str, default="")
    ap.add_argument("--max-records", type=int, default=None,
                    help="cap output records per dataset (smoke testing)")
    ap.add_argument("--sample-per-source", type=int, default=0,
                    help="when >0, limit each source to ~N output records "
                         "(head sample). Alias of --max-records used by "
                         "run_pipeline.py --from-scratch; the smaller of the "
                         "two wins when both are given.")
    ap.add_argument(
        "--expected-response-format",
        choices=("json",),
        default="json",
        help="supervised target encoding for generated ElizaRecord rows",
    )
    args = ap.parse_args()

    with args.registry.open() as f:
        registry = yaml.safe_load(f)

    only = {s.strip() for s in args.only.split(",") if s.strip()}
    skip = {s.strip() for s in args.skip.split(",") if s.strip()}

    entries = []
    for e in registry.get("datasets") or []:
        if only and e["slug"] not in only:
            continue
        if e["slug"] in skip:
            continue
        entries.append(e)

    if not entries:
        log.warning("nothing to normalize")
        return 0

    caps = [c for c in (args.max_records, args.sample_per_source) if c and c > 0]
    effective_cap = min(caps) if caps else None
    if args.sample_per_source:
        log.info("sampling ≤%d records per source (smoke mode)", effective_cap)

    encoder = make_expected_response_encoder(args.expected_response_format)
    try:
        manifest = []
        total_in = total_out = total_err = 0
        for entry in entries:
            log.info("normalizing %s (%s)", entry["slug"], entry["normalizer"])
            n_in, n_out, n_err = normalize_dataset(
                entry, max_records=effective_cap, encoder=encoder,
            )
            manifest.append({
                "slug": entry["slug"],
                "in": n_in, "out": n_out, "errors": n_err,
                "license": entry.get("license", "unknown"),
                "weight": float(entry.get("weight", 1.0)),
            })
            total_in += n_in
            total_out += n_out
            total_err += n_err

        OUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUT_DIR / "manifest.json").write_text(
            json.dumps({
                "totals": {"in": total_in, "out": total_out, "errors": total_err},
                "datasets": manifest,
            }, indent=2),
            encoding="utf-8",
        )
        log.info("normalize summary: %d in, %d out, %d errors", total_in, total_out, total_err)
    finally:
        encoder.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
