from __future__ import annotations

import json

import pytest

from elizaos_tau_bench import data_assets


def test_smoke_data_loads_packaged_retail_fixture(monkeypatch):
    monkeypatch.setenv("TAU_BENCH_DATA_MODE", "smoke")

    data = data_assets.load_domain_data("retail")

    assert set(data) == {"orders", "products", "users"}
    assert "#W2378156" in data["orders"]
    assert "yusuf_rossi_9620" in data["users"]


def test_retail_env_data_package_delegates_to_loader(monkeypatch):
    # Regression: the retail env does `from ...envs.retail.data import load_data`,
    # which resolves to the ``data`` PACKAGE (it shadows the sibling ``data.py``
    # module on import). That package only vendored ``products.json``, so the
    # upstream original raised FileNotFoundError on ``orders.json`` and every
    # retail env_init died. It must delegate to the shared loader instead.
    monkeypatch.setenv("TAU_BENCH_DATA_MODE", "smoke")
    from elizaos_tau_bench.upstream.envs.retail.data import load_data

    data = load_data()
    assert set(data) == {"orders", "products", "users"}
    assert all(data[key] for key in data)


def test_airline_env_data_package_delegates_to_loader(monkeypatch):
    monkeypatch.setenv("TAU_BENCH_DATA_MODE", "smoke")
    from elizaos_tau_bench.upstream.envs.airline.data import load_data

    data = load_data()
    assert set(data) == {"flights", "reservations", "users"}
    assert all(data[key] for key in data)


def test_official_data_fetches_missing_assets_to_cache(tmp_path, monkeypatch):
    cache_root = tmp_path / "cache"
    monkeypatch.setenv("TAU_BENCH_DATA_DIR", str(cache_root))
    monkeypatch.delenv("TAU_BENCH_DATA_MODE", raising=False)

    payloads = {
        "orders.json": {"order": {"id": 1}},
        "products.json": {"product": {"id": 2}},
        "users.json": {"user": {"id": 3}},
    }

    def fake_download(url, destination):
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(
            json.dumps(payloads[destination.name]),
            encoding="utf-8",
        )

    monkeypatch.setattr(data_assets, "_download_file", fake_download)

    data = data_assets.load_domain_data("retail")

    assert data == {
        "orders": payloads["orders.json"],
        "products": payloads["products.json"],
        "users": payloads["users.json"],
    }
    assert (cache_root / "retail" / "SOURCE.txt").is_file()


def test_official_data_can_require_prepopulated_local_files(tmp_path, monkeypatch):
    monkeypatch.setenv("TAU_BENCH_DATA_DIR", str(tmp_path / "missing"))
    monkeypatch.setenv("TAU_BENCH_DISABLE_DATA_DOWNLOAD", "1")
    monkeypatch.delenv("TAU_BENCH_DATA_MODE", raising=False)

    with pytest.raises(FileNotFoundError) as exc:
        data_assets.ensure_official_data("airline")

    assert "populate TAU_BENCH_DATA_DIR" in str(exc.value)
