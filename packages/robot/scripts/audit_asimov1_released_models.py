#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.source_inventory import collect_asimov1_source_inventory  # noqa: E402

_MODEL_EXTS = {
    ".ckpt",
    ".joblib",
    ".npz",
    ".onnx",
    ".pb",
    ".pkl",
    ".pt",
    ".pth",
    ".safetensors",
    ".tflite",
    ".zip",
}
_MODEL_KEYWORDS = (
    "checkpoint",
    "ckpt",
    "locomotion",
    "model",
    "policy",
    "ppo",
    "rl",
    "safetensors",
    "weights",
)
_GITHUB_REPOS = (
    "asimovinc/asimov-1",
    "asimovinc/asimov-v1",
    "asimovinc/asimov-v0",
    "asimovinc/asimov-mjlab",
)
_SOURCES = [
    "https://github.com/asimovinc/asimov-1",
    "https://github.com/asimovinc/asimov-1/releases",
    "https://github.com/asimovinc/asimov-v1",
    "https://github.com/asimovinc/asimov-v1/releases",
    "https://github.com/asimovinc/asimov-mjlab",
    "https://github.com/asimovinc/asimov-mjlab/releases",
    "https://menlo.ai/blog/teaching-a-humanoid-to-walk",
    "https://docs.menlo.ai/guides/locomotion-training",
    "https://docs.menlo.ai/asimov/1",
    "https://docs.menlo.ai/asimov/1/api/robot-control",
    "https://docs.menlo.ai/asimov/1/api/protocols",
]


def _github_json(url: str) -> tuple[Any | None, str | None]:
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "eliza-robot-asimov-audit",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8")), None
    except urllib.error.HTTPError as exc:
        return None, f"HTTP {exc.code}: {exc.reason}"
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"


def _looks_like_model_artifact(path: str) -> bool:
    lower = path.lower()
    suffix = Path(lower).suffix
    return suffix in _MODEL_EXTS and any(keyword in lower for keyword in _MODEL_KEYWORDS)


def _repo_default_branch(repo: str) -> tuple[str | None, dict[str, Any]]:
    payload, error = _github_json(f"https://api.github.com/repos/{repo}")
    if error or not isinstance(payload, dict):
        return None, {"repo": repo, "ok": False, "error": error or "invalid repository response"}
    return str(payload.get("default_branch") or "main"), {
        "repo": repo,
        "ok": True,
        "default_branch": str(payload.get("default_branch") or "main"),
        "html_url": payload.get("html_url"),
        "pushed_at": payload.get("pushed_at"),
    }


def _audit_repo_releases(repo: str) -> dict[str, Any]:
    payload, error = _github_json(f"https://api.github.com/repos/{repo}/releases")
    if error or not isinstance(payload, list):
        return {"repo": repo, "ok": False, "error": error or "invalid releases response", "releases": [], "artifacts": []}
    artifacts: list[dict[str, Any]] = []
    releases = []
    for release in payload:
        if not isinstance(release, dict):
            continue
        assets = release.get("assets") if isinstance(release.get("assets"), list) else []
        release_row = {
            "tag_name": release.get("tag_name"),
            "name": release.get("name"),
            "published_at": release.get("published_at"),
            "asset_count": len(assets),
            "html_url": release.get("html_url"),
        }
        releases.append(release_row)
        for asset in assets:
            if not isinstance(asset, dict):
                continue
            name = str(asset.get("name") or "")
            if _looks_like_model_artifact(name):
                artifacts.append(
                    {
                        "repo": repo,
                        "source": "release_asset",
                        "release": release.get("tag_name"),
                        "path": name,
                        "url": asset.get("browser_download_url"),
                        "size": asset.get("size"),
                    }
                )
    return {"repo": repo, "ok": True, "release_count": len(releases), "releases": releases, "artifacts": artifacts}


def _audit_repo_tree(repo: str) -> dict[str, Any]:
    branch, repo_meta = _repo_default_branch(repo)
    if not branch:
        return {"repo": repo, "ok": False, "error": repo_meta.get("error"), "artifacts": []}
    payload, error = _github_json(f"https://api.github.com/repos/{repo}/git/trees/{branch}?recursive=1")
    if error or not isinstance(payload, dict):
        return {"repo": repo, "ok": False, "default_branch": branch, "error": error or "invalid tree response", "artifacts": []}
    tree = payload.get("tree") if isinstance(payload.get("tree"), list) else []
    artifacts = []
    for item in tree:
        if not isinstance(item, dict) or item.get("type") != "blob":
            continue
        path = str(item.get("path") or "")
        if _looks_like_model_artifact(path):
            artifacts.append(
                {
                    "repo": repo,
                    "source": "repository_tree",
                    "path": path,
                    "url": item.get("url"),
                    "size": item.get("size"),
                }
            )
    return {
        "repo": repo,
        "ok": True,
        "default_branch": branch,
        "truncated": bool(payload.get("truncated")),
        "blob_count": len([item for item in tree if isinstance(item, dict) and item.get("type") == "blob"]),
        "artifacts": artifacts,
    }


def _audit_github() -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    release_rows = [_audit_repo_releases(repo) for repo in _GITHUB_REPOS]
    tree_rows = [_audit_repo_tree(repo) for repo in _GITHUB_REPOS]
    artifacts = []
    for row in [*release_rows, *tree_rows]:
        artifacts.extend(row.get("artifacts", []))
    return (
        {"checked": True, "repos": release_rows},
        {"checked": True, "repos": tree_rows},
        artifacts,
    )


def audit_released_models(*, check_github_releases: bool = False) -> dict:
    inv = collect_asimov1_source_inventory()
    release_report: dict[str, Any] = {"checked": False, "repos": []}
    tree_report: dict[str, Any] = {"checked": False, "repos": []}
    github_artifacts: list[dict[str, Any]] = []
    if check_github_releases:
        release_report, tree_report, github_artifacts = _audit_github()
    local_artifacts = [
        {
            "repo": "pinned_checkout",
            "source": "submodule_checkout",
            "path": path,
            "url": None,
            "size": None,
        }
        for path in inv.get("released_policy_artifacts", [])
        if _looks_like_model_artifact(path)
    ]
    found_artifacts = [*local_artifacts, *github_artifacts]
    found = bool(found_artifacts)
    return {
        "ok": not found,
        "found_released_policy_or_model": found,
        "conclusion": (
            "released ASIMOV policy/model artifacts found; inspect artifact list before choosing a training baseline"
            if found
            else "no released ASIMOV-1 policy/model artifacts found in audited public sources"
        ),
        "expected_remote": "https://github.com/asimovinc/asimov-1.git",
        "pinned_checkout": inv,
        "github_releases": release_report,
        "github_repository_trees": tree_report,
        "model_artifacts": found_artifacts,
        "public_training_code": {
            "repo": "asimovinc/asimov-mjlab",
            "url": "https://github.com/asimovinc/asimov-mjlab",
            "status": "public locomotion training/reference code audited separately from released checkpoint/model artifacts",
        },
        "sources": _SOURCES,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-github-releases", action="store_true")
    parser.add_argument("--require-none", action="store_true")
    args = parser.parse_args()
    report = audit_released_models(check_github_releases=args.check_github_releases)
    print(json.dumps(report, indent=2))
    if args.require_none and report["found_released_policy_or_model"]:
        return 2
    return 0 if report["ok"] or not args.require_none else 2


if __name__ == "__main__":
    raise SystemExit(main())
