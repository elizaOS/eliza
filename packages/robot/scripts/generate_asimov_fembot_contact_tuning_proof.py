#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_contact_tuning import (  # noqa: E402
    DEFAULT_COLLIDER_LENGTH_SCALE_CANDIDATES,
    DEFAULT_COLLIDER_SCALE_CANDIDATES,
    DEFAULT_COLLIDER_SEGMENT_CANDIDATES,
    DEFAULT_LINK_SPECIFIC_FIT_BASE_LENGTH_SCALE_CANDIDATES,
    DEFAULT_RECONSTRUCTION_TARGET_LENGTH_SCALE_CANDIDATES,
    DEFAULT_STRUCTURAL_TARGET_LENGTH_SCALE_CANDIDATES,
    build_fembot_contact_tuning_proof,
    dump_fembot_contact_tuning_proof_json,
    write_fembot_contact_tuning_proof,
)
from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS  # noqa: E402
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def _parse_scales(raw: str) -> tuple[float, ...]:
    return tuple(float(part) for part in raw.split(",") if part.strip())


def _parse_segments(raw: str) -> tuple[tuple[int, float], ...]:
    pairs: list[tuple[int, float]] = []
    for part in raw.split(","):
        if not part.strip():
            continue
        count, scale = part.split(":", 1)
        pairs.append((int(count), float(scale)))
    return tuple(pairs)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sweep generated fembot body-capsule scales and measure MuJoCo contacts."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-contact-tuning.json",
    )
    parser.add_argument(
        "--scales",
        type=_parse_scales,
        default=DEFAULT_COLLIDER_SCALE_CANDIDATES,
        help="comma-separated body-capsule radius scales to test",
    )
    parser.add_argument(
        "--length-scales",
        type=_parse_scales,
        default=DEFAULT_COLLIDER_LENGTH_SCALE_CANDIDATES,
        help="comma-separated body-capsule centerline length scales to test",
    )
    parser.add_argument(
        "--segments",
        type=_parse_segments,
        default=DEFAULT_COLLIDER_SEGMENT_CANDIDATES,
        help="comma-separated segment_count:segment_length_scale candidates to test",
    )
    parser.add_argument(
        "--structural-target-length-scales",
        type=_parse_scales,
        default=DEFAULT_STRUCTURAL_TARGET_LENGTH_SCALE_CANDIDATES,
        help="comma-separated centerline length scales to test only on structurally remediated links",
    )
    parser.add_argument(
        "--reconstruction-target-length-scales",
        type=_parse_scales,
        default=DEFAULT_RECONSTRUCTION_TARGET_LENGTH_SCALE_CANDIDATES,
        help="comma-separated centerline length scales to test on structural plus residual reconstruction links",
    )
    parser.add_argument(
        "--link-specific-fit-base-length-scales",
        type=_parse_scales,
        default=DEFAULT_LINK_SPECIFIC_FIT_BASE_LENGTH_SCALE_CANDIDATES,
        help="comma-separated structural base length scales before residual link-specific capsule fitting",
    )
    parser.add_argument(
        "--require-accepted",
        action="store_true",
        help="fail until one generated fembot collider scale clears unapproved contacts",
    )
    args = parser.parse_args()

    body_groups = [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]
    report = build_fembot_contact_tuning_proof(
        body_groups,
        scale_candidates=args.scales,
        length_scale_candidates=args.length_scales,
        structural_target_length_scale_candidates=args.structural_target_length_scales,
        reconstruction_target_length_scale_candidates=args.reconstruction_target_length_scales,
        link_specific_fit_base_length_scale_candidates=args.link_specific_fit_base_length_scales,
        segment_candidates=args.segments,
    )
    write_fembot_contact_tuning_proof(report, args.output)
    print(dump_fembot_contact_tuning_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
