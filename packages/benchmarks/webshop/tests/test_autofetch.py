"""Unit tests for auto-download / auto-install behavior.

These tests do NOT touch the network. They exercise the seams in
``elizaos_webshop.dataset`` and ``elizaos_webshop.environment`` that decide
whether to invoke the fetch script / `python -m spacy download`, using
mocks for the external side effects (subprocess, spacy.load, gdown).

They are intentionally independent of the heavy upstream dependencies
(``upstream/web_agent_site``, ``torch``, ``thefuzz``, ...), so they run in a
freshly-cloned repo without requiring the WebShop data to be present.
"""

from __future__ import annotations

import types
from pathlib import Path
from unittest import mock

import pytest


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_spacy_singleton():
    """The spaCy loader caches in a module-level singleton; reset around each
    test so retry behavior can be exercised independently."""
    import elizaos_webshop.environment as env_mod

    env_mod._spacy_nlp_singleton = None
    env_mod._spacy_load_attempted = False
    yield
    env_mod._spacy_nlp_singleton = None
    env_mod._spacy_load_attempted = False


@pytest.fixture(autouse=True)
def _clear_optout_env(monkeypatch):
    monkeypatch.delenv("WEBSHOP_NO_AUTOFETCH", raising=False)
    yield


# ---------------------------------------------------------------------------
# spaCy auto-install
# ---------------------------------------------------------------------------


def test_spacy_autoinstall_retries_after_oserror():
    """First call OSErrors; we install; retry succeeds."""
    import elizaos_webshop.environment as env_mod

    fake_nlp = object()
    fake_spacy = types.SimpleNamespace()
    call_count = {"n": 0}

    def fake_load(model: str):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise OSError(f"[E050] Can't find model '{model}'.")
        return fake_nlp

    fake_spacy.load = fake_load

    runs: list[list[str]] = []

    def fake_run(cmd, check=False):
        runs.append(list(cmd))
        return types.SimpleNamespace(returncode=0)

    nlp = env_mod._ensure_spacy_model_available(
        model="en_core_web_sm",
        _spacy_module=fake_spacy,
        _subprocess_run=fake_run,
    )

    assert nlp is fake_nlp
    assert call_count["n"] == 2, "expected one failure and one retry"
    assert len(runs) == 1
    cmd = runs[0]
    assert cmd[1:] == ["-m", "spacy", "download", "en_core_web_sm"]


def test_spacy_autoinstall_caches_singleton():
    """A second call returns the cached object; no new subprocess call."""
    import elizaos_webshop.environment as env_mod

    fake_nlp = object()
    fake_spacy = types.SimpleNamespace(load=lambda m: fake_nlp)
    calls = {"runs": 0}

    def fake_run(cmd, check=False):
        calls["runs"] += 1
        return types.SimpleNamespace(returncode=0)

    nlp1 = env_mod._ensure_spacy_model_available(
        model="en_core_web_sm",
        _spacy_module=fake_spacy,
        _subprocess_run=fake_run,
    )
    nlp2 = env_mod._ensure_spacy_model_available(
        model="en_core_web_sm",
        _spacy_module=fake_spacy,
        _subprocess_run=fake_run,
    )

    assert nlp1 is nlp2 is fake_nlp
    assert calls["runs"] == 0, "model loaded first try; no install needed"


def test_spacy_autoinstall_disabled_by_env(monkeypatch):
    """With WEBSHOP_NO_AUTOFETCH=1 set, missing model raises a clear error."""
    import elizaos_webshop.environment as env_mod

    monkeypatch.setenv("WEBSHOP_NO_AUTOFETCH", "1")

    fake_spacy = types.SimpleNamespace(
        load=mock.MagicMock(side_effect=OSError("[E050] no model")),
    )
    runs: list[list[str]] = []

    def fake_run(cmd, check=False):
        runs.append(list(cmd))
        return types.SimpleNamespace(returncode=0)

    with pytest.raises(OSError) as ei:
        env_mod._ensure_spacy_model_available(
            model="en_core_web_sm",
            _spacy_module=fake_spacy,
            _subprocess_run=fake_run,
        )

    msg = str(ei.value)
    assert "WEBSHOP_NO_AUTOFETCH" in msg
    assert "python -m spacy download en_core_web_sm" in msg
    assert runs == [], "subprocess install should NOT run when opt-out is set"


def test_spacy_autoinstall_subprocess_failure_raises():
    """If `python -m spacy download` returns non-zero, we surface a clear error."""
    import elizaos_webshop.environment as env_mod

    fake_spacy = types.SimpleNamespace(
        load=mock.MagicMock(side_effect=OSError("[E050] no model")),
    )

    def fake_run(cmd, check=False):
        return types.SimpleNamespace(returncode=1)

    with pytest.raises(OSError) as ei:
        env_mod._ensure_spacy_model_available(
            model="en_core_web_sm",
            _spacy_module=fake_spacy,
            _subprocess_run=fake_run,
        )

    msg = str(ei.value)
    assert "spacy download" in msg
    assert "exit code 1" in msg


