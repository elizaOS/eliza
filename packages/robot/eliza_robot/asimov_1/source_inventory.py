"""Inventory checks for the vendored ASIMOV-1 submodule."""

from __future__ import annotations

import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

from eliza_robot.asimov_1.constants import ASIMOV1_SUBMODULE_ROOT

EXPECTED_ASIMOV1_SUBMODULE_PATH = "packages/robot/vendor/asimov-1"
EXPECTED_ASIMOV1_REMOTE = "https://github.com/asimovinc/asimov-1.git"


@dataclass(frozen=True)
class AsimovSourceInventory:
    ok: bool
    repo_root: str
    expected_path: str
    expected_remote: str
    submodule_configured: bool
    checkout_present: bool
    git_checkout: bool
    parent_gitlink_registered: bool
    commit: str
    remote_urls: list[str]
    cad_asset_counts: dict[str, int]
    released_policy_artifacts: list[str]


def _run(args: list[str], cwd: Path) -> str:
    proc = subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=False)
    return proc.stdout.strip()


def collect_asimov1_source_inventory(
    *,
    repo_root: Path | None = None,
    checkout_root: Path = ASIMOV1_SUBMODULE_ROOT,
) -> dict:
    repo_root = repo_root or Path(__file__).resolve().parents[4]
    git_checkout = (checkout_root / ".git").exists()
    commit = _run(["git", "rev-parse", "HEAD"], checkout_root) if git_checkout else ""
    remotes = _run(["git", "remote", "-v"], checkout_root).splitlines() if git_checkout else []
    remote_urls = sorted({line.split()[1] for line in remotes if len(line.split()) >= 2})
    modules = repo_root / ".gitmodules"
    submodule_configured = modules.is_file() and EXPECTED_ASIMOV1_SUBMODULE_PATH in modules.read_text(
        encoding="utf-8"
    )
    parent_ls = _run(["git", "ls-files", "-s", EXPECTED_ASIMOV1_SUBMODULE_PATH], repo_root)
    counts = {
        "step": len(list(checkout_root.rglob("*.STEP"))) + len(list(checkout_root.rglob("*.step"))),
        "stl": len(list((checkout_root / "sim-model" / "assets" / "meshes").glob("*.STL"))),
        "mjcf_xml": len(list((checkout_root / "sim-model" / "xmls").glob("*.xml"))),
        "mesh": len(list((checkout_root / "sim-model" / "assets" / "meshes").iterdir()))
        if (checkout_root / "sim-model" / "assets" / "meshes").is_dir()
        else 0,
        "fabrication_manifest": 1 if (checkout_root / "mechanical" / "FABRICATION_MANIFEST.json").is_file() else 0,
    }
    model_exts = {".ckpt", ".joblib", ".npz", ".onnx", ".pb", ".pkl", ".pt", ".pth", ".safetensors", ".zip"}
    artifacts = [
        str(path.relative_to(checkout_root))
        for path in checkout_root.rglob("*")
        if path.is_file() and path.suffix.lower() in model_exts
    ]
    ok = checkout_root.is_dir() and git_checkout and EXPECTED_ASIMOV1_REMOTE in remote_urls
    return asdict(
        AsimovSourceInventory(
            ok=ok,
            repo_root=str(repo_root),
            expected_path=EXPECTED_ASIMOV1_SUBMODULE_PATH,
            expected_remote=EXPECTED_ASIMOV1_REMOTE,
            submodule_configured=submodule_configured,
            checkout_present=checkout_root.is_dir(),
            git_checkout=git_checkout,
            parent_gitlink_registered=parent_ls.startswith("160000"),
            commit=commit,
            remote_urls=remote_urls,
            cad_asset_counts=counts,
            released_policy_artifacts=artifacts,
        )
    )
