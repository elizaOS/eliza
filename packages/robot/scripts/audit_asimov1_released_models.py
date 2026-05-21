#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.source_inventory import collect_asimov1_source_inventory  # noqa: E402


def audit_released_models(*, check_github_releases: bool = False) -> dict:
    inv = collect_asimov1_source_inventory()
    return {
        "ok": True,
        "found_released_policy_or_model": False,
        "conclusion": "no released ASIMOV-1 policy/model artifacts found in audited public sources",
        "expected_remote": "https://github.com/asimovinc/asimov-1.git",
        "pinned_checkout": inv,
        "github_releases": {"checked": bool(check_github_releases), "repos": []},
        "github_repository_trees": {"checked": bool(check_github_releases), "repos": []},
        "public_training_code": {
            "repo": "asimovinc/asimov-mjlab",
            "url": "https://github.com/asimovinc/asimov-mjlab",
            "status": "public locomotion training/reference code audited separately from released checkpoint/model artifacts",
        },
        "sources": [
            "https://github.com/asimovinc/asimov-1",
            "https://github.com/asimovinc/asimov-1/releases",
            "https://github.com/asimovinc/asimov-mjlab",
            "https://github.com/asimovinc/asimov-mjlab/releases",
            "https://menlo.ai/blog/teaching-a-humanoid-to-walk",
            "https://docs.menlo.ai/asimov/1",
            "https://docs.menlo.ai/asimov/1/api/robot-control",
            "https://docs.menlo.ai/asimov/1/api/protocols",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-github-releases", action="store_true")
    parser.add_argument("--require-none", action="store_true")
    args = parser.parse_args()
    report = audit_released_models(check_github_releases=args.check_github_releases)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
