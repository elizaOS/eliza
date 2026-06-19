"""Tests for the LifeOpsBench privacy filter (Wave 3D).

Mirrors the redaction guarantees in
``plugins/app-training/src/core/privacy-filter.ts`` so any trajectory
ingested into the bench has credentials and geo coordinates stripped
before downstream evaluation observes them.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from eliza_lifeops_bench.ingest import (
    FilterStats,
    UnredactedCredentialError,
    apply_privacy_filter,
    load_trajectories_from_disk,
    redact_credentials,
    redact_geo,
)


# ---------------------------------------------------------------------------
# Credential redaction — one test per shape from DEFAULT_CREDENTIAL_PATTERNS.
# ---------------------------------------------------------------------------


def test_redact_credentials_openai_key() -> None:
    text = "use sk-AbCdEf0123456789xyz to call the API"
    out = redact_credentials(text)
    assert "sk-AbCdEf0123456789xyz" not in out
    assert "<REDACTED:openai-key>" in out


def test_redact_credentials_anthropic_key() -> None:
    """``sk-ant-*`` keys are stripped — though they are matched by the
    ``openai-key`` regex first because ``sk-`` runs earlier in the
    ordered pattern list. The TS source has the same ordering, so the
    redacted label is ``openai-key`` even for Anthropic keys. The
    important guarantee is that the secret material is gone.
    """
    text = "ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf0123456789xyz works"
    out = redact_credentials(text)
    assert "sk-ant-api03-AbCdEf0123456789xyz" not in out
    assert "<REDACTED:" in out


def test_redact_credentials_bearer_token() -> None:
    text = "Authorization: Bearer abcdef0123456789xyz extra"
    out = redact_credentials(text)
    assert "Bearer abcdef0123456789xyz" not in out
    assert "<REDACTED:bearer>" in out


def test_redact_credentials_github_token() -> None:
    text = "token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa for git push"
    out = redact_credentials(text)
    assert "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa" not in out
    assert "<REDACTED:github-token>" in out


def test_redact_credentials_aws_access_key() -> None:
    text = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE for boto"
    out = redact_credentials(text)
    assert "AKIAIOSFODNN7EXAMPLE" not in out
    assert "<REDACTED:aws-access-key>" in out


def test_redact_credentials_leaves_normal_text_alone() -> None:
    text = "the user said hello and asked for the weather"
    assert redact_credentials(text) == text


def test_redact_credentials_records_per_label_hits() -> None:
    """One distinct OpenAI-shape key + one bearer + one github token —
    three distinct labels, three increments to ``redaction_count``."""
    text = (
        "sk-AbCdEf0123456789xyz and "
        "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa and "
        "Bearer abcdef0123456789xyz"
    )
    stats = FilterStats()
    redact_credentials(text, stats=stats)
    assert stats.credential_hits["openai-key"] == 1
    assert stats.credential_hits["github-token"] == 1
    assert stats.credential_hits["bearer"] == 1
    assert stats.redaction_count == 3


# ---------------------------------------------------------------------------
# Geo redaction — bare pairs, labeled, JSON wrapper.
# ---------------------------------------------------------------------------


def test_redact_geo_bare_decimal_pair() -> None:
    text = "I'm at 37.7749, -122.4194 right now"
    out = redact_geo(text)
    assert "37.7749" not in out
    assert "[REDACTED_GEO]" in out


def test_redact_geo_labeled_lat_lng() -> None:
    text = "lat: 40.7128, lng: -74.0060 for the meeting"
    out = redact_geo(text)
    assert "40.7128" not in out
    assert "-74.0060" not in out
    assert "[REDACTED_GEO]" in out


def test_redact_geo_labeled_latitude_longitude() -> None:
    text = "latitude=51.5074, longitude=-0.1278"
    out = redact_geo(text)
    assert "51.5074" not in out
    assert "[REDACTED_GEO]" in out


def test_redact_geo_current_location_label() -> None:
    text = "current location: 35.6762, 139.6503 (Tokyo)"
    out = redact_geo(text)
    assert "35.6762" not in out
    assert "[REDACTED_GEO]" in out


def test_redact_geo_json_coords_block() -> None:
    text = '{"coords":{"latitude":48.8566,"longitude":2.3522,"accuracy":10}}'
    out = redact_geo(text)
    assert "48.8566" not in out
    assert "2.3522" not in out
    assert "[REDACTED_GEO]" in out


def test_redact_geo_json_bare_pair() -> None:
    text = '"latitude":34.0522,"longitude":-118.2437'
    out = redact_geo(text)
    assert "34.0522" not in out
    assert "[REDACTED_GEO]" in out


def test_redact_geo_does_not_match_integer_pairs() -> None:
    """Integer pairs (timestamps, IDs) must not be falsely redacted.

    The bare-pair regex requires both numbers to have a fractional
    component, mirroring the TS guarantee.
    """
    text = "row 1234, 5678 in the table"
    assert redact_geo(text) == text


def test_redact_geo_records_redaction_count() -> None:
    text = "first 12.345, 67.890 then 1.11, 2.22 then 33.33, 44.44"
    stats = FilterStats()
    redact_geo(text, stats=stats)
    assert stats.redaction_count == 3


# ---------------------------------------------------------------------------
# Recursive trajectory pass — dicts, lists, nested.
# ---------------------------------------------------------------------------


def test_apply_privacy_filter_recurses_into_nested_dicts() -> None:
    trajectory = {
        "trajectoryId": "traj-001",
        "metadata": {
            "auth": "Bearer abcdef0123456789xyz",
            "nested": {
                "deep": {
                    "secret": "sk-AbCdEf0123456789xyz",
                }
            },
        },
    }
    cleaned, stats = apply_privacy_filter(trajectory)
    assert "<REDACTED:bearer>" in cleaned["metadata"]["auth"]
    assert "<REDACTED:openai-key>" in cleaned["metadata"]["nested"]["deep"]["secret"]
    assert stats.redaction_count == 2


def test_apply_privacy_filter_handles_lists_of_strings() -> None:
    trajectory = {
        "steps": [
            {"text": "first sk-AbCdEf0123456789xyz"},
            {"text": "second 37.7749, -122.4194"},
            {"text": "third Bearer abcdef0123456789xyz"},
        ]
    }
    cleaned, stats = apply_privacy_filter(trajectory)
    assert "<REDACTED:openai-key>" in cleaned["steps"][0]["text"]
    assert "[REDACTED_GEO]" in cleaned["steps"][1]["text"]
    assert "<REDACTED:bearer>" in cleaned["steps"][2]["text"]
    assert stats.redaction_count == 3


def test_apply_privacy_filter_handles_lists_of_strings_directly() -> None:
    trajectory = {
        "tags": [
            "Bearer abcdef0123456789xyz",
            "AKIAIOSFODNN7EXAMPLE",
            "harmless tag",
        ]
    }
    cleaned, _stats = apply_privacy_filter(trajectory)
    assert "<REDACTED:bearer>" in cleaned["tags"][0]
    assert "<REDACTED:aws-access-key>" in cleaned["tags"][1]
    assert cleaned["tags"][2] == "harmless tag"


def test_apply_privacy_filter_does_not_mutate_input() -> None:
    original = {"text": "sk-AbCdEf0123456789xyz"}
    snapshot = json.dumps(original)
    apply_privacy_filter(original)
    assert json.dumps(original) == snapshot


def test_apply_privacy_filter_passes_through_non_string_scalars() -> None:
    trajectory = {
        "count": 42,
        "ratio": 0.5,
        "ok": True,
        "missing": None,
        "text": "Bearer abcdef0123456789xyz",
    }
    cleaned, _ = apply_privacy_filter(trajectory)
    assert cleaned["count"] == 42
    assert cleaned["ratio"] == 0.5
    assert cleaned["ok"] is True
    assert cleaned["missing"] is None
    assert "<REDACTED:bearer>" in cleaned["text"]


def test_filter_stats_count_matches() -> None:
    """Aggregate redaction_count equals the sum of credential + geo hits."""
    trajectory = {
        "a": "sk-AbCdEf0123456789xyz",
        "b": "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        "c": "current location: 51.5074, -0.1278",
        "d": ["AKIAIOSFODNN7EXAMPLE", "37.7749, -122.4194"],
    }
    _, stats = apply_privacy_filter(trajectory)
    # 3 credentials (openai, github, aws) + 2 geo hits = 5
    assert stats.redaction_count == 5
    assert stats.credential_hits["openai-key"] == 1
    assert stats.credential_hits["github-token"] == 1
    assert stats.credential_hits["aws-access-key"] == 1


# ---------------------------------------------------------------------------
# Disk loader — strict mode + redaction guarantee.
# ---------------------------------------------------------------------------


def test_load_trajectories_returns_redacted_payloads(tmp_path: Path) -> None:
    agent_dir = tmp_path / "agent_001"
    agent_dir.mkdir()
    (agent_dir / "traj_001.json").write_text(
        json.dumps(
            {
                "trajectoryId": "traj_001",
                "metadata": {"key": "sk-AbCdEf0123456789xyz"},
            }
        ),
        encoding="utf-8",
    )
    loaded = load_trajectories_from_disk(tmp_path)
    assert len(loaded) == 1
    assert "<REDACTED:openai-key>" in loaded[0]["metadata"]["key"]
    assert "sk-AbCdEf0123456789xyz" not in json.dumps(loaded[0])


def test_load_trajectories_strict_mode_raises_on_unredacted_credential(
    tmp_path: Path,
) -> None:
    agent_dir = tmp_path / "agent_001"
    agent_dir.mkdir()
    (agent_dir / "traj_dirty.json").write_text(
        json.dumps({"text": "Bearer abcdef0123456789xyz"}),
        encoding="utf-8",
    )
    with pytest.raises(UnredactedCredentialError) as exc_info:
        load_trajectories_from_disk(tmp_path, strict=True)
    assert "bearer" in str(exc_info.value)
    assert "traj_dirty.json" in str(exc_info.value)


def test_load_trajectories_skips_invalid_json(tmp_path: Path) -> None:
    (tmp_path / "ok.json").write_text(json.dumps({"text": "fine"}), encoding="utf-8")
    (tmp_path / "broken.json").write_text("{not valid json", encoding="utf-8")
    loaded = load_trajectories_from_disk(tmp_path)
    assert len(loaded) == 1
    assert loaded[0]["text"] == "fine"


def test_load_trajectories_returns_empty_for_missing_directory(
    tmp_path: Path,
) -> None:
    missing = tmp_path / "nope"
    assert load_trajectories_from_disk(missing) == []
