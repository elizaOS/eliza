"""Emit a catalog.ts diff that points the on-device runtime at Eliza-1.

The repo's catalog of downloadable models lives at
``packages/app-core/src/services/local-inference/catalog.ts`` (and the
sibling UI-side mirror at ``packages/ui/src/services/local-inference/catalog.ts``).
After ``optimize_for_milady.py`` publishes a new variant we need to
register it in those catalogs so phones can find it via the existing
downloader.

This script does **not** edit catalog.ts in place. It emits a unified
diff (or a paste-ready TS block) that the W5-Catalog wave applies on
top of its purged baseline. Keeping the cleanup wave's purge and this
wave's additions in separate diffs avoids merge conflicts on a shared
file.

Usage::

    uv run python scripts/emit_milady_catalog.py \\
        --manifest checkpoints/eliza-1-0_6b/gguf/milady_manifest.json \\
        --catalog packages/app-core/src/services/local-inference/catalog.ts \\
        --output reports/training/catalog-eliza-1-0_6b.diff

    # Or just print the new entry block to stdout:
    uv run python scripts/emit_milady_catalog.py \\
        --manifest checkpoints/eliza-1-0_6b/gguf/milady_manifest.json \\
        --print-entry
"""

from __future__ import annotations

import argparse
import difflib
import json
import logging
import sys
from dataclasses import dataclass
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("emit_milady_catalog")


# Heuristic mapping from base model name → catalog metadata. New
# entries go here when adding a new optimization target.
KNOWN_BASE_MODELS = {
    "elizaos/eliza-1-0_6b": {
        "params": "0.6B",
        "context_length": 32768,
        "tokenizer_family": "eliza1",
        "category": "chat",
        "bucket": "small",
        "min_ram_gb": 2,
        "size_gb_estimate": 0.4,  # Q4_POLAR 0.6B ≈ 380-450 MB
    },
    "elizaos/eliza-1-1_7b": {
        "params": "1.7B",
        "context_length": 32768,
        "tokenizer_family": "eliza1",
        "category": "chat",
        "bucket": "small",
        "min_ram_gb": 4,
        "size_gb_estimate": 1.4,
    },
    "elizaos/eliza-1-9b": {
        "params": "9B",
        "context_length": 65536,
        "tokenizer_family": "eliza1",
        "category": "chat",
        "bucket": "mid",
        "min_ram_gb": 12,
        "size_gb_estimate": 5.5,
    },
    "elizaos/eliza-1-27b-256k": {
        "params": "27B",
        "context_length": 262144,
        "tokenizer_family": "eliza1",
        "category": "chat",
        "bucket": "large",
        "min_ram_gb": 96,
        "size_gb_estimate": 16.0,
    },
    "elizaos/eliza-1-27b": {
        "params": "27B",
        "context_length": 131072,
        "tokenizer_family": "eliza1",
        "category": "chat",
        "bucket": "large",
        "min_ram_gb": 32,
        "size_gb_estimate": 16.0,
    },
}


@dataclass(frozen=True)
class MiladyCatalogEntry:
    id: str
    display_name: str
    hf_repo: str
    gguf_file: str
    params: str
    quant: str
    size_gb: float
    min_ram_gb: int
    category: str
    bucket: str
    context_length: int
    tokenizer_family: str
    cache_type_k: str
    cache_type_v: str
    spec_type: str | None
    drafter_model_id: str | None
    blurb: str

    def to_ts_literal(self) -> str:
        """Render as a TypeScript object literal slot in MODEL_CATALOG."""
        runtime_block = (
            "    runtime: {\n"
            '      preferredBackend: "llama-server",\n'
            "      kvCache: {\n"
            f'        typeK: "{self.cache_type_k}",\n'
            f'        typeV: "{self.cache_type_v}",\n'
            '        requiresFork: "milady-llama-cpp",\n'
            "      },\n"
        )
        if self.spec_type:
            runtime_block += (
                "      optimizations: {\n"
                f'        requiresKernel: ["{self.spec_type}"],\n'
                "      },\n"
            )
        if self.drafter_model_id:
            runtime_block += (
                "      dflash: {\n"
                f'        drafterModelId: "{self.drafter_model_id}",\n'
                f'        specType: "{self.spec_type or "dflash"}",\n'
                "        contextSize: 4096,\n"
                "        draftContextSize: 256,\n"
                "        draftMin: 1,\n"
                "        draftMax: 16,\n"
                "        gpuLayers: 0,\n"
                "        draftGpuLayers: 0,\n"
                "      },\n"
            )
        runtime_block += "    },\n"

        return (
            "  {\n"
            f'    id: "{self.id}",\n'
            f'    displayName: "{self.display_name}",\n'
            f'    hfRepo: "{self.hf_repo}",\n'
            f'    ggufFile: "{self.gguf_file}",\n'
            f'    params: "{self.params}",\n'
            f'    quant: "{self.quant}",\n'
            f"    sizeGb: {self.size_gb},\n"
            f"    minRamGb: {self.min_ram_gb},\n"
            f'    category: "{self.category}",\n'
            f'    bucket: "{self.bucket}",\n'
            f"    contextLength: {self.context_length},\n"
            f'    tokenizerFamily: "{self.tokenizer_family}",\n'
            f"{runtime_block}"
            f'    blurb:\n      "{self.blurb}",\n'
            "  },\n"
        )


