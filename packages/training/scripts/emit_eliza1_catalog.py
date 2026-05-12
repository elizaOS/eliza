"""Emit a MODEL_CATALOG entry for a freshly-produced eliza-1-<tier> GGUF.

After ``optimize_for_eliza1.py`` produces a GGUF + ``eliza1_manifest.json``
the Eliza-1 runtime can only pick the model up once it has a catalog
entry. The canonical catalog (``MODEL_CATALOG``, ``ELIZA_1_TIER_IDS``,
``DEFAULT_ELIGIBLE_MODEL_IDS``, the HuggingFace URL builders) lives in:

    packages/shared/src/local-inference/catalog.ts

(``@elizaos/shared/local-inference/catalog``). The old
``packages/app-core/src/services/local-inference/catalog.ts`` path is now
just a re-export shim of that module, so anything written there is
ignored — the shim has no ``MODEL_CATALOG`` literal to patch.

This script does **not** edit ``catalog.ts`` in place. It prints a
clearly-labeled, paste-ready patch fragment and tells you exactly which
file to apply it to. Two modes:

  * ``--print-entry`` (default when no ``--catalog`` is given): emit just
    the TypeScript object literal to insert into the ``MODEL_CATALOG``
    array in ``packages/shared/src/local-inference/catalog.ts``, plus a
    header saying where it goes.
  * ``--catalog <path>``: in addition, compute a unified diff that
    inserts the new entry at the end of that file's ``MODEL_CATALOG``
    array. ``--catalog`` defaults to the canonical shared catalog path;
    pass it explicitly if you keep a fork-local catalog elsewhere.

Usage::

    # Print the entry + where to put it (recommended):
    uv run python scripts/emit_eliza1_catalog.py \\
        --manifest checkpoints/eliza-1-0_8b/gguf/eliza1_manifest.json

    # Also produce a unified diff against the canonical shared catalog:
    uv run python scripts/emit_eliza1_catalog.py \\
        --manifest checkpoints/eliza-1-0_8b/gguf/eliza1_manifest.json \\
        --catalog packages/shared/src/local-inference/catalog.ts \\
        --output reports/training/catalog-eliza-1-0_8b.diff

Notes:
  * Eliza-1 tiers are *default-eligible* models. The tier ids and the
    default-eligible set are defined in the same ``catalog.ts``
    (``ELIZA_1_TIER_IDS`` / ``DEFAULT_ELIGIBLE_MODEL_IDS``). If you are
    introducing a brand-new tier id (not just refreshing the
    ``ggufFile`` / ``hfRepo`` of an existing one), you must also add it
    to ``ELIZA_1_TIER_IDS`` by hand — this script only emits the
    ``MODEL_CATALOG`` row.
  * For a *local* file (not yet pushed to HuggingFace) you do not need a
    catalog entry at all — see
    ``packages/training/docs/training/gguf-to-runtime.md`` for the
    state-dir / external-scan path. This script is for the
    "published to ``elizaos/eliza-1-<tier>`` and want it in the curated
    catalog" case.
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
log = logging.getLogger("emit_eliza1_catalog")


# The canonical catalog this script targets. Both the server
# (``@elizaos/app-core``) and the UI client (``@elizaos/ui``) import
# ``MODEL_CATALOG`` from here; the old app-core path is a re-export shim.
CANONICAL_CATALOG_PATH = "packages/shared/src/local-inference/catalog.ts"


# Heuristic mapping from base model name → catalog metadata. New
# entries go here when adding a new optimization target.
KNOWN_BASE_MODELS = {
    "elizaos/eliza-1-0_8b": {
        "params": "0.8B",
        "context_length": 32768,
        "tokenizer_family": "eliza1",
        "category": "chat",
        "bucket": "small",
        "min_ram_gb": 2,
        "size_gb_estimate": 0.4,  # Q4_POLAR 0.8B ≈ 380-450 MB
    },
    "elizaos/eliza-1-2b": {
        "params": "2B",
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
class Eliza1CatalogEntry:
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
            '        requiresFork: "buun-llama-cpp",\n'
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
    """Convert ``elizaos/eliza-1-2b`` to a catalog id."""
    last = hf_repo.split("/")[-1]
    return last.lower()


def build_catalog_entry(manifest: dict[str, object]) -> Eliza1CatalogEntry:
    base_model = str(manifest.get("base_model", ""))
    base_meta = KNOWN_BASE_MODELS.get(base_model)
    if base_meta is None:
        raise SystemExit(
            f"manifest's base_model {base_model!r} is not in KNOWN_BASE_MODELS; "
            "add it to packages/training/scripts/emit_eliza1_catalog.py"
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
    return Eliza1CatalogEntry(
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


def _find_model_catalog_close(text: str) -> int:
    """Return the index of the ``];`` that closes ``MODEL_CATALOG``.

    The file has multiple ``];`` markers (``ELIZA_1_TIER_IDS`` etc.), so
    we anchor on the ``export const MODEL_CATALOG`` declaration and find
    the first ``];`` after it.
    """
    anchor = text.find("MODEL_CATALOG")
    if anchor == -1:
        raise SystemExit(
            "catalog file has no `MODEL_CATALOG` declaration; pass --catalog "
            f"pointing at {CANONICAL_CATALOG_PATH} (not the app-core re-export shim)."
        )
    close = text.find("];", anchor)
    if close == -1:
        raise SystemExit(
            "catalog file has `MODEL_CATALOG` but no `];` close marker after it; "
            "either point at a real catalog file or refresh the marker."
        )
    return close


def emit_diff(catalog_path: Path, new_entry: Eliza1CatalogEntry) -> str:
    """Build a unified diff that inserts ``new_entry`` at the end of MODEL_CATALOG."""
    if not catalog_path.exists():
        raise SystemExit(f"catalog file does not exist: {catalog_path}")
    original = catalog_path.read_text(encoding="utf-8")
    close = _find_model_catalog_close(original)
    insertion = new_entry.to_ts_literal()
    pre = original[:close]
    post = original[close:]
    patched = pre.rstrip() + "\n" + insertion + post

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


def _entry_with_header(entry: Eliza1CatalogEntry, catalog_hint: str) -> str:
    return (
        f"// Add this entry to the `MODEL_CATALOG` array in:\n"
        f"//   {catalog_hint}\n"
        f"// (the @elizaos/app-core copy is a re-export shim — do not edit it).\n"
        f"// If `{entry.id}` is a NEW tier id, also add it to ELIZA_1_TIER_IDS\n"
        f"// in the same file (that is what marks it default-eligible).\n"
        f"{entry.to_ts_literal()}"
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__.split("\n\n", 1)[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "--manifest",
        type=Path,
        required=True,
        help="Path to eliza1_manifest.json from optimize_for_eliza1.py.",
    )
    ap.add_argument(
        "--catalog",
        type=Path,
        default=Path(CANONICAL_CATALOG_PATH),
        help=(
            "Catalog .ts file to compute a unified diff against. Defaults to "
            f"{CANONICAL_CATALOG_PATH} (the canonical @elizaos/shared catalog). "
            "Pass --print-entry to skip the diff and only emit the entry block."
        ),
    )
    ap.add_argument(
        "--output",
        type=Path,
        default=None,
        help="If set, write the unified diff here. Otherwise print it to stdout.",
    )
    ap.add_argument(
        "--print-entry",
        action="store_true",
        help="Print only the rendered TS object literal + a header saying where "
             "it goes; do not read or diff any catalog file.",
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
        print(_entry_with_header(entry, CANONICAL_CATALOG_PATH))
        return 0

    if not args.catalog.exists():
        log.warning(
            "catalog file %s not found; emitting the entry block instead of a diff",
            args.catalog,
        )
        print(_entry_with_header(entry, CANONICAL_CATALOG_PATH))
        return 0

    diff = emit_diff(args.catalog, entry)
    header = (
        f"# MODEL_CATALOG patch for {entry.id}\n"
        f"# Apply to: {args.catalog}\n"
        f"# (the @elizaos/app-core copy is a re-export shim — do not edit it).\n"
        f"# If {entry.id} is a NEW tier id, also add it to ELIZA_1_TIER_IDS in that file.\n"
    )
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(header + diff, encoding="utf-8")
        log.info("wrote patch → %s (%d bytes)", args.output, len(header) + len(diff))
        log.info("apply with: git apply %s   (after stripping the leading # header)", args.output)
    else:
        sys.stdout.write(header)
        sys.stdout.write(diff)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
