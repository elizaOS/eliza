#!/usr/bin/env python3
"""Fold passing backend evidence into one Eliza-1 HF bundle manifest.

This is intentionally narrow. It updates ``kernels.verifiedBackends[backend]``
only when the corresponding uploaded evidence files already report a real pass.
It never changes eval gate results, weights, or release-state fields.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

try:
    from scripts.manifest.eliza1_manifest import ELIZA_1_HF_REPO, ELIZA_1_TIERS, SUPPORTED_BACKENDS_BY_TIER
except ImportError:  # pragma: no cover
    from eliza1_manifest import ELIZA_1_HF_REPO, ELIZA_1_TIERS, SUPPORTED_BACKENDS_BY_TIER  # type: ignore


def _download_json(api: Any, repo_id: str, path: str) -> dict[str, Any]:
    local = api.hf_hub_download(repo_id=repo_id, filename=path, repo_type="model")
    return json.loads(Path(local).read_text(encoding="utf-8"))


def _evidence_paths(tier: str, backend: str) -> tuple[str, str]:
    verify = "cpu_reference.json" if backend == "cpu" else f"{backend}_verify.json"
    return (f"bundles/{tier}/evals/{verify}", f"bundles/{tier}/evals/{backend}_dispatch.json")


def plan_fold(api: Any, repo_id: str, tier: str, backend: str) -> dict[str, Any]:
    if backend not in SUPPORTED_BACKENDS_BY_TIER[tier]:
        raise SystemExit(f"{backend} is not supported by tier {tier}")
    verify_path, dispatch_path = _evidence_paths(tier, backend)
    verify = _download_json(api, repo_id, verify_path)
    dispatch = _download_json(api, repo_id, dispatch_path)
    blockers: list[str] = []
    if verify.get("status") != "pass":
        blockers.append(f"{verify_path} status={verify.get('status')!r}")
    if dispatch.get("status") != "pass":
        blockers.append(f"{dispatch_path} status={dispatch.get('status')!r}")
    if dispatch.get("runtimeReady") is not True:
        blockers.append(f"{dispatch_path} runtimeReady={dispatch.get('runtimeReady')!r}")
    if blockers:
        raise SystemExit("refusing to fold backend evidence: " + "; ".join(blockers))

    manifest_path = f"bundles/{tier}/eliza-1.manifest.json"
    manifest = _download_json(api, repo_id, manifest_path)
    verified = manifest.setdefault("kernels", {}).setdefault("verifiedBackends", {})
    old = dict(verified.get(backend) or {})
    new = {
        "status": "pass",
        "atCommit": str(verify.get("atCommit") or dispatch.get("atCommit") or "unknown"),
        "report": f"evals/{Path(verify_path).name}",
    }
    verified[backend] = new
    return {
        "tier": tier,
        "backend": backend,
        "old": old,
        "new": new,
        "changed": old != new,
        "manifest": manifest,
    }


def apply_fold(api: Any, repo_id: str, plan: dict[str, Any]) -> str:
    from huggingface_hub import CommitOperationAdd

    tier = str(plan["tier"])
    backend = str(plan["backend"])
    with TemporaryDirectory(prefix="eliza1-backend-fold-") as tmp:
        path = Path(tmp) / "eliza-1.manifest.json"
        path.write_text(json.dumps(plan["manifest"], indent=2, sort_keys=True) + "\n", encoding="utf-8")
        info = api.create_commit(
            repo_id=repo_id,
            repo_type="model",
            operations=[
                CommitOperationAdd(
                    path_in_repo=f"bundles/{tier}/eliza-1.manifest.json",
                    path_or_fileobj=str(path),
                )
            ],
            commit_message=f"Fold {tier} {backend} backend evidence into manifest",
            commit_description=(
                "Updates only kernels.verifiedBackends for a backend whose uploaded "
                "verify and dispatch evidence already pass. Does not change eval gates, "
                "weights, or release-state claims."
            ),
        )
    return info.commit_url


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--repo-id", default=ELIZA_1_HF_REPO)
    ap.add_argument("--tier", choices=ELIZA_1_TIERS, required=True)
    ap.add_argument("--backend", required=True)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args(argv)

    from huggingface_hub import HfApi

    api = HfApi(token=os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN"))
    plan = plan_fold(api, args.repo_id, args.tier, args.backend)
    summary = {k: plan[k] for k in ("tier", "backend", "old", "new", "changed")}
    summary["apply"] = args.apply
    if args.apply and plan["changed"]:
        summary["commitUrl"] = apply_fold(api, args.repo_id, plan)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
