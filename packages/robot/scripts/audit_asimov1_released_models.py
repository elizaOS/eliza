#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
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
_BASE_GITHUB_REPOS = (
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
    "https://manual.asimov.inc/v0/locomotion",
    "https://manual.asimov.inc/v0/locomotion/reinforcement-learning-for-locomotion",
    "https://manual.asimov.inc/v0/locomotion/reinforcement-learning-simulation-training-environment",
    "https://manual.asimov.inc/v0/locomotion/reinforcement-learning-reward-design",
    "https://manual.asimov.inc/v1",
    "https://manual.asimov.inc/v1/quickstart",
    "https://news.asimov.inc/p/teaching-a-humanoid-to-walk",
    "https://news.asimov.inc/p/noise-is-all-you-need",
    "https://menlo.ai/blog/teaching-a-humanoid-to-walk",
    "https://menlo.ai/blog/noise-is-all-you-need",
    "https://www.menlo.ai/products/asimov",
    "https://docs.menlo.ai/asimov/v1/locomotion/reinforcement-learning-for-locomotion",
    "https://docs.menlo.ai/guides/locomotion-training",
    "https://docs.menlo.ai/asimov/1",
    "https://docs.menlo.ai/asimov/1/api/robot-control",
    "https://docs.menlo.ai/asimov/1/api/protocols",
]

_PUBLIC_POLICY_CLAIMS = [
    {
        "source": "https://github.com/asimovinc/asimov-v1",
        "claim": "README roadmap lists locomotion policy as a future item",
        "artifact_status": "repository contains CAD/electrical/simulation assets; no released policy weights identified",
    },
    {
        "source": "https://manual.asimov.inc/v1",
        "claim": "manual mentions pre-trained/base walking policy availability",
        "artifact_status": "no downloadable checkpoint or model artifact found by this audit",
    },
    {
        "source": "https://manual.asimov.inc/v1/quickstart",
        "claim": "manual points readers to locomotion-control documentation for simulation and RL training/deployment workflow",
        "artifact_status": "workflow documentation; no released weights identified",
    },
    {
        "source": "https://manual.asimov.inc/v0/locomotion/reinforcement-learning-for-locomotion",
        "claim": "manual documents ASIMOV locomotion policy design and asymmetric actor-critic observations",
        "artifact_status": "documentation only; no released weights identified",
    },
    {
        "source": "https://manual.asimov.inc/v0/locomotion/reinforcement-learning-reward-design",
        "claim": "manual documents reward terms and sim-to-real tuning for deployable walking",
        "artifact_status": "documentation only; no released weights identified",
    },
    {
        "source": "https://news.asimov.inc/p/teaching-a-humanoid-to-walk",
        "claim": "news post reports a trained walking locomotion policy",
        "artifact_status": "article only; no released weights identified",
    },
]


def _github_json(url: str) -> tuple[Any | None, str | None]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "eliza-robot-asimov-audit",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token := os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        url,
        headers=headers,
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


def _git_default_branch(repo: str) -> tuple[str | None, str | None]:
    url = f"https://github.com/{repo}.git"
    try:
        proc = subprocess.run(
            ["git", "ls-remote", "--symref", url, "HEAD"],
            text=True,
            capture_output=True,
            check=False,
            timeout=60,
        )
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"
    if proc.returncode != 0:
        return None, proc.stderr.strip() or proc.stdout.strip() or f"git ls-remote failed with {proc.returncode}"
    for line in proc.stdout.splitlines():
        if line.startswith("ref: refs/heads/") and line.endswith("\tHEAD"):
            return line.removeprefix("ref: refs/heads/").removesuffix("\tHEAD"), None
    return "main", None


def _discover_asimov_org_repos() -> dict[str, Any]:
    payload, error = _github_json("https://api.github.com/orgs/asimovinc/repos?per_page=100")
    if error or not isinstance(payload, list):
        return {
            "checked": True,
            "ok": False,
            "source": "github_org_repos",
            "error": error or "invalid org repository response",
            "repos": [],
        }
    repos: list[str] = []
    repo_rows: list[dict[str, Any]] = []
    for row in payload:
        if not isinstance(row, dict):
            continue
        full_name = str(row.get("full_name") or "")
        name = str(row.get("name") or "").lower()
        if not full_name or ("asimov" not in name and "mjlab" not in name):
            continue
        repos.append(full_name)
        repo_rows.append(
            {
                "full_name": full_name,
                "html_url": row.get("html_url"),
                "default_branch": row.get("default_branch"),
                "pushed_at": row.get("pushed_at"),
            }
        )
    return {
        "checked": True,
        "ok": True,
        "source": "github_org_repos",
        "repos": sorted(set(repos)),
        "repo_metadata": repo_rows,
    }


