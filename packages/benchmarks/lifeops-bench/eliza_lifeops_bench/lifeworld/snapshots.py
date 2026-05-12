"""Predefined LifeWorld snapshots and CLI to (re)build them.

These are the canonical worlds the test corpus runs against:

- `tiny_seed_42` — minimum viable world (~50 entities) for unit tests.
- `medium_seed_2026` — realistic medium-busy life (~5000 entities) for
  the main scenario corpus.

`python -m eliza_lifeops_bench.lifeworld.snapshots --rebuild` regenerates
both and writes them to `<repo>/data/snapshots/`. State hashes are
recorded next to the JSON so CI can detect non-deterministic drift.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

from .generators import WorldGenerator
from .world import LifeWorld, WorldSnapshot

SNAPSHOTS_SUBDIR = ("data", "snapshots")


@dataclass(frozen=True)
class SnapshotSpec:
    name: str
    seed: int
    now_iso: str
    scale: str


SNAPSHOT_SPECS: list[SnapshotSpec] = [
    SnapshotSpec(
        name="tiny_seed_42",
        seed=42,
        now_iso="2026-05-10T12:00:00Z",
        scale="tiny",
    ),
    SnapshotSpec(
        name="medium_seed_2026",
        seed=2026,
        now_iso="2026-05-10T12:00:00Z",
        scale="medium",
    ),
]


def package_root() -> Path:
    """Return the lifeops-bench package root (`packages/benchmarks/lifeops-bench`).

    Resolved from this file's location: `…/eliza_lifeops_bench/lifeworld/snapshots.py`.
    """
    return Path(__file__).resolve().parents[2]


def snapshots_dir(repo_root: Path | None = None) -> Path:
    """Return the directory snapshots are written to.

    Defaults to the lifeops-bench package root. Pass `repo_root` to
    relocate (used by tests with tmp_path).
    """
    base = repo_root if repo_root is not None else package_root()
    out = base.joinpath(*SNAPSHOTS_SUBDIR)
    return out


def build_world_for(spec: SnapshotSpec) -> LifeWorld:
    gen = WorldGenerator(
        seed=spec.seed,
        now_iso=spec.now_iso,
        scale=spec.scale,  # type: ignore[arg-type]
    )
    return gen.generate_default_world()


def write_snapshot(spec: SnapshotSpec, target_dir: Path) -> tuple[Path, str]:
    target_dir.mkdir(parents=True, exist_ok=True)
    world = build_world_for(spec)
    payload = world.to_json()
    state_hash = world.state_hash()
    json_path = target_dir / f"{spec.name}.json"
    meta_path = target_dir / f"{spec.name}.meta.json"
    json_path.write_text(payload, encoding="utf-8")
    meta_path.write_text(
        json.dumps(
            {
                "name": spec.name,
                "seed": spec.seed,
                "now_iso": spec.now_iso,
                "scale": spec.scale,
                "state_hash": state_hash,
                "counts": world.counts(),
            },
            sort_keys=True,
            indent=2,
        ),
        encoding="utf-8",
    )
    return json_path, state_hash


def load_snapshot(name: str, repo_root: Path | None = None) -> WorldSnapshot:
    path = snapshots_dir(repo_root) / f"{name}.json"
    world = LifeWorld.from_json(path.read_text(encoding="utf-8"))
    return world.snapshot()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="lifeworld.snapshots")
    parser.add_argument(
        "--rebuild",
        action="store_true",
        help="Regenerate every predefined snapshot and write to disk.",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=None,
        help="Override output directory (default: <package>/data/snapshots).",
    )
    args = parser.parse_args(argv)

    target_dir = args.out_dir if args.out_dir is not None else snapshots_dir()

    if not args.rebuild:
        parser.print_help()
        return 0

    for spec in SNAPSHOT_SPECS:
        json_path, state_hash = write_snapshot(spec, target_dir)
        print(f"wrote {json_path}  state_hash={state_hash[:16]}...")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
