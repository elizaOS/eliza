"""Tests for HF bundle integrity metadata repair planning."""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.manifest.repair_hf_eliza1_bundle_integrity import plan_repair  # noqa: E402


@dataclass
class Sibling:
    rfilename: str
    size: int
    lfs: object | None = None


class FakeApi:
    token = None

    def __init__(self) -> None:
        self.files = {
            "bundles/0_8b/eliza-1.manifest.json": json.dumps(
                {
                    "files": {
                        "text": [
                            {
                                "path": "text/model.gguf",
                                "sha256": "a" * 64,
                            }
                        ],
                        "meta": [
                            {
                                "path": "meta.json",
                                "sha256": "b" * 64,
                            }
                        ],
                    }
                }
            ).encode(),
            "bundles/0_8b/checksums/SHA256SUMS": (
                f"{'a' * 64}  text/model.gguf\n"
            ).encode(),
            "bundles/0_8b/meta.json": b'{"ok":true}\n',
        }

    def model_info(self, repo_id: str, files_metadata: bool = False):
        assert repo_id == "repo"
        assert files_metadata is True
        return SimpleNamespace(
            siblings=[
                Sibling(
                    "bundles/0_8b/text/model.gguf",
                    100,
                    SimpleNamespace(sha256="c" * 64),
                ),
                Sibling("bundles/0_8b/meta.json", 12, None),
                Sibling("bundles/0_8b/eliza-1.manifest.json", 10, None),
                Sibling("bundles/0_8b/checksums/SHA256SUMS", 10, None),
            ]
        )

    def hf_hub_download(
        self,
        *,
        repo_id: str,
        filename: str,
        repo_type: str,
        local_dir: str,
    ) -> str:
        assert repo_id == "repo"
        path = Path(local_dir) / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.files[filename])
        return str(path)


def test_plan_repair_updates_manifest_hashes_and_checksum_coverage() -> None:
    plan = plan_repair(FakeApi(), "repo", "0_8b")

    assert plan["changedManifestPaths"] == ["text/model.gguf", "meta.json"]
    manifest = json.loads(plan["manifestText"])
    assert manifest["files"]["text"][0]["sha256"] == "c" * 64
    assert manifest["files"]["meta"][0]["sha256"] == "e5f1eb4d806641698a35efe20e098efd20d7d57a9b90ee69079d5bb650920726"
    checksum = plan["checksumText"]
    assert f"{'c' * 64}  text/model.gguf" in checksum
    assert "meta.json" in checksum
    assert "checksums/SHA256SUMS" not in checksum
