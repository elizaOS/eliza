"""Exercise atomic corpus restoration against real local files, without network access."""

import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "terminal-bench" / "fetch-corpus-assets.py"
spec = importlib.util.spec_from_file_location("fetch_corpus_assets", SCRIPT)
assert spec is not None and spec.loader is not None
fetcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetcher)


def fixture(tmp_path: Path) -> tuple[Path, Path, Path]:
    source = tmp_path / "source"
    source.write_bytes(b"complete benchmark input\x00")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"downloadable_assets": [{
        "path": "task/input.bin", "url": source.as_uri(),
        "bytes": source.stat().st_size,
        "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    }]}))
    return manifest, tmp_path / "tasks", source


def test_restore_and_reuse_without_fetching(tmp_path: Path) -> None:
    manifest, tasks, source = fixture(tmp_path)
    assert fetcher.restore_assets(manifest, tasks) == 1
    target = tasks / "task/input.bin"
    assert target.read_bytes() == source.read_bytes()
    before = target.stat().st_mtime_ns
    source.unlink()
    assert fetcher.restore_assets(manifest, tasks) == 0
    assert target.stat().st_mtime_ns == before


def test_corrupt_download_never_becomes_input(tmp_path: Path) -> None:
    manifest, tasks, source = fixture(tmp_path)
    source.write_bytes(b"wrong")
    with pytest.raises(ValueError, match="checksum"):
        fetcher.restore_assets(manifest, tasks)
    assert not (tasks / "task/input.bin").exists()
    assert not list(tmp_path.glob("terminal-assets-*"))


def test_existing_corrupt_input_is_preserved(tmp_path: Path) -> None:
    manifest, tasks, _ = fixture(tmp_path)
    target = tasks / "task/input.bin"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"local changes")
    with pytest.raises(ValueError, match="move it aside"):
        fetcher.restore_assets(manifest, tasks)
    assert target.read_bytes() == b"local changes"


@pytest.mark.parametrize("relative", ["../outside", "/outside", "task/../../outside"])
def test_rejects_path_escape(tmp_path: Path, relative: str) -> None:
    manifest, tasks, _ = fixture(tmp_path)
    document = json.loads(manifest.read_text())
    document["downloadable_assets"][0]["path"] = relative
    manifest.write_text(json.dumps(document))
    with pytest.raises(ValueError, match="Unsafe"):
        fetcher.restore_assets(manifest, tasks)
