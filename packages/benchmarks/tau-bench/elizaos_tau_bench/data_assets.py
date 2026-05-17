"""Official tau-bench data asset loading.

Full upstream data is fetched lazily into a user cache. The repository only
ships tiny smoke fixtures that cover the packaged sample tasks.
"""

from __future__ import annotations

import json
import os
import shutil
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Literal

Domain = Literal["retail", "airline"]

UPSTREAM_REF = os.environ.get("TAU_BENCH_UPSTREAM_REF", "59a200c6d575d595120f1cb70fea53cef0632f6b")
UPSTREAM_BASE_URL = (
    "https://raw.githubusercontent.com/sierra-research/tau-bench"
    f"/{UPSTREAM_REF}/tau_bench/envs"
)
DATA_FILES: dict[Domain, tuple[str, ...]] = {
    "retail": ("orders.json", "products.json", "users.json"),
    "airline": ("flights.json", "reservations.json", "users.json"),
}


def _package_domain_dir(domain: Domain) -> Path:
    return Path(__file__).resolve().parent / "compact_fixtures" / domain


def _cache_domain_dir(domain: Domain) -> Path:
    root = os.environ.get("TAU_BENCH_DATA_DIR")
    if root:
        return Path(root).expanduser().resolve() / domain
    return Path.home() / ".cache" / "elizaos_tau_bench" / "upstream" / UPSTREAM_REF / domain


def _use_smoke_data() -> bool:
    return os.environ.get("TAU_BENCH_DATA_MODE", "").strip().lower() in {
        "smoke",
        "sample",
        "fixture",
    }


def _read_domain_data(domain: Domain, directory: Path) -> dict[str, Any]:
    data: dict[str, Any] = {}
    for filename in DATA_FILES[domain]:
        path = directory / filename
        with path.open(encoding="utf-8") as handle:
            data[filename.removesuffix(".json")] = json.load(handle)
    return data


def _has_all_data_files(domain: Domain, directory: Path) -> bool:
    return all((directory / filename).is_file() for filename in DATA_FILES[domain])


def _download_file(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp = destination.with_suffix(destination.suffix + ".tmp")
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            with tmp.open("wb") as handle:
                shutil.copyfileobj(response, handle)
        tmp.replace(destination)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def ensure_official_data(domain: Domain) -> Path:
    """Return a directory containing complete official upstream data."""
    cache_dir = _cache_domain_dir(domain)
    if _has_all_data_files(domain, cache_dir):
        return cache_dir

    if os.environ.get("TAU_BENCH_DISABLE_DATA_DOWNLOAD"):
        raise FileNotFoundError(
            f"Official tau-bench {domain} data is missing from {cache_dir}. "
            "Unset TAU_BENCH_DISABLE_DATA_DOWNLOAD or populate TAU_BENCH_DATA_DIR."
        )

    for filename in DATA_FILES[domain]:
        url = f"{UPSTREAM_BASE_URL}/{domain}/data/{filename}"
        destination = cache_dir / filename
        if destination.is_file():
            continue
        try:
            _download_file(url, destination)
        except urllib.error.URLError as exc:
            raise FileNotFoundError(
                f"Could not fetch official tau-bench {domain} data asset {filename} from {url}. "
                "Set TAU_BENCH_DATA_MODE=smoke for sample-task smoke runs, or populate "
                "TAU_BENCH_DATA_DIR with the upstream JSON files."
            ) from exc

    (cache_dir / "SOURCE.txt").write_text(
        "Fetched from sierra-research/tau-bench at ref "
        f"{UPSTREAM_REF}.\nUpstream license: MIT; see elizaos_tau_bench/upstream/LICENSE.\n",
        encoding="utf-8",
    )
    return cache_dir


def load_domain_data(domain: Domain) -> dict[str, Any]:
    if _use_smoke_data():
        return _read_domain_data(domain, _package_domain_dir(domain))
    return _read_domain_data(domain, ensure_official_data(domain))


__all__ = ["ensure_official_data", "load_domain_data"]
