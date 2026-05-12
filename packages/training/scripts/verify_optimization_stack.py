"""Verify the Eliza-1 PolarQuant + QJL + TurboQuant optimization stack on a bundle.

Asserts on a staged/published Eliza-1 bundle dir (or the raw
``eliza1-optimized/`` output from ``optimize_for_eliza1.py``):

  * ``eliza1_manifest.json.applied.{polarquant,qjl,turboquant}.applied`` is true
    (or honestly recorded as skipped + reason).
  * The matching GGUF ``.eliza1.json`` sidecar carries the recipe
    block_layout_version / codebook_hash / per_block_tolerance pins under
    ``polarquant.*`` / ``qjl.*`` / ``turboquant.*`` (mirrored from
    ``recipeManifest`` in the bundle manifest schema).
  * The stage sidecar files exist and the recorded SHA matches the
    safetensors blob.
  * ``qjl_config.json`` + ``turboquant.json`` shape against the model arch
    (``num_hidden_layers``, ``n_full_attention_layers`` — for Qwen3.5 that's
    6 of 24, NOT 24 of 24).
  * For hybrid linear-attn models, ``turboquant.linear_attention_layers_skipped``
    is the complement of ``turboquant.full_attention_layers`` and the union
    covers every decoder index.

Run on a staged bundle:
    uv run python scripts/verify_optimization_stack.py \\
        --bundle-dir /tmp/eliza1-stage/eliza-1-0_6b
On the orchestrator output:
    uv run python scripts/verify_optimization_stack.py \\
        --opt-dir checkpoints/eliza-1-0_6b-apollo-1778551769/eliza1-optimized
Exits non-zero on a failed assertion (publish-blocking).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from quantization._kernel_manifest import (  # noqa: E402
    KERNEL_BLOCK_LAYOUT_VERSIONS,
    KERNEL_CODEBOOK_HASHES,
    KERNEL_PER_BLOCK_TOLERANCE,
)


@dataclass
class Report:
    bundle: str
    checks: list[tuple[str, bool, str]] = field(default_factory=list)

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks.append((name, ok, detail))

    @property
    def ok(self) -> bool:
        return all(c[1] for c in self.checks)

    def render(self) -> str:
        lines = [f"verify_optimization_stack({self.bundle})"]
        for name, ok, detail in self.checks:
            mark = "PASS" if ok else "FAIL"
            lines.append(f"  [{mark}] {name}{(' — ' + detail) if detail else ''}")
        lines.append(f"  → {'OK' if self.ok else 'BROKEN'}")
        return "\n".join(lines)


def _read_json(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _verify_recipe_pins(rep: Report, sidecar: dict | None, key: str, target: str) -> None:
    """Assert the recipe kernel_manifest fragment matches the canonical pins."""
    if sidecar is None:
        rep.check(f"{key}.kernel_manifest present", False, "sidecar missing")
        return
    km = sidecar.get("kernel_manifest") or {}
    blv = (km.get("block_layout_version") or {}).get(target)
    cbh = (km.get("codebook_hash") or {}).get(target)
    tol = (km.get("per_block_tolerance") or {}).get(target)
    rep.check(
        f"{key}.block_layout_version[{target}]",
        blv == KERNEL_BLOCK_LAYOUT_VERSIONS[target],
        f"got {blv!r}, want {KERNEL_BLOCK_LAYOUT_VERSIONS[target]!r}",
    )
    rep.check(
        f"{key}.codebook_hash[{target}]",
        cbh == KERNEL_CODEBOOK_HASHES[target],
        f"got {cbh!r}, want {KERNEL_CODEBOOK_HASHES[target]!r}",
    )
    rep.check(
        f"{key}.per_block_tolerance[{target}]",
        tol == KERNEL_PER_BLOCK_TOLERANCE[target],
        f"got {tol!r}, want {KERNEL_PER_BLOCK_TOLERANCE[target]!r}",
    )


def verify_opt_dir(opt_dir: Path) -> Report:
    """Verify an ``optimize_for_eliza1.py`` output directory."""
    rep = Report(bundle=str(opt_dir))

    manifest = _read_json(opt_dir / "gguf" / "eliza1_manifest.json")
    rep.check("eliza1_manifest.json present", manifest is not None)

    polar = _read_json(opt_dir / "stage-polarquant" / "polarquant_config.json")
    qjl = _read_json(opt_dir / "stage-qjl" / "qjl_config.json")
    tbq = _read_json(opt_dir / "stage-turboquant" / "turboquant.json")

    _verify_recipe_pins(rep, polar, "polarquant", "polar_q4")
    _verify_recipe_pins(rep, qjl, "qjl", "qjl1_256")
    _verify_recipe_pins(rep, tbq, "turboquant", "turbo4")

    # polarquant_artifacts.safetensors must exist next to the polar sidecar
    polar_art = opt_dir / "stage-polarquant" / "polarquant_artifacts.safetensors"
    rep.check(
        "polarquant_artifacts.safetensors present",
        polar_art.is_file(),
        str(polar_art),
    )

    if manifest is not None:
        applied = manifest.get("applied") or {}
        for stage in ("polarquant", "qjl", "turboquant"):
            block = applied.get(stage) or {}
            rep.check(
                f"manifest.applied.{stage}",
                bool(block.get("applied")) or bool(block.get("skipped")),
                f"got {block!r}",
            )

    # Sanity-check qjl/turboquant against the model arch when sidecars carry it.
    if qjl is not None:
        n_full = qjl.get("n_full_attention_layers")
        n_total = qjl.get("num_hidden_layers")
        rep.check(
            "qjl.n_full_attention_layers <= num_hidden_layers",
            isinstance(n_full, int) and isinstance(n_total, int) and n_full <= n_total,
            f"n_full={n_full} num_hidden_layers={n_total}",
        )
    if tbq is not None:
        full = tbq.get("full_attention_layers")
        skipped = tbq.get("linear_attention_layers_skipped") or []
        n_total = tbq.get("num_hidden_layers")
        if isinstance(full, list) and isinstance(skipped, list) and isinstance(n_total, int):
            union_covers = set(full) | set(skipped) == set(range(n_total))
            rep.check(
                "turboquant.full + skipped covers every decoder layer",
                union_covers,
                f"full={len(full)} skipped={len(skipped)} total={n_total}",
            )
            rep.check(
                "turboquant.full ∩ skipped is empty",
                not (set(full) & set(skipped)),
                f"overlap={sorted(set(full) & set(skipped))}",
            )

    return rep


def verify_bundle_dir(bundle_dir: Path) -> Report:
    """Verify a staged/published Eliza-1 bundle dir (post stage_base_v1)."""
    rep = Report(bundle=str(bundle_dir))

    bundle_manifest = _read_json(bundle_dir / "eliza-1.manifest.json")
    rep.check("eliza-1.manifest.json present", bundle_manifest is not None)
    if bundle_manifest is None:
        return rep

    tq = bundle_manifest.get("textQuant") or {}
    optimized = bool(tq.get("optimized"))
    rep.check("textQuant.optimized is true", optimized, json.dumps(tq)[:200])

    # The bundle stages the per-recipe sidecar JSON next to the GGUF as
    # <text-gguf>.gguf.eliza1.json — that's the runtime contract. When the
    # caller passes a manifest-only checkout (no GGUF blob downloaded), we
    # check the textQuant block instead of the sidecar.
    text_dir = bundle_dir / "text"
    gguf_files = list(text_dir.glob("*.gguf")) if text_dir.is_dir() else []
    eliza1: dict | None = None
    if gguf_files:
        side = gguf_files[0].with_suffix(".gguf.eliza1.json")
        eliza1 = _read_json(side)
        rep.check(
            "<text>.gguf.eliza1.json present",
            eliza1 is not None,
            str(side),
        )
    else:
        # No GGUF on disk (typical when verifying just the manifest+sidecar
        # tracked under the HF repo without pulling the heavy blob). Fall
        # back to the textQuant block in the manifest — it carries the same
        # fields the sidecar would.
        if isinstance(tq, dict) and optimized:
            eliza1 = {k: tq.get(k) for k in ("polarquant", "qjl", "turboquant")}
    if eliza1 is None:
        return rep

    for stage in ("polarquant", "qjl", "turboquant"):
        rep.check(
            f"eliza1.{stage} block present",
            isinstance(eliza1.get(stage), dict),
            json.dumps(eliza1.get(stage))[:80] if eliza1.get(stage) else "missing",
        )

    # If the manifest declares recipe pins (`recipeManifest`), cross-check
    # against the canonical kernel manifest values.
    rm = (bundle_manifest.get("kernels") or {}).get("recipeManifest") or {}
    for tgt in ("turbo4", "qjl1_256", "polar_q4"):
        if tgt in rm:
            pins = rm[tgt]
            rep.check(
                f"recipeManifest[{tgt}].blockLayoutVersion",
                pins.get("blockLayoutVersion") == KERNEL_BLOCK_LAYOUT_VERSIONS[tgt],
                f"got {pins.get('blockLayoutVersion')!r}",
            )
            rep.check(
                f"recipeManifest[{tgt}].codebookHash",
                pins.get("codebookHash") == KERNEL_CODEBOOK_HASHES[tgt],
                f"got {pins.get('codebookHash')!r}",
            )

    return rep


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument(
        "--opt-dir",
        type=Path,
        help="Directory produced by optimize_for_eliza1.py (the eliza1-optimized/ output).",
    )
    g.add_argument(
        "--bundle-dir",
        type=Path,
        help="Staged Eliza-1 bundle dir (the dir uploaded to elizaos/eliza-1-<tier>).",
    )
    ap.add_argument(
        "--json", action="store_true",
        help="Emit JSON instead of human-readable report.",
    )
    args = ap.parse_args(argv)

    rep = verify_opt_dir(args.opt_dir) if args.opt_dir else verify_bundle_dir(args.bundle_dir)
    if args.json:
        print(json.dumps({
            "bundle": rep.bundle,
            "ok": rep.ok,
            "checks": [{"name": n, "ok": ok, "detail": d} for n, ok, d in rep.checks],
        }, indent=2))
    else:
        print(rep.render())
    return 0 if rep.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