def _git_tags(repo: str) -> tuple[list[str], str | None]:
    url = f"https://github.com/{repo}.git"
    try:
        proc = subprocess.run(
            ["git", "ls-remote", "--tags", url],
            text=True,
            capture_output=True,
            check=False,
            timeout=60,
        )
    except Exception as exc:
        return [], f"{type(exc).__name__}: {exc}"
    if proc.returncode != 0:
        return [], proc.stderr.strip() or proc.stdout.strip() or f"git ls-remote --tags failed with {proc.returncode}"
    tags: list[str] = []
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].startswith("refs/tags/"):
            tag = parts[1].removeprefix("refs/tags/").removesuffix("^{}")
            if tag not in tags:
                tags.append(tag)
    return tags, None


def _audit_repo_releases_git(repo: str, api_error: str) -> dict[str, Any]:
    tags, tag_error = _git_tags(repo)
    if tag_error:
        return {
            "repo": repo,
            "ok": False,
            "source": "git_tags_fallback",
            "error": f"{api_error}; git tag fallback failed: {tag_error}",
            "releases": [],
            "artifacts": [],
        }
    if tags:
        return {
            "repo": repo,
            "ok": False,
            "source": "git_tags_fallback",
            "error": f"{api_error}; tags exist, release assets require GitHub release API inspection",
            "release_count": len(tags),
            "releases": [{"tag_name": tag, "name": None, "published_at": None, "asset_count": None, "html_url": f"https://github.com/{repo}/releases/tag/{tag}"} for tag in tags],
            "artifacts": [],
        }
    return {
        "repo": repo,
        "ok": True,
        "source": "git_tags_fallback",
        "api_error": api_error,
        "release_count": 0,
        "releases": [],
        "artifacts": [],
    }


def _audit_repo_tree_git(repo: str, branch: str | None, api_error: str) -> dict[str, Any]:
    if not branch:
        branch, branch_error = _git_default_branch(repo)
        if branch_error:
            return {
                "repo": repo,
                "ok": False,
                "source": "git_fallback",
                "error": f"{api_error}; git default branch fallback failed: {branch_error}",
                "artifacts": [],
            }
    assert branch is not None
    url = f"https://github.com/{repo}.git"
    with tempfile.TemporaryDirectory(prefix="asimov-model-audit-") as tmp:
        try:
            clone = subprocess.run(
                [
                    "git",
                    "clone",
                    "--depth",
                    "1",
                    "--filter=blob:none",
                    "--sparse",
                    "--no-checkout",
                    "--branch",
                    branch,
                    url,
                    tmp,
                ],
                text=True,
                capture_output=True,
                check=False,
                timeout=180,
            )
        except Exception as exc:
            return {
                "repo": repo,
                "ok": False,
                "source": "git_fallback",
                "default_branch": branch,
                "error": f"{api_error}; git clone fallback raised {type(exc).__name__}: {exc}",
                "artifacts": [],
            }
        if clone.returncode != 0:
            return {
                "repo": repo,
                "ok": False,
                "source": "git_fallback",
                "default_branch": branch,
                "error": f"{api_error}; git clone fallback failed: {clone.stderr.strip() or clone.stdout.strip()}",
                "artifacts": [],
            }
        try:
            tree = subprocess.run(
                ["git", "-C", tmp, "ls-tree", "-r", "--name-only", "HEAD"],
                text=True,
                capture_output=True,
                check=False,
                timeout=60,
            )
        except Exception as exc:
            return {
                "repo": repo,
                "ok": False,
                "source": "git_fallback",
                "default_branch": branch,
                "error": f"{api_error}; git ls-tree fallback raised {type(exc).__name__}: {exc}",
                "artifacts": [],
            }
        if tree.returncode != 0:
            return {
                "repo": repo,
                "ok": False,
                "source": "git_fallback",
                "default_branch": branch,
                "error": f"{api_error}; git ls-tree fallback failed: {tree.stderr.strip() or tree.stdout.strip()}",
                "artifacts": [],
            }
    paths = [line.strip() for line in tree.stdout.splitlines() if line.strip()]
    artifacts = [
        {
            "repo": repo,
            "source": "repository_tree_git_fallback",
            "path": path,
            "url": f"https://github.com/{repo}/blob/{branch}/{path}",
            "size": None,
        }
        for path in paths
        if _looks_like_model_artifact(path)
    ]
    return {
        "repo": repo,
        "ok": True,
        "source": "git_fallback",
        "default_branch": branch,
        "truncated": False,
        "blob_count": len(paths),
        "api_error": api_error,
        "artifacts": artifacts,
    }