def _slug_from_repo(hf_repo: str) -> str:
    """Convert ``elizaos/eliza-1-1_7b`` to a catalog id.
    """
    last = hf_repo.split("/")[-1]
    return last.lower()


def build_catalog_entry(manifest: dict[str, object]) -> MiladyCatalogEntry:
    base_model = str(manifest.get("base_model", ""))
    base_meta = KNOWN_BASE_MODELS.get(base_model)
    if base_meta is None:
        raise SystemExit(
            f"manifest's base_model {base_model!r} is not in KNOWN_BASE_MODELS; "
            "add it to packages/training/scripts/emit_milady_catalog.py"
        )

    target_repo = str(manifest.get("target_repo") or "")
    if not target_repo:
        raise SystemExit("manifest is missing target_repo")

    gguf = manifest.get("gguf") or {}
    if not isinstance(gguf, dict):
        raise SystemExit("manifest.gguf must be an object")
    gguf_file = str(gguf.get("filename") or "")
    if not gguf_file:
        raise SystemExit("manifest.gguf.filename is required")

    runtime = manifest.get("runtime") or {}
    if not isinstance(runtime, dict):
        raise SystemExit("manifest.runtime must be an object")
    args_list = runtime.get("args") or []

    cache_type_k = "qjl1_256"
    cache_type_v = "tbq3_0"
    spec_type: str | None = "dflash"
    drafter_model_id: str | None = None
    if isinstance(args_list, list):
        for i, a in enumerate(args_list):
            if a == "--cache-type-k" and i + 1 < len(args_list):
                cache_type_k = str(args_list[i + 1])
            elif a == "--cache-type-v" and i + 1 < len(args_list):
                cache_type_v = str(args_list[i + 1])
            elif a == "--spec-type" and i + 1 < len(args_list):
                spec_type = str(args_list[i + 1])
            elif a == "--draft-model" and i + 1 < len(args_list):
                drafter_model_id = _slug_from_repo(
                    str(manifest.get("drafter_repo") or "")
                ) or None

    slug = _slug_from_repo(target_repo)
    return MiladyCatalogEntry(
        id=slug,
        display_name=slug,
        hf_repo=target_repo,
        gguf_file=gguf_file,
        params=str(base_meta["params"]),
        quant="Eliza-1 optimized local runtime",
        size_gb=float(base_meta["size_gb_estimate"]),
        min_ram_gb=int(base_meta["min_ram_gb"]),
        category=str(base_meta["category"]),
        bucket=str(base_meta["bucket"]),
        context_length=int(base_meta["context_length"]),
        tokenizer_family=str(base_meta["tokenizer_family"]),
        cache_type_k=cache_type_k,
        cache_type_v=cache_type_v,
        spec_type=spec_type,
        drafter_model_id=drafter_model_id,
        blurb=f"{slug} - Eliza-1 optimized local runtime bundle.",
    )


def emit_diff(catalog_path: Path, new_entry: MiladyCatalogEntry) -> str:
    """Build a unified diff that inserts ``new_entry`` at the end of MODEL_CATALOG."""
    if not catalog_path.exists():
        raise SystemExit(f"catalog file does not exist: {catalog_path}")
    original = catalog_path.read_text(encoding="utf-8")
    closing_marker = "];"
    if closing_marker not in original:
        raise SystemExit(
            f"catalog file {catalog_path} does not contain a `];` close marker; "
            "either point at a real MODEL_CATALOG file or refresh the marker."
        )
    insertion = new_entry.to_ts_literal()
    pre, _, post = original.rpartition(closing_marker)
    patched = pre.rstrip() + "\n" + insertion + closing_marker + post

    diff_lines = list(
        difflib.unified_diff(
            original.splitlines(keepends=True),
            patched.splitlines(keepends=True),
            fromfile=f"a/{catalog_path}",
            tofile=f"b/{catalog_path}",
            n=4,
        )
    )
    return "".join(diff_lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument(
        "--manifest",
        type=Path,
        required=True,
        help="Path to milady_manifest.json from optimize_for_milady.py.",
    )
    ap.add_argument(
        "--catalog",
        type=Path,
        default=None,
        help="Optional catalog.ts to compute a unified diff against.",
    )
    ap.add_argument(
        "--output",
        type=Path,
        default=None,
        help="If set with --catalog, write the diff here. Otherwise print to stdout.",
    )
    ap.add_argument(
        "--print-entry",
        action="store_true",
        help="Print the rendered TS object literal only (no diff). Useful for "
             "pasting into a custom MODEL_CATALOG.",
    )
    args = ap.parse_args(argv)

    if not args.manifest.exists():
        raise SystemExit(f"manifest does not exist: {args.manifest}")
    try:
        manifest = json.loads(args.manifest.read_text())
    except json.JSONDecodeError as exc:
        raise SystemExit(f"manifest is not valid JSON: {exc}") from exc

    entry = build_catalog_entry(manifest)

    if args.print_entry:
        print(entry.to_ts_literal())
        return 0

    if args.catalog is None:
        # No catalog → print the literal block + a note.
        print("// add to MODEL_CATALOG (or pipe through --catalog/--output for a diff):")
        print(entry.to_ts_literal())
        return 0

    diff = emit_diff(args.catalog, entry)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(diff, encoding="utf-8")
        log.info("wrote diff → %s (%d bytes)", args.output, len(diff))
    else:
        sys.stdout.write(diff)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
