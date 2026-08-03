"""Verifies immutable Hugging Face revisions survive download-marker reuse."""

from __future__ import annotations

from scripts import download_datasets


def test_pinned_download_passes_revision_and_records_it(tmp_path, monkeypatch) -> None:
    calls: list[dict[str, object]] = []
    entry = {
        "slug": "hermes-fc-v1",
        "repo_id": "NousResearch/hermes-function-calling-v1",
        "revision": "dae3e1d28cfbcf4b915c04ea1e072030529b4bda",
    }
    monkeypatch.setattr(download_datasets, "RAW_DIR", tmp_path)
    monkeypatch.setattr(
        download_datasets,
        "snapshot_download",
        lambda **kwargs: calls.append(kwargs),
    )

    slug, status, _size = download_datasets.download_one(entry, retries=1)

    assert (slug, status) == ("hermes-fc-v1", "ok")
    assert calls[0]["revision"] == entry["revision"]
    assert download_datasets.is_done(entry) is True


def test_pinned_download_rejects_legacy_or_stale_marker(tmp_path, monkeypatch) -> None:
    entry = {
        "slug": "hermes-fc-v1",
        "repo_id": "NousResearch/hermes-function-calling-v1",
        "revision": "new-revision",
    }
    monkeypatch.setattr(download_datasets, "RAW_DIR", tmp_path)
    marker = tmp_path / entry["slug"] / ".done"
    marker.parent.mkdir(parents=True)
    marker.write_text(f"{entry['repo_id']}\n1234\n", encoding="utf-8")

    assert download_datasets.is_done(entry) is False

    marker.write_text(f"{entry['repo_id']}\n1234\nold-revision\n", encoding="utf-8")
    assert download_datasets.is_done(entry) is False


def test_pinned_download_removes_stale_snapshot_before_fetch(
    tmp_path, monkeypatch
) -> None:
    entry = {
        "slug": "hermes-fc-v1",
        "repo_id": "NousResearch/hermes-function-calling-v1",
        "revision": "new-revision",
    }
    monkeypatch.setattr(download_datasets, "RAW_DIR", tmp_path)
    target = tmp_path / entry["slug"]
    target.mkdir(parents=True)
    (target / ".done").write_text(
        f"{entry['repo_id']}\n1234\nold-revision\n", encoding="utf-8"
    )
    stale = target / "removed.json"
    stale.write_text("stale", encoding="utf-8")

    def download(**_kwargs: object) -> None:
        assert stale.exists() is False

    monkeypatch.setattr(download_datasets, "snapshot_download", download)

    _slug, status, _size = download_datasets.download_one(entry, retries=1)

    assert status == "ok"
    assert download_datasets.is_done(entry) is True