def _audit_repo_releases(repo: str) -> dict[str, Any]:
    payload, error = _github_json(f"https://api.github.com/repos/{repo}/releases")
    if error or not isinstance(payload, list):
        return _audit_repo_releases_git(repo, error or "invalid releases response")
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
        return _audit_repo_tree_git(repo, None, str(repo_meta.get("error") or "repository API failed"))
    payload, error = _github_json(f"https://api.github.com/repos/{repo}/git/trees/{branch}?recursive=1")
    if error or not isinstance(payload, dict):
        return _audit_repo_tree_git(repo, branch, error or "invalid tree response")
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


def _audit_github(repos: list[str]) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    release_rows = [_audit_repo_releases(repo) for repo in repos]
    tree_rows = [_audit_repo_tree(repo) for repo in repos]
    artifacts = []
    for row in [*release_rows, *tree_rows]:
        artifacts.extend(row.get("artifacts", []))
    return (
        {"checked": True, "token_used": bool(os.environ.get("GITHUB_TOKEN")), "repos": release_rows},
        {"checked": True, "token_used": bool(os.environ.get("GITHUB_TOKEN")), "repos": tree_rows},
        artifacts,
    )


def _github_audit_warnings(*reports: dict[str, Any]) -> list[str]:
    warnings: list[str] = []
    for report in reports:
        if not report.get("checked"):
            continue
        for row in report.get("repos", []):
            if not isinstance(row, dict):
                continue
            repo = row.get("repo", "unknown")
            if not row.get("ok", False):
                warnings.append(f"{repo}: {row.get('error', 'GitHub check failed')}")
            if row.get("truncated"):
                warnings.append(f"{repo}: repository tree response was truncated")
    return warnings


def audit_released_models(
    *,
    check_github_releases: bool = False,
    checked_at: dt.datetime | None = None,
) -> dict:
    checked_at = checked_at or dt.datetime.now(dt.UTC)
    if checked_at.tzinfo is None:
        checked_at = checked_at.replace(tzinfo=dt.UTC)
    inv = collect_asimov1_source_inventory()
    release_report: dict[str, Any] = {"checked": False, "repos": []}
    tree_report: dict[str, Any] = {"checked": False, "repos": []}
    discovery_report: dict[str, Any] = {"checked": False, "repos": []}
    github_artifacts: list[dict[str, Any]] = []
    audited_repositories = list(_BASE_GITHUB_REPOS)
    if check_github_releases:
        discovery_report = _discover_asimov_org_repos()
        if discovery_report.get("ok"):
            audited_repositories = sorted(
                set(audited_repositories).union(discovery_report.get("repos", []))
            )
        release_report, tree_report, github_artifacts = _audit_github(audited_repositories)
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
    warnings = _github_audit_warnings(release_report, tree_report)
    audit_complete = not warnings
    return {
        "ok": not found,
        "checked_at_utc": checked_at.astimezone(dt.UTC).isoformat(),
        "check_github_releases": check_github_releases,
        "audit_complete": audit_complete,
        "warnings": warnings,
        "found_released_policy_or_model": found,
        "conclusion": (
            "released ASIMOV policy/model artifacts found; inspect artifact list before choosing a training baseline"
            if found
            else (
                "no released ASIMOV-1 policy/model artifacts found in completed audited public sources; some GitHub checks were incomplete"
                if warnings
                else "no released ASIMOV-1 policy/model artifacts found in audited public sources"
            )
        ),
        "expected_remote": "https://github.com/asimovinc/asimov-1.git",
        "audited_repositories": audited_repositories,
        "pinned_checkout": inv,
        "github_repository_discovery": discovery_report,
        "github_releases": release_report,
        "github_repository_trees": tree_report,
        "model_artifacts": found_artifacts,
        "public_policy_claims": _PUBLIC_POLICY_CLAIMS,
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
    parser.add_argument("--require-complete", action="store_true")
    args = parser.parse_args()
    report = audit_released_models(check_github_releases=args.check_github_releases)
    print(json.dumps(report, indent=2))
    if args.require_none and report["found_released_policy_or_model"]:
        return 2
    if args.require_complete and not report["audit_complete"]:
        return 3
    return 0 if report["ok"] or not args.require_none else 2


if __name__ == "__main__":
    raise SystemExit(main())