# ---------------------------------------------------------------------------
# Data auto-fetch
# ---------------------------------------------------------------------------


def test_ensure_profile_downloaded_noop_when_files_present(tmp_path: Path):
    """If all required files already exist, no fetch is triggered."""
    import elizaos_webshop.dataset as ds_mod

    for name in ("items_shuffle_1000.json", "items_ins_v2_1000.json", "items_human_ins.json"):
        (tmp_path / name).write_text('{"ok": true}', encoding="utf-8")

    with mock.patch.object(ds_mod, "_load_fetch_module") as load_mod_mock:
        ds_mod.ensure_profile_downloaded("small", tmp_path)
        load_mod_mock.assert_not_called()


def test_ensure_profile_downloaded_invokes_fetch(tmp_path: Path):
    """Missing files trigger ``download_profile`` from fetch_data.py."""
    import elizaos_webshop.dataset as ds_mod

    fake_module = types.SimpleNamespace()
    captured: list[tuple[str, Path]] = []

    def fake_download_profile(profile: str, dest: Path):
        captured.append((profile, dest))
        # Simulate the download
        for name in ("items_shuffle_1000.json", "items_ins_v2_1000.json", "items_human_ins.json"):
            (dest / name).write_text('{"ok": true}', encoding="utf-8")
        return [dest / name for name in (
            "items_shuffle_1000.json", "items_ins_v2_1000.json", "items_human_ins.json"
        )]

    fake_module.download_profile = fake_download_profile

    with mock.patch.object(ds_mod, "_load_fetch_module", return_value=fake_module):
        ds_mod.ensure_profile_downloaded("small", tmp_path)

    assert captured == [("small", tmp_path)]
    for name in ("items_shuffle_1000.json", "items_ins_v2_1000.json", "items_human_ins.json"):
        assert (tmp_path / name).exists()


def test_ensure_profile_downloaded_opt_out_raises(monkeypatch, tmp_path: Path):
    """With WEBSHOP_NO_AUTOFETCH=1 set, missing data raises mentioning the env var."""
    import elizaos_webshop.dataset as ds_mod

    monkeypatch.setenv("WEBSHOP_NO_AUTOFETCH", "1")

    with mock.patch.object(ds_mod, "_load_fetch_module") as load_mod_mock:
        with pytest.raises(FileNotFoundError) as ei:
            ds_mod.ensure_profile_downloaded("small", tmp_path)

        load_mod_mock.assert_not_called()

    msg = str(ei.value)
    assert "WEBSHOP_NO_AUTOFETCH" in msg
    assert "scripts/fetch_data.py" in msg
    assert "--profile small" in msg


def test_load_sync_with_optout_and_no_data_raises(monkeypatch, tmp_path: Path):
    """End-to-end at the WebShopDataset.load_sync boundary: opt-out + missing
    data must raise a FileNotFoundError that mentions the opt-out env var."""
    import elizaos_webshop.dataset as ds_mod

    monkeypatch.setenv("WEBSHOP_NO_AUTOFETCH", "1")

    ds = ds_mod.WebShopDataset(
        split="test",
        profile="small",
        use_sample_tasks=False,
        data_dir=tmp_path,  # empty dir -> data is missing
    )

    with pytest.raises(FileNotFoundError) as ei:
        ds.load_sync()

    assert "WEBSHOP_NO_AUTOFETCH" in str(ei.value)


def test_load_fetch_module_has_download_profile():
    """The fetch_data.py script exposes download_profile() as a callable."""
    import elizaos_webshop.dataset as ds_mod

    mod = ds_mod._load_fetch_module()
    assert hasattr(mod, "download_profile"), "fetch_data.py must expose download_profile"
    assert callable(mod.download_profile)
    # The CLI wrapper main() should still exist for the script entry point.
    assert callable(getattr(mod, "main"))


def test_load_fetch_module_use_sample_tasks_is_noop(monkeypatch, tmp_path: Path):
    """With ``use_sample_tasks=True``, the dataset must never call into
    fetch_data even if data dir is empty (sample needs no downloads)."""
    import elizaos_webshop.dataset as ds_mod

    # Set opt-out so a *real* fetch attempt would raise loudly.
    monkeypatch.setenv("WEBSHOP_NO_AUTOFETCH", "1")

    ds_mod.WebShopDataset(
        split="test",
        profile="small",
        use_sample_tasks=True,
        data_dir=tmp_path,
    )

    # We do NOT call load_sync() here because that pulls in upstream
    # (spaCy / torch / thefuzz) and we want to keep this test light.
    # Instead, assert the function we care about is bypassed in code: the
    # sample-task code path in load_sync() never touches ensure_profile_downloaded.
    import inspect

    src = inspect.getsource(ds_mod.WebShopDataset.load_sync)
    # The opt-out branch lives below the sample-tasks early-return.
    sample_idx = src.find("use_sample_tasks")
    autofetch_idx = src.find("ensure_profile_downloaded")
    assert sample_idx != -1 and autofetch_idx != -1
    assert sample_idx < autofetch_idx, (
        "use_sample_tasks branch must be evaluated *before* the auto-fetch hook"
    )
